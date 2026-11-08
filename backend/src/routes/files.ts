import express, { Router } from "express";
import { q } from "../db.js";
import { buildTarGz } from "../lib/tar.js";
import { basename, safeRelPath } from "../lib/paths.js";
import { audit, loadBotFor, requireAuth } from "../middleware/auth.js";
import { HttpError } from "../services/engine.js";
import { h } from "./util.js";

const MAX_TEXT = 2 * 1024 * 1024, MAX_UPLOAD = 20 * 1024 * 1024, MAX_PROJECT = 100 * 1024 * 1024;
const isBinary = (b: Buffer) => b.subarray(0, 8000).includes(0);

/** Every operation is scoped to the project row of the bot the caller is authorised for; paths are normalised and never touch a real filesystem. */
export function fileRoutes() {
  const r = Router({ mergeParams: true });
  r.use(requireAuth);

  async function ctx(req: any, res: any, manage: boolean) {
    const bot = await loadBotFor(req, res, manage); if (!bot) return null;
    const p = (await q("SELECT id FROM projects WHERE bot_id=$1", [bot.id])).rows[0];
    return { bot, pid: p.id as string };
  }
  async function ensureRoom(pid: string, add: number, replacing = 0) {
    const used = Number((await q("SELECT COALESCE(sum(size),0)::bigint s FROM project_files WHERE project_id=$1", [pid])).rows[0].s);
    if (used - replacing + add > MAX_PROJECT) throw new HttpError(413, "Project size limit (100 MB) exceeded.");
  }
  const refresh = (pid: string) => q("UPDATE projects SET file_count=(SELECT count(*) FROM project_files WHERE project_id=$1 AND path NOT LIKE '%/'), total_bytes=(SELECT COALESCE(sum(size),0) FROM project_files WHERE project_id=$1), updated_at=now() WHERE id=$1", [pid]);

  r.get("/list", h(async (req, res) => {
    const c = await ctx(req, res, false); if (!c) return;
    const dir = safeRelPath(req.query.path ?? "", { allowRoot: true });
    const prefix = dir ? dir + "/" : "";
    const rows = await q("SELECT path,size,updated_at FROM project_files WHERE project_id=$1 AND starts_with(path,$2) AND path<>$2 ORDER BY path", [c.pid, prefix]);
    const entries = new Map<string, { name: string; type: "file" | "dir"; size: number; updatedAt: string }>();
    for (const row of rows.rows) {
      const rest = (row.path as string).slice(prefix.length);
      const i = rest.indexOf("/");
      if (i === -1) entries.set(rest, { name: rest, type: "file", size: row.size, updatedAt: row.updated_at });
      else { const n = rest.slice(0, i); if (!entries.has(n)) entries.set(n, { name: n, type: "dir", size: 0, updatedAt: row.updated_at }); }
    }
    res.json({ path: dir, entries: [...entries.values()].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1)) });
  }));

  r.get("/read", h(async (req, res) => {
    const c = await ctx(req, res, false); if (!c) return;
    const path = safeRelPath(req.query.path);
    const row = (await q("SELECT content,size FROM project_files WHERE project_id=$1 AND path=$2", [c.pid, path])).rows[0];
    if (!row) throw new HttpError(404, "File not found.");
    if (row.size > MAX_TEXT || isBinary(row.content)) return res.json({ path, binary: true, size: row.size });
    res.json({ path, binary: false, size: row.size, content: row.content.toString("utf8") });
  }));

  r.get("/download", h(async (req, res) => {
    const c = await ctx(req, res, false); if (!c) return;
    const path = safeRelPath(req.query.path);
    const row = (await q("SELECT content FROM project_files WHERE project_id=$1 AND path=$2", [c.pid, path])).rows[0];
    if (!row) throw new HttpError(404, "File not found.");
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${basename(path).replace(/[^\w.\-]/g, "_")}"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(row.content);
  }));

  r.get("/download-project", h(async (req, res) => {
    const c = await ctx(req, res, false); if (!c) return;
    const rows = await q("SELECT path,content FROM project_files WHERE project_id=$1 AND path NOT LIKE '%/'", [c.pid]);
    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("Content-Disposition", `attachment; filename="${c.bot.name.replace(/[^\w.\-]/g, "_")}.tar.gz"`);
    res.send(buildTarGz(new Map(rows.rows.map((x) => [x.path, x.content]))));
  }));

  r.put("/write", h(async (req, res) => {
    const c = await ctx(req, res, true); if (!c) return;
    const path = safeRelPath(req.body?.path); if (path.endsWith("/")) throw new HttpError(400, "Invalid file name.");
    if (typeof req.body?.content !== "string") throw new HttpError(400, "content must be text.");
    const data = Buffer.from(req.body.content, "utf8"); if (data.length > MAX_TEXT) throw new HttpError(413, "Text files are limited to 2 MB.");
    const old = (await q("SELECT size FROM project_files WHERE project_id=$1 AND path=$2", [c.pid, path])).rows[0];
    if (!old && req.body.mustNotExist) throw new HttpError(409, "File already exists.");
    if ((await q("SELECT 1 FROM project_files WHERE project_id=$1 AND starts_with(path,$2)", [c.pid, path + "/"])).rowCount) throw new HttpError(409, "A folder with that name exists.");
    await ensureRoom(c.pid, data.length, old?.size ?? 0);
    await q("INSERT INTO project_files(project_id,path,content,size) VALUES ($1,$2,$3,$4) ON CONFLICT (project_id,path) DO UPDATE SET content=$3,size=$4,updated_at=now()", [c.pid, path, data, data.length]);
    await refresh(c.pid); await audit(req, "file.write", { type: "bot", id: c.bot.id }, { path });
    res.json({ ok: true, note: "Redeploy or restart to run the updated code." });
  }));

  r.post("/upload", express.raw({ type: () => true, limit: MAX_UPLOAD }), h(async (req, res) => {
    const c = await ctx(req, res, true); if (!c) return;
    const path = safeRelPath(req.query.path); if (!Buffer.isBuffer(req.body)) throw new HttpError(400, "Send the file as the request body.");
    const old = (await q("SELECT size FROM project_files WHERE project_id=$1 AND path=$2", [c.pid, path])).rows[0];
    await ensureRoom(c.pid, req.body.length, old?.size ?? 0);
    await q("INSERT INTO project_files(project_id,path,content,size) VALUES ($1,$2,$3,$4) ON CONFLICT (project_id,path) DO UPDATE SET content=$3,size=$4,updated_at=now()", [c.pid, path, req.body, req.body.length]);
    await refresh(c.pid); await audit(req, "file.upload", { type: "bot", id: c.bot.id }, { path }); res.json({ ok: true });
  }));

  r.post("/folder", h(async (req, res) => {
    const c = await ctx(req, res, true); if (!c) return;
    const path = safeRelPath(req.body?.path);
    if ((await q("SELECT 1 FROM project_files WHERE project_id=$1 AND path=$2", [c.pid, path])).rowCount) throw new HttpError(409, "A file with that name exists.");
    await q("INSERT INTO project_files(project_id,path,content,size) VALUES ($1,$2,''::bytea,0) ON CONFLICT DO NOTHING", [c.pid, path + "/"]);
    await audit(req, "file.mkdir", { type: "bot", id: c.bot.id }, { path }); res.json({ ok: true });
  }));

  r.delete("/", h(async (req, res) => {
    const c = await ctx(req, res, true); if (!c) return;
    const path = safeRelPath(req.query.path);
    const del = await q("DELETE FROM project_files WHERE project_id=$1 AND (path=$2 OR path=$3 OR starts_with(path,$3))", [c.pid, path, path + "/"]);
    if (!del.rowCount) throw new HttpError(404, "Nothing to delete.");
    await refresh(c.pid); await audit(req, "file.delete", { type: "bot", id: c.bot.id }, { path }); res.json({ ok: true });
  }));

  r.post("/rename", h(async (req, res) => {
    const c = await ctx(req, res, true); if (!c) return;
    const from = safeRelPath(req.body?.from), to = safeRelPath(req.body?.to);
    if (to === from || to.startsWith(from + "/")) throw new HttpError(400, "Invalid destination.");
    if ((await q("SELECT 1 FROM project_files WHERE project_id=$1 AND (path=$2 OR path=$3 OR starts_with(path,$3))", [c.pid, to, to + "/"])).rowCount) throw new HttpError(409, "Destination already exists.");
    const u = await q(`UPDATE project_files SET path = CASE WHEN path=$2 THEN $3 ELSE $3 || substr(path, length($2)+1) END, updated_at=now()
      WHERE project_id=$1 AND (path=$2 OR starts_with(path,$2 || '/'))`, [c.pid, from, to]);
    if (!u.rowCount) throw new HttpError(404, "Source not found.");
    await audit(req, "file.rename", { type: "bot", id: c.bot.id }, { from, to }); res.json({ ok: true });
  }));
  return r;
}
