import { Router } from "express";
import { q } from "../db.js";
import { audit, loadBotFor, requireAuth } from "../middleware/auth.js";
import { h } from "./util.js";

const STREAMS = ["system", "build", "stdout", "stderr"];

export function logRoutes(pollSeconds: number) {
  const r = Router({ mergeParams: true });
  r.use(requireAuth);

  r.get("/", h(async (req, res) => {
    const bot = await loadBotFor(req, res, false); if (!bot) return;
    const after = Math.max(0, Number(req.query.after ?? 0) || 0);
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit ?? 300) || 300));
    const streams = String(req.query.streams ?? "").split(",").filter((s) => STREAMS.includes(s));
    const search = typeof req.query.q === "string" ? req.query.q.slice(0, 100) : "";
    const dep = typeof req.query.deployment === "string" && /^[0-9a-f-]{36}$/i.test(req.query.deployment) ? req.query.deployment : null;
    const rows = await q(`SELECT * FROM (SELECT id,stream,text,ts,deployment_id FROM logs WHERE bot_id=$1 AND id>$2
        AND (cardinality($3::text[])=0 OR stream=ANY($3)) AND ($4='' OR position(lower($4) in lower(text))>0) AND ($5::uuid IS NULL OR deployment_id=$5)
        ORDER BY id ${after ? "ASC" : "DESC"} LIMIT $6) t ORDER BY id ASC`, [bot.id, after, streams, search, dep, limit]);
    res.json({ logs: rows.rows, pollSeconds, note: `Runtime output is fetched from the sandbox about every ${pollSeconds}s (near-live, not a raw stream).` });
  }));

  // Server-Sent Events: pushes new persisted rows as the collector stores them.
  r.get("/stream", h(async (req, res) => {
    const bot = await loadBotFor(req, res, false); if (!bot) return;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    let last = Math.max(0, Number(req.query.after ?? 0) || 0);
    const tick = async () => {
      const rows = await q("SELECT id,stream,text,ts FROM logs WHERE bot_id=$1 AND id>$2 ORDER BY id LIMIT 500", [bot.id, last]);
      for (const row of rows.rows) { last = Number(row.id); res.write(`id: ${row.id}\ndata: ${JSON.stringify(row)}\n\n`); }
      if (!rows.rowCount) res.write(": keepalive\n\n");
    };
    const t = setInterval(() => void tick().catch(() => undefined), 1500);
    req.on("close", () => clearInterval(t));
    await tick();
  }));

  r.delete("/", h(async (req, res) => {
    const bot = await loadBotFor(req, res); if (!bot) return;
    await q("DELETE FROM logs WHERE bot_id=$1", [bot.id]);
    await audit(req, "logs.clear", { type: "bot", id: bot.id }); res.json({ ok: true });
  }));
  return r;
}

export function deploymentRoutes() {
  const r = Router();
  r.use(requireAuth);
  r.get("/", h(async (req, res) => {
    const all = req.query.all === "1" && (req.user!.role === "admin" || req.user!.permissions.has("deployments.view_all"));
    const rows = await q(`SELECT d.id,d.bot_id,b.name AS bot_name,d.kind,d.status,d.stage,d.error,d.queued_at,d.started_at,d.finished_at,d.sandbox_id
      FROM deployments d JOIN bots b ON b.id=d.bot_id WHERE ($1 OR d.owner_id=$2) ORDER BY d.queued_at DESC LIMIT 200`, [all, req.user!.id]);
    res.json({ deployments: rows.rows });
  }));
  return r;
}
