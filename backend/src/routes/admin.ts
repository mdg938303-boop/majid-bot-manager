import { Router } from "express";
import { q, getSetting, setSetting } from "../db.js";
import type { Config } from "../config.js";
import { hashPassword, validatePasswordStrength } from "../lib/crypto.js";
import { ALL_PERMISSIONS, audit, requireAdmin, requireAuth, requirePermission } from "../middleware/auth.js";
import { Engine, HttpError } from "../services/engine.js";
import { EMAIL_RE, h, str, uuid } from "./util.js";

// Rough public-rate estimate; real billing is only visible in the Render dashboard.
const MEM_USD_PER_HR: Record<string, number> = { "1c-2g": 0.038, "2c-4g": 0.076, "4c-8g": 0.152, "8c-16g": 0.304 };
const CPU_USD_PER_ACTIVE_HR = 0.12;

export function adminRoutes(cfg: Config, engine: Engine) {
  const r = Router();
  r.use(requireAuth);

  const grantable = (v: unknown) => (Array.isArray(v) ? v.filter((p): p is string => typeof p === "string" && (ALL_PERMISSIONS as readonly string[]).includes(p)) : []);

  r.get("/users", requirePermission("users.view"), h(async (_req, res) => {
    const rows = await q(`SELECT u.id,u.email,u.display_name,u.role,u.status,u.bot_quota,u.last_login_at,u.created_at,
      COALESCE((SELECT array_agg(permission) FROM user_permissions WHERE user_id=u.id),'{}') AS permissions,
      (SELECT count(*)::int FROM bots WHERE owner_id=u.id) AS bots FROM users u ORDER BY u.created_at DESC LIMIT 500`);
    res.json({ users: rows.rows });
  }));

  r.post("/users", requirePermission("users.manage"), h(async (req, res) => {
    const email = str(req.body?.email, "Email", { re: EMAIL_RE, max: 320 }).toLowerCase();
    const role = str(req.body?.role ?? "user", "Role", { max: 10 });
    if (!["user", "subadmin", "admin"].includes(role)) throw new HttpError(400, "Invalid role.");
    if (role !== "user" && !req.user!.permissions.has("subadmins.manage")) throw new HttpError(403, "Only admins (or holders of subadmins.manage) can create staff accounts.");
    if (role === "admin" && req.user!.role !== "admin") throw new HttpError(403, "Only an admin can create another admin.");
    const pw = str(req.body?.password, "Password", { max: 200 }); const weak = validatePasswordStrength(pw); if (weak) throw new HttpError(400, weak);
    if ((await q("SELECT 1 FROM users WHERE email=$1", [email])).rowCount) throw new HttpError(409, "Email already exists.");
    const quota = Number.isInteger(req.body?.botQuota) ? Math.max(0, Math.min(50, req.body.botQuota)) : await getSetting<number>("default_bot_quota", 1);
    const u = await q("INSERT INTO users(email,password_hash,role,bot_quota,display_name) VALUES ($1,$2,$3,$4,$5) RETURNING id", [email, await hashPassword(pw), role, quota, str(req.body?.displayName, "Name", { optional: true, max: 80 })]);
    if (role === "subadmin") for (const p of grantable(req.body?.permissions)) await q("INSERT INTO user_permissions(user_id,permission) VALUES ($1,$2)", [u.rows[0].id, p]);
    await audit(req, "user.create", { type: "user", id: u.rows[0].id }, { role }); res.status(201).json({ id: u.rows[0].id });
  }));

  r.patch("/users/:id", h(async (req, res) => {
    const id = uuid(req.params.id); const me = req.user!;
    const target = (await q("SELECT id,role FROM users WHERE id=$1", [id])).rows[0]; if (!target) throw new HttpError(404, "User not found.");
    const b = req.body ?? {};
    if (target.role === "admin" && me.role !== "admin") throw new HttpError(403, "Only an admin can modify an admin.");
    if (b.status !== undefined) {
      if (!me.permissions.has("users.suspend")) throw new HttpError(403, "Missing permission users.suspend.");
      if (id === me.id) throw new HttpError(400, "You cannot suspend yourself.");
      if (!["active", "suspended"].includes(b.status)) throw new HttpError(400, "Invalid status.");
      await q("UPDATE users SET status=$2, updated_at=now() WHERE id=$1", [id, b.status]);
      if (b.status === "suspended") await q("DELETE FROM sessions WHERE user_id=$1", [id]);
    }
    if (b.botQuota !== undefined) {
      if (!me.permissions.has("users.manage")) throw new HttpError(403, "Missing permission users.manage.");
      if (!Number.isInteger(b.botQuota) || b.botQuota < 0 || b.botQuota > 50) throw new HttpError(400, "Quota must be 0–50.");
      await q("UPDATE users SET bot_quota=$2, updated_at=now() WHERE id=$1", [id, b.botQuota]);
    }
    if (b.permissions !== undefined || b.role !== undefined) {
      if (!me.permissions.has("subadmins.manage")) throw new HttpError(403, "Missing permission subadmins.manage.");
      if (b.role !== undefined) {
        if (!["user", "subadmin", "admin"].includes(b.role)) throw new HttpError(400, "Invalid role.");
        if ((b.role === "admin" || target.role === "admin") && me.role !== "admin") throw new HttpError(403, "Only an admin can change admin roles.");
        if (id === me.id && b.role !== "admin") throw new HttpError(400, "You cannot demote yourself.");
        await q("UPDATE users SET role=$2, updated_at=now() WHERE id=$1", [id, b.role]);
      }
      if (b.permissions !== undefined) {
        await q("DELETE FROM user_permissions WHERE user_id=$1", [id]);
        for (const p of grantable(b.permissions)) await q("INSERT INTO user_permissions(user_id,permission) VALUES ($1,$2)", [id, p]);
      }
    }
    await audit(req, "user.update", { type: "user", id }, Object.fromEntries(Object.keys(b).map((k) => [k, k === "password" ? "[redacted]" : b[k]])));
    res.json({ ok: true });
  }));

  r.get("/audit", requirePermission("audit.view"), h(async (req, res) => {
    const rows = await q("SELECT id,actor_email,action,target_type,target_id,detail,ip,ts FROM audit_logs ORDER BY id DESC LIMIT $1", [Math.min(500, Number(req.query.limit ?? 100) || 100)]);
    res.json({ audit: rows.rows });
  }));

  r.get("/settings", requirePermission("settings.manage"), h(async (_req, res) => {
    const rows = await q("SELECT key,value FROM system_settings ORDER BY key");
    res.json({ settings: Object.fromEntries(rows.rows.map((x) => [x.key, x.value])) });
  }));
  r.put("/settings", requirePermission("settings.manage"), h(async (req, res) => {
    const schema: Record<string, (v: any) => boolean> = {
      registration_open: (v) => typeof v === "boolean",
      max_concurrent_sandboxes: (v) => Number.isInteger(v) && v >= 0 && v <= 20,
      default_bot_quota: (v) => Number.isInteger(v) && v >= 0 && v <= 20,
      allowed_plans: (v) => Array.isArray(v) && v.every((p) => ["1c-2g", "2c-4g", "4c-8g", "8c-16g"].includes(p)),
      max_run_hours: (v) => Number.isInteger(v) && v >= 0 && v <= 720,
      auto_release_minutes: (v) => Number.isInteger(v) && v >= 0 && v <= 10080,
      budget_warning_usd: (v) => typeof v === "number" && v >= 0 && v <= 100000,
    };
    const key = str(req.body?.key, "Key", { max: 50 });
    if (!schema[key]?.(req.body?.value)) throw new HttpError(400, "Invalid setting or value.");
    await setSetting(key, req.body.value);
    if (key === "max_concurrent_sandboxes" && cfg.sandboxGroupId && engine.runtime.setGroupConcurrency) await engine.runtime.setGroupConcurrency(cfg.sandboxGroupId, Math.max(1, req.body.value)).catch(() => undefined);
    await audit(req, "settings.update", { type: "setting", id: key }, { value: req.body.value }); res.json({ ok: true });
  }));

  r.post("/killswitch", requirePermission("killswitch.use"), h(async (req, res) => {
    const n = await engine.killAll(); await audit(req, "killswitch.on", undefined, { terminated: n });
    res.json({ terminated: n, killSwitch: true });
  }));
  r.post("/killswitch/reset", requirePermission("killswitch.use"), h(async (req, res) => {
    await setSetting("kill_switch", false); await audit(req, "killswitch.off"); res.json({ killSwitch: false });
  }));

  r.get("/overview", requirePermission("settings.manage"), h(async (_req, res) => {
    const runtime = await engine.runtime.available();
    const counts = (await q(`SELECT (SELECT count(*)::int FROM users) users, (SELECT count(*)::int FROM bots) bots,
      (SELECT count(*)::int FROM bots WHERE sandbox_id IS NOT NULL) sandboxes, (SELECT count(*)::int FROM bots WHERE status='running') running`)).rows[0];
    // Estimate from our own records. NOT real billing and NOT remaining credit.
    const inst = await q("SELECT plan, sum(extract(epoch FROM (COALESCE(terminated_at, now()) - created_at)))/3600 AS hours FROM sandbox_instances WHERE created_at > date_trunc('month', now()) GROUP BY plan");
    let est = 0; for (const x of inst.rows) est += Number(x.hours) * ((MEM_USD_PER_HR[x.plan] ?? 0.038) + 0.1 * CPU_USD_PER_ACTIVE_HR * Number(String(x.plan).split("c")[0]));
    const warn = await getSetting<number>("budget_warning_usd", 40);
    res.json({ runtime, counts, killSwitch: await getSetting("kill_switch", false),
      costEstimate: { monthToDateUsd: Math.round(est * 100) / 100, warnAtUsd: warn, overWarning: est >= warn,
        disclaimer: "Estimate from sandbox uptime in this platform's records, assuming ~10% active CPU and rates seen on Render's pricing page. It is NOT your Render bill and does not show remaining credit — check Dashboard → Billing." } });
  }));
  return r;
}
