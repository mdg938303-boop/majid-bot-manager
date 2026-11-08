import type { NextFunction, Request, Response } from "express";
import { q } from "../db.js";
import { randomToken, sha256 } from "../lib/crypto.js";

export const ALL_PERMISSIONS = ["users.view","users.manage","users.suspend","bots.view_all","bots.manage_all","deployments.view_all","settings.manage","audit.view","killswitch.use","subadmins.manage"] as const;
export type Permission = (typeof ALL_PERMISSIONS)[number];

export interface AuthUser { id: string; email: string; role: "admin" | "subadmin" | "user"; permissions: Set<string>; botQuota: number; displayName: string }
declare module "express-serve-static-core" { interface Request { user?: AuthUser; csrf?: string; sessionHash?: string } }

export const COOKIE = "mbm_session";

export async function createSession(userId: string, days: number, ip?: string, ua?: string) {
  const token = randomToken(32), csrf = randomToken(24);
  await q("INSERT INTO sessions(token_hash,user_id,csrf_token,ip,user_agent,expires_at) VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' days')::interval)", [sha256(token), userId, csrf, ip ?? null, (ua ?? "").slice(0, 200), String(days)]);
  return { token, csrf };
}

export async function loadUser(req: Request, _res: Response, next: NextFunction) {
  const token = req.cookies?.[COOKIE];
  if (!token) return next();
  try {
    const h = sha256(token);
    const r = await q(`SELECT u.id,u.email,u.role,u.status,u.bot_quota,u.display_name,s.csrf_token,
        COALESCE((SELECT array_agg(permission) FROM user_permissions WHERE user_id=u.id),'{}') AS perms
      FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()`, [h]);
    const row = r.rows[0];
    if (row && row.status === "active") {
      req.user = { id: row.id, email: row.email, role: row.role, permissions: new Set(row.role === "admin" ? ALL_PERMISSIONS : row.perms), botQuota: row.bot_quota, displayName: row.display_name };
      req.csrf = row.csrf_token; req.sessionHash = h;
    }
  } catch (e) { return next(e); }
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: "Please sign in." });
  next();
}
/** Backend enforcement: role + explicit permission. Admin always passes. */
export const requirePermission = (...perms: Permission[]) => (req: Request, res: Response, next: NextFunction) => {
  const u = req.user;
  if (!u) return res.status(401).json({ error: "Please sign in." });
  if (u.role === "admin" || perms.every((p) => u.permissions.has(p))) return next();
  res.status(403).json({ error: "You do not have permission to do this." });
};
export const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  if (req.user?.role !== "admin") return res.status(req.user ? 403 : 401).json({ error: "Admin only." });
  next();
};

/** CSRF: SameSite cookie + Origin check + per-session token header on every state-changing request. */
export function csrfGuard(req: Request, res: Response, next: NextFunction) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (origin) { try { if (new URL(origin).host !== req.headers.host) return res.status(403).json({ error: "Bad origin." }); } catch { return res.status(403).json({ error: "Bad origin." }); } }
  if (req.path === "/api/auth/login" || req.path === "/api/auth/register") return next();
  if (!req.user) return next(); // requireAuth will reject
  if (req.headers["x-csrf-token"] !== req.csrf) return res.status(403).json({ error: "Invalid CSRF token. Reload the page." });
  next();
}

export async function audit(req: Request | null, action: string, target?: { type: string; id: string }, detail: object = {}, actor?: { id: string; email: string }) {
  const a = actor ?? (req?.user ? { id: req.user.id, email: req.user.email } : undefined);
  await q("INSERT INTO audit_logs(actor_id,actor_email,action,target_type,target_id,detail,ip) VALUES ($1,$2,$3,$4,$5,$6,$7)", [a?.id ?? null, a?.email ?? null, action, target?.type ?? null, target?.id ?? null, JSON.stringify(detail), req?.ip ?? null]).catch((e) => console.error("audit failed", e));
}

/** Ownership check shared by every bot route. Returns the bot row or sends 404/403. */
export async function loadBotFor(req: Request, res: Response, manage = true) {
  const id = String(req.params.id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) { res.status(404).json({ error: "Bot not found." }); return null; }
  const r = await q("SELECT * FROM bots WHERE id=$1", [id]);
  const bot = r.rows[0], u = req.user!;
  if (!bot) { res.status(404).json({ error: "Bot not found." }); return null; }
  const owns = bot.owner_id === u.id;
  const priv = u.role === "admin" || u.permissions.has(manage ? "bots.manage_all" : "bots.view_all") || (!manage && u.permissions.has("bots.manage_all"));
  if (!owns && !priv) { res.status(404).json({ error: "Bot not found." }); return null; } // 404: don't reveal existence
  return bot;
}
