import { Router } from "express";
import rateLimit from "express-rate-limit";
import { q, getSetting } from "../db.js";
import { hashPassword, validatePasswordStrength, verifyPassword } from "../lib/crypto.js";
import { audit, COOKIE, createSession, requireAuth } from "../middleware/auth.js";
import type { Config } from "../config.js";
import { EMAIL_RE, h, str } from "./util.js";
import { HttpError } from "../services/engine.js";

const DUMMY_HASH = "scrypt$65536$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export function authRoutes(cfg: Config) {
  const r = Router();
  const limiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { error: "Too many attempts. Try again later." } });
  const setCookie = (res: any, token: string) => res.cookie(COOKIE, token, { httpOnly: true, secure: cfg.isProd, sameSite: "lax", maxAge: cfg.sessionDays * 86_400_000, path: "/" });
  const publicUser = (u: any) => ({ id: u.id, email: u.email, role: u.role, displayName: u.displayName ?? u.display_name, permissions: [...(u.permissions ?? [])], botQuota: u.botQuota ?? u.bot_quota });

  r.post("/register", limiter, h(async (req, res) => {
    if (!(await getSetting("registration_open", true))) throw new HttpError(403, "Registration is closed.");
    const email = str(req.body?.email, "Email", { max: 320, re: EMAIL_RE }).toLowerCase();
    const password = str(req.body?.password, "Password", { min: 1, max: 200 });
    const weak = validatePasswordStrength(password); if (weak) throw new HttpError(400, weak);
    const quota = await getSetting<number>("default_bot_quota", 1);
    const exists = await q("SELECT 1 FROM users WHERE email=$1", [email]);
    if (exists.rowCount) throw new HttpError(409, "An account with this email already exists.");
    const u = await q("INSERT INTO users(email,password_hash,display_name,bot_quota) VALUES ($1,$2,$3,$4) RETURNING id,email,role,bot_quota,display_name", [email, await hashPassword(password), str(req.body?.displayName, "Name", { optional: true, max: 80 }), quota]);
    await audit(req, "user.register", { type: "user", id: u.rows[0].id }, {}, { id: u.rows[0].id, email });
    const s = await createSession(u.rows[0].id, cfg.sessionDays, req.ip, req.headers["user-agent"]);
    setCookie(res, s.token);
    res.status(201).json({ user: publicUser({ ...u.rows[0], permissions: [] }), csrf: s.csrf });
  }));

  r.post("/login", limiter, h(async (req, res) => {
    const email = str(req.body?.email, "Email", { max: 320 }).toLowerCase();
    const password = str(req.body?.password, "Password", { max: 200 });
    const row = (await q("SELECT * FROM users WHERE email=$1", [email])).rows[0];
    const ok = await verifyPassword(password, row?.password_hash ?? DUMMY_HASH); // constant-ish time for unknown users
    if (row?.locked_until && new Date(row.locked_until) > new Date()) throw new HttpError(429, "Account temporarily locked. Try again later.");
    if (!row || !ok) {
      if (row) await q("UPDATE users SET failed_logins=failed_logins+1, locked_until=CASE WHEN failed_logins+1>=8 THEN now()+interval '15 minutes' ELSE locked_until END WHERE id=$1", [row.id]);
      await audit(req, "auth.login_failed", undefined, { email }, undefined);
      throw new HttpError(401, "Invalid email or password.");
    }
    if (row.status !== "active") throw new HttpError(403, "This account is suspended.");
    await q("UPDATE users SET failed_logins=0, locked_until=NULL, last_login_at=now() WHERE id=$1", [row.id]);
    const perms = (await q("SELECT permission FROM user_permissions WHERE user_id=$1", [row.id])).rows.map((x) => x.permission);
    const s = await createSession(row.id, cfg.sessionDays, req.ip, req.headers["user-agent"]);
    setCookie(res, s.token);
    await audit(req, "auth.login", { type: "user", id: row.id }, {}, { id: row.id, email });
    res.json({ user: publicUser({ ...row, permissions: perms }), csrf: s.csrf });
  }));

  r.post("/logout", h(async (req, res) => {
    if (req.sessionHash) await q("DELETE FROM sessions WHERE token_hash=$1", [req.sessionHash]);
    res.clearCookie(COOKIE, { path: "/" }); res.json({ ok: true });
  }));

  r.get("/me", h(async (req, res) => {
    if (!req.user) return res.json({ user: null });
    res.json({ user: publicUser(req.user), csrf: req.csrf });
  }));

  r.post("/change-password", requireAuth, h(async (req, res) => {
    const cur = str(req.body?.currentPassword, "Current password", { max: 200 });
    const next = str(req.body?.newPassword, "New password", { max: 200 });
    const weak = validatePasswordStrength(next); if (weak) throw new HttpError(400, weak);
    const row = (await q("SELECT password_hash FROM users WHERE id=$1", [req.user!.id])).rows[0];
    if (!(await verifyPassword(cur, row.password_hash))) throw new HttpError(403, "Current password is incorrect.");
    await q("UPDATE users SET password_hash=$2, updated_at=now() WHERE id=$1", [req.user!.id, await hashPassword(next)]);
    await q("DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2", [req.user!.id, req.sessionHash]);
    await audit(req, "auth.password_changed", { type: "user", id: req.user!.id });
    res.json({ ok: true });
  }));
  return r;
}
