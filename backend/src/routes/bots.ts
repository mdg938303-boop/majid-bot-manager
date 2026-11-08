import express, { Router } from "express";
import { q, getSetting } from "../db.js";
import type { Config } from "../config.js";
import { decrypt, encrypt, maskSecret } from "../lib/crypto.js";
import { verifyBotToken } from "../lib/telegram.js";
import { inspectAndExtractZip } from "../lib/zipInspect.js";
import { detectProject } from "../lib/detect.js";
import { audit, loadBotFor, requireAuth } from "../middleware/auth.js";
import { Engine, HttpError } from "../services/engine.js";
import { RESERVED_ENV } from "../services/deployer.js";
import { h, str } from "./util.js";

const publicBot = (b: any) => ({
  id: b.id, name: b.name, ownerId: b.owner_id, ownerEmail: b.owner_email, telegramUsername: b.telegram_username, language: b.language, entryPoint: b.entry_point,
  plan: b.plan, status: b.status, sandboxId: b.sandbox_id, egressDomains: b.egress_domains, warnings: b.manifest?.warnings ?? [],
  lastDeployedAt: b.last_deployed_at, createdAt: b.created_at, fileCount: b.file_count ?? 0,
});

export function botRoutes(cfg: Config, engine: Engine) {
  const r = Router();
  r.use(requireAuth);

  r.get("/", h(async (req, res) => {
    const all = req.query.all === "1" && (req.user!.role === "admin" || req.user!.permissions.has("bots.view_all"));
    const rows = await q(`SELECT b.*, u.email AS owner_email, p.file_count FROM bots b JOIN users u ON u.id=b.owner_id LEFT JOIN projects p ON p.bot_id=b.id
      WHERE ($1 OR b.owner_id=$2) ORDER BY b.created_at DESC LIMIT 500`, [all, req.user!.id]);
    res.json({ bots: rows.rows.map(publicBot) });
  }));

  r.post("/", h(async (req, res) => {
    const name = str(req.body?.name, "Bot name", { max: 60 });
    const token = str(req.body?.token, "Bot token", { max: 100 });
    if (await getSetting("kill_switch", false)) throw new HttpError(423, "The admin kill switch is active.");
    const count = (await q("SELECT count(*)::int n FROM bots WHERE owner_id=$1", [req.user!.id])).rows[0].n;
    if (req.user!.role !== "admin" && count >= req.user!.botQuota) throw new HttpError(403, `Bot quota reached (${req.user!.botQuota}). Ask an admin to raise it.`);
    let info; try { info = await verifyBotToken(token); } catch (e: any) { throw new HttpError(422, e.message); }
    const dupe = await q("SELECT 1 FROM bots WHERE telegram_id=$1", [info.id]);
    if (dupe.rowCount) throw new HttpError(409, "This Telegram bot is already registered on the platform.");
    const b = await q("INSERT INTO bots(owner_id,name,token_enc,telegram_id,telegram_username) VALUES ($1,$2,$3,$4,$5) RETURNING *", [req.user!.id, name, encrypt(token, cfg.encryptionKey), info.id, info.username]);
    await q("INSERT INTO projects(bot_id) VALUES ($1)", [b.rows[0].id]);
    await audit(req, "bot.create", { type: "bot", id: b.rows[0].id }, { username: info.username });
    res.status(201).json({ bot: publicBot(b.rows[0]), tokenPreview: maskSecret(token) });
  }));

  r.get("/:id", h(async (req, res) => {
    const bot = await loadBotFor(req, res, false); if (!bot) return;
    const p = await q("SELECT archive_name,file_count,total_bytes FROM projects WHERE bot_id=$1", [bot.id]);
    const d = await q("SELECT id,kind,status,stage,error,queued_at,finished_at FROM deployments WHERE bot_id=$1 ORDER BY queued_at DESC LIMIT 1", [bot.id]);
    res.json({ bot: { ...publicBot({ ...bot, file_count: p.rows[0]?.file_count }), manifest: bot.manifest }, project: p.rows[0], latestDeployment: d.rows[0] ?? null });
  }));

  r.patch("/:id", h(async (req, res) => {
    const bot = await loadBotFor(req, res); if (!bot) return;
    if (req.body?.name !== undefined) await q("UPDATE bots SET name=$2, updated_at=now() WHERE id=$1", [bot.id, str(req.body.name, "Name", { max: 60 })]);
    if (req.body?.entryPoint !== undefined) await q("UPDATE bots SET entry_point_override=$2 WHERE id=$1", [bot.id, str(req.body.entryPoint, "Entry point", { optional: true, max: 200, re: /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/ }) || null]);
    if (req.body?.plan !== undefined) {
      const plan = str(req.body.plan, "Plan", { max: 20 });
      if (!(await getSetting<string[]>("allowed_plans", ["1c-2g"])).includes(plan)) throw new HttpError(400, "That plan is not allowed by the admin.");
      await q("UPDATE bots SET plan=$2 WHERE id=$1", [bot.id, plan]);
    }
    if (req.body?.egressDomains !== undefined) {
      const arr = Array.isArray(req.body.egressDomains) ? req.body.egressDomains : [];
      if (arr.length > 20 || !arr.every((d: unknown) => typeof d === "string" && /^(\*\.)?[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(d))) throw new HttpError(400, "Up to 20 valid lowercase domains (e.g. api.example.com or *.example.com).");
      await q("UPDATE bots SET egress_domains=$2 WHERE id=$1", [bot.id, arr]);
    }
    await audit(req, "bot.update", { type: "bot", id: bot.id }, Object.keys(req.body ?? {}).reduce((o: any, k) => (o[k] = true, o), {}));
    res.json({ ok: true });
  }));

  r.delete("/:id", h(async (req, res) => {
    const bot = await loadBotFor(req, res); if (!bot) return;
    await engine.deleteBot(bot); await audit(req, "bot.delete", { type: "bot", id: bot.id }, { name: bot.name });
    res.json({ ok: true });
  }));

  // ---- project upload: validate + persist files in Postgres (sandboxes are ephemeral) ----
  r.post("/:id/upload", express.raw({ type: () => true, limit: `${cfg.maxUploadMb}mb` }), h(async (req, res) => {
    const bot = await loadBotFor(req, res); if (!bot) return;
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, "Send the ZIP file as the request body.");
    const proj = inspectAndExtractZip(req.body, { maxZipBytes: cfg.maxUploadMb * 1048576, maxEntries: 5000, maxTotalBytes: 100 * 1048576, maxFileBytes: 20 * 1048576, maxRatio: 200 });
    const manifest = detectProject(proj.files, bot.entry_point_override ? { entryPoint: bot.entry_point_override } : undefined);
    const p = (await q("SELECT id FROM projects WHERE bot_id=$1", [bot.id])).rows[0];
    const name = String(req.query.name ?? "project.zip").slice(0, 120).replace(/[^\w.\- ]/g, "_");
    const client = await (await import("../db.js")).pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM project_files WHERE project_id=$1", [p.id]);
      let total = 0;
      for (const [path, content] of proj.files) {
        total += content.length;
        await client.query("INSERT INTO project_files(project_id,path,content,size) VALUES ($1,$2,$3,$4)", [p.id, path, content, content.length]);
      }
      await client.query("UPDATE projects SET archive_name=$2,file_count=$3,total_bytes=$4,updated_at=now() WHERE id=$1", [p.id, name, proj.files.size, total]);
      await client.query("UPDATE bots SET language=$2, entry_point=$3, manifest=$4, updated_at=now() WHERE id=$1", [bot.id, manifest.language, manifest.entryPoint, JSON.stringify(manifest)]);
      await client.query("COMMIT");
    } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
    await audit(req, "bot.upload", { type: "bot", id: bot.id }, { files: proj.files.size, language: manifest.language });
    let deploymentId: string | null = null;
    if (req.query.deploy === "1") deploymentId = await engine.enqueue(bot, "deploy", bot.owner_id);
    res.json({ manifest, warnings: [...proj.warnings, ...manifest.warnings], fileCount: proj.files.size, deploymentId });
  }));

  // ---- controls: every one calls the real runtime ----
  const ctl = (kind: "deploy" | "rebuild" | "redeploy") => h(async (req, res) => {
    const bot = await loadBotFor(req, res); if (!bot) return;
    const id = await engine.enqueue(bot, kind, bot.owner_id);
    await audit(req, `bot.${kind}`, { type: "bot", id: bot.id }); res.status(202).json({ deploymentId: id });
  });
  r.post("/:id/deploy", ctl("deploy")); r.post("/:id/rebuild", ctl("rebuild")); r.post("/:id/redeploy", ctl("redeploy"));
  r.post("/:id/start", h(async (req, res) => { const bot = await loadBotFor(req, res); if (!bot) return; const out = await engine.start(bot); await audit(req, "bot.start", { type: "bot", id: bot.id }); res.json(out); }));
  r.post("/:id/stop", h(async (req, res) => { const bot = await loadBotFor(req, res); if (!bot) return; await engine.stopBot(bot); await audit(req, "bot.stop", { type: "bot", id: bot.id }); res.json({ status: "stopped" }); }));
  r.post("/:id/restart", h(async (req, res) => { const bot = await loadBotFor(req, res); if (!bot) return; const out = await engine.restart(bot); await audit(req, "bot.restart", { type: "bot", id: bot.id }); res.json(out); }));
  r.post("/:id/release", h(async (req, res) => { const bot = await loadBotFor(req, res); if (!bot) return; await engine.release(bot, "Released by user."); await audit(req, "bot.release", { type: "bot", id: bot.id }); res.json({ status: "released" }); }));

  // Live process state straight from the sandbox (not from the DB).
  r.get("/:id/process", h(async (req, res) => {
    const bot = await loadBotFor(req, res, false); if (!bot) return;
    if (!bot.sandbox_id) return res.json({ dbStatus: bot.status, sandbox: null, process: null });
    const { processState } = await import("../services/deployer.js");
    const sandbox = await engine.runtime.status(bot.sandbox_id);
    const proc = sandbox === "running" ? await processState(engine.runtime, bot.sandbox_id).catch(() => "unknown") : null;
    res.json({ dbStatus: bot.status, sandbox, process: proc });
  }));

  // ---- environment variables (values never returned) ----
  r.get("/:id/env", h(async (req, res) => {
    const bot = await loadBotFor(req, res, false); if (!bot) return;
    const rows = await q("SELECT key, value_enc, updated_at FROM environment_variables WHERE bot_id=$1 ORDER BY key", [bot.id]);
    res.json({ variables: rows.rows.map((x) => ({ key: x.key, preview: maskSecret(decrypt(x.value_enc, cfg.encryptionKey)), updatedAt: x.updated_at })), note: "Restart the bot to apply changes." });
  }));
  r.put("/:id/env", h(async (req, res) => {
    const bot = await loadBotFor(req, res); if (!bot) return;
    const key = str(req.body?.key, "Name", { max: 100, re: /^[A-Za-z_][A-Za-z0-9_]*$/ });
    if (RESERVED_ENV.has(key.toUpperCase()) || /^(BOT_TOKEN|TELEGRAM_BOT_TOKEN|TELEGRAM_TOKEN|RENDER_|DATABASE_)/i.test(key)) throw new HttpError(400, "This variable name is reserved.");
    const value = typeof req.body?.value === "string" ? req.body.value : ""; if (value.length > 8000) throw new HttpError(400, "Value too long.");
    const n = (await q("SELECT count(*)::int n FROM environment_variables WHERE bot_id=$1 AND key<>$2", [bot.id, key])).rows[0].n;
    if (n >= 50) throw new HttpError(400, "Maximum 50 variables per bot.");
    await q("INSERT INTO environment_variables(bot_id,key,value_enc) VALUES ($1,$2,$3) ON CONFLICT (bot_id,key) DO UPDATE SET value_enc=$3, updated_at=now()", [bot.id, key, encrypt(value, cfg.encryptionKey)]);
    await audit(req, "bot.env_set", { type: "bot", id: bot.id }, { key });
    res.json({ ok: true });
  }));
  r.delete("/:id/env/:key", h(async (req, res) => {
    const bot = await loadBotFor(req, res); if (!bot) return;
    await q("DELETE FROM environment_variables WHERE bot_id=$1 AND key=$2", [bot.id, String(req.params.key)]);
    await audit(req, "bot.env_delete", { type: "bot", id: bot.id }, { key: req.params.key }); res.json({ ok: true });
  }));
  return r;
}
