import { q, getSetting, setSetting } from "../db.js";
import type { Config } from "../config.js";
import { decrypt } from "../lib/crypto.js";
import { detectProject, DetectionError, type Manifest } from "../lib/detect.js";
import type { Runtime } from "../sandbox/runtime.js";
import { DeployError, processState, readLogChunk, runDeployment, startProcess, stopProcess, type LogStream } from "./deployer.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Bot = Record<string, any>;

export class Engine {
  private busy = false;
  private timers: NodeJS.Timeout[] = [];
  constructor(private cfg: Config, public runtime: Runtime) {}

  // ---------- logging ----------
  async log(botId: string, deploymentId: string | null, stream: LogStream, text: string) {
    if (!text) return;
    await q("INSERT INTO logs(bot_id,deployment_id,stream,text) VALUES ($1,$2,$3,$4)", [botId, deploymentId, stream, text.slice(0, 20000)]);
  }

  // ---------- lifecycle ----------
  async boot() {
    // Anything left mid-flight by a previous process is unknown: mark it failed rather than pretending.
    await q("UPDATE deployments SET status='failed', error='Interrupted by a server restart.', finished_at=now() WHERE status='running'");
    await q("UPDATE bots SET status='failed' WHERE status='deploying'");
    if (this.runtime.setGroupConcurrency && this.cfg.sandboxGroupId) {
      const max = await getSetting<number>("max_concurrent_sandboxes", 2);
      await this.runtime.setGroupConcurrency(this.cfg.sandboxGroupId, Math.max(1, max)).catch((e) => console.warn("group concurrency not set:", e?.message));
    }
    this.timers.push(setInterval(() => void this.tickQueue(), 2000));
    this.timers.push(setInterval(() => void this.tickLogs(), this.cfg.logPollSeconds * 1000));
    this.timers.push(setInterval(() => void this.tickReaper(), 60_000));
    this.timers.push(setInterval(() => void q("DELETE FROM sessions WHERE expires_at < now()").catch(() => undefined), 3_600_000));
  }
  stop() { this.timers.forEach(clearInterval); }

  async enqueue(bot: Bot, kind: "deploy" | "rebuild" | "redeploy" | "restart", ownerId: string) {
    if (await getSetting("kill_switch", false)) throw new HttpError(423, "The admin kill switch is active. Deployments are disabled.");
    const files = await q("SELECT 1 FROM project_files pf JOIN projects p ON p.id=pf.project_id WHERE p.bot_id=$1 LIMIT 1", [bot.id]);
    if (!files.rowCount) throw new HttpError(400, "Upload a project ZIP first.");
    const active = await q("SELECT id FROM deployments WHERE bot_id=$1 AND status IN ('queued','running')", [bot.id]);
    if (active.rowCount) throw new HttpError(409, "A deployment is already in progress for this bot.");
    const d = await q("INSERT INTO deployments(bot_id,owner_id,kind) VALUES ($1,$2,$3) RETURNING id", [bot.id, bot.owner_id, kind]);
    await q("UPDATE bots SET status='queued', updated_at=now() WHERE id=$1", [bot.id]);
    await this.log(bot.id, d.rows[0].id, "system", `Deployment queued (${kind}).\n`);
    return d.rows[0].id as string;
  }

  private async activeSandboxCount(excludeBot?: string) {
    const r = await q("SELECT count(*)::int AS n FROM bots WHERE sandbox_id IS NOT NULL AND ($1::uuid IS NULL OR id<>$1)", [excludeBot ?? null]);
    return r.rows[0].n as number;
  }

  private async tickQueue() {
    if (this.busy) return;
    this.busy = true;
    try {
      const r = await q(`UPDATE deployments SET status='running', started_at=now(), stage='provisioning'
        WHERE id=(SELECT id FROM deployments WHERE status='queued' ORDER BY queued_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`);
      if (r.rowCount) await this.processDeployment(r.rows[0]);
    } catch (e) { console.error("queue error", e); } finally { this.busy = false; }
  }

  private async processDeployment(dep: Bot) {
    const botRow = await q("SELECT * FROM bots WHERE id=$1", [dep.bot_id]);
    const bot = botRow.rows[0];
    const L = (s: LogStream, t: string) => this.log(bot.id, dep.id, s, t);
    const fail = async (stage: string, msg: string) => {
      await L("system", `✖ Deployment failed at "${stage}": ${msg}\n`);
      await q("UPDATE deployments SET status='failed', stage=$2, error=$3, finished_at=now() WHERE id=$1", [dep.id, stage, msg]);
      await q("UPDATE bots SET status='failed', sandbox_id=NULL, updated_at=now() WHERE id=$1", [bot.id]);
      await q("UPDATE sandbox_instances SET terminated_at=now() WHERE bot_id=$1 AND terminated_at IS NULL", [bot.id]);
    };
    if (!bot) return fail("provisioning", "Bot no longer exists.");
    try {
      if (await getSetting("kill_switch", false)) return fail("provisioning", "Kill switch is active.");
      const max = await getSetting<number>("max_concurrent_sandboxes", 2);
      if ((await this.activeSandboxCount(bot.id)) >= max) return fail("provisioning", `Global limit of ${max} concurrent sandboxes reached. Ask the admin to raise it or stop another bot.`);
      const allowed = await getSetting<string[]>("allowed_plans", ["1c-2g"]);
      if (!allowed.includes(bot.plan)) return fail("provisioning", `Plan ${bot.plan} is not allowed by the admin.`);

      await q("UPDATE bots SET status='deploying' WHERE id=$1", [bot.id]);
      const fr = await q("SELECT pf.path, pf.content FROM project_files pf JOIN projects p ON p.id=pf.project_id WHERE p.bot_id=$1 AND pf.path NOT LIKE '%/'", [bot.id]);
      const files = new Map<string, Buffer>(fr.rows.map((x) => [x.path, x.content]));
      let manifest: Manifest;
      try { manifest = detectProject(files, bot.entry_point_override ? { entryPoint: bot.entry_point_override } : undefined); }
      catch (e) { if (e instanceof DetectionError) return fail("detecting", e.message); throw e; }
      await L("system", `Detected ${manifest.language} project, entry point ${manifest.entryPoint}.\n`);
      manifest.warnings.forEach((w) => void L("system", `⚠ ${w}\n`));
      const envRows = await q("SELECT key, value_enc FROM environment_variables WHERE bot_id=$1", [bot.id]);
      const env: Record<string, string> = {};
      for (const r of envRows.rows) env[r.key] = decrypt(r.value_enc, this.cfg.encryptionKey);

      const res = await runDeployment(this.runtime, {
        botToken: decrypt(bot.token_enc, this.cfg.encryptionKey), env, files, manifest, plan: bot.plan,
        egress: bot.egress_domains ?? [], groupId: this.cfg.sandboxGroupId, previousSandboxId: bot.sandbox_id,
      }, {
        log: (s, t) => L(s, t),
        stage: async (s) => { await q("UPDATE deployments SET stage=$2 WHERE id=$1", [dep.id, s]); },
        sandboxCreated: async (id) => {
          await q("UPDATE sandbox_instances SET terminated_at=now() WHERE bot_id=$1 AND terminated_at IS NULL", [bot.id]);
          await q("INSERT INTO sandbox_instances(sandbox_id,bot_id,deployment_id,plan) VALUES ($1,$2,$3,$4)", [id, bot.id, dep.id, bot.plan]);
          await q("UPDATE bots SET sandbox_id=$2 WHERE id=$1", [bot.id, id]);
        },
      });
      await q("UPDATE deployments SET status='succeeded', stage='running', manifest=$2, sandbox_id=$3, pid=$4, finished_at=now() WHERE id=$1", [dep.id, JSON.stringify(manifest), res.sandboxId, res.pid]);
      await q(`UPDATE bots SET status='running', sandbox_id=$2, language=$3, entry_point=$4, manifest=$5, current_deployment_id=$1,
        out_offset=0, err_offset=0, stopped_at=NULL, last_deployed_at=now(), updated_at=now() WHERE id=$6`, [dep.id, res.sandboxId, manifest.language, manifest.entryPoint, JSON.stringify(manifest), bot.id]);
      await L("system", "✔ Deployment succeeded. Process confirmed running.\n");
    } catch (e: any) {
      await fail(e instanceof DeployError ? e.stage : "provisioning", e?.message ?? String(e));
    }
  }

  // ---------- controls ----------
  private async requireSandbox(bot: Bot) {
    if (!bot.sandbox_id) return false;
    const st = await this.runtime.status(bot.sandbox_id);
    return st === "running" || st === "suspended" || st === "resuming";
  }

  async start(bot: Bot) {
    if (await getSetting("kill_switch", false)) throw new HttpError(423, "The admin kill switch is active.");
    if (!(await this.requireSandbox(bot))) return { queued: true, deploymentId: await this.enqueue(bot, "redeploy", bot.owner_id) };
    if ((await processState(this.runtime, bot.sandbox_id)) === "running") { await q("UPDATE bots SET status='running', stopped_at=NULL WHERE id=$1", [bot.id]); return { queued: false, status: "running" }; }
    const m = bot.manifest as Manifest;
    await startProcess(this.runtime, bot.sandbox_id, m, { log: (s, t) => this.log(bot.id, bot.current_deployment_id, s, t), stage: () => undefined, sandboxCreated: () => undefined });
    await q("UPDATE bots SET status='running', stopped_at=NULL, updated_at=now() WHERE id=$1", [bot.id]);
    return { queued: false, status: "running" };
  }

  async stopBot(bot: Bot) {
    if (bot.sandbox_id && (await this.requireSandbox(bot))) {
      await stopProcess(this.runtime, bot.sandbox_id);
      await this.collectOne(bot).catch(() => undefined);
      if ((await processState(this.runtime, bot.sandbox_id)) !== "stopped") throw new HttpError(500, "Process is still running.");
    }
    await q("UPDATE bots SET status='stopped', stopped_at=now(), updated_at=now() WHERE id=$1", [bot.id]);
    await this.log(bot.id, bot.current_deployment_id, "system", "Bot stopped (process verified stopped).\n");
  }

  async restart(bot: Bot) {
    if (!(await this.requireSandbox(bot))) return { queued: true, deploymentId: await this.enqueue(bot, "redeploy", bot.owner_id) };
    // Re-upload env so variable changes apply, then restart the process only.
    await this.pushEnv(bot);
    await stopProcess(this.runtime, bot.sandbox_id);
    await this.collectOne(bot).catch(() => undefined);
    return this.start({ ...bot });
  }

  private async pushEnv(bot: Bot) {
    const { buildEnvFile } = await import("./deployer.js");
    const rows = await q("SELECT key, value_enc FROM environment_variables WHERE bot_id=$1", [bot.id]);
    const env: Record<string, string> = {};
    for (const r of rows.rows) env[r.key] = decrypt(r.value_enc, this.cfg.encryptionKey);
    await this.runtime.upload(bot.sandbox_id, ".bot.env", Buffer.from(buildEnvFile(decrypt(bot.token_enc, this.cfg.encryptionKey), env)), "file");
    await this.runtime.exec(bot.sandbox_id, "chmod 600 .bot.env");
  }

  async release(bot: Bot, reason = "Released to save credit.") {
    if (bot.sandbox_id) {
      await this.runtime.terminate(bot.sandbox_id).catch((e) => console.warn("terminate failed", e?.message));
      await q("UPDATE sandbox_instances SET terminated_at=now() WHERE sandbox_id=$1", [bot.sandbox_id]);
    }
    await q("UPDATE bots SET status='released', sandbox_id=NULL, updated_at=now() WHERE id=$1", [bot.id]);
    await this.log(bot.id, null, "system", `Sandbox terminated. ${reason}\n`);
  }

  async deleteBot(bot: Bot) {
    if (bot.sandbox_id) await this.runtime.terminate(bot.sandbox_id).catch(() => undefined);
    await q("DELETE FROM bots WHERE id=$1", [bot.id]);
  }

  async killAll() {
    await setSetting("kill_switch", true);
    await q("UPDATE deployments SET status='cancelled', finished_at=now(), error='Kill switch' WHERE status='queued'");
    const bots = await q("SELECT * FROM bots WHERE sandbox_id IS NOT NULL");
    let n = 0;
    for (const b of bots.rows) { await this.release(b, "Admin kill switch."); n++; }
    return n;
  }

  // ---------- log collection & health ----------
  async collectOne(bot: Bot) {
    if (!bot.sandbox_id) return;
    const out = await readLogChunk(this.runtime, bot.sandbox_id, "run.out.log", Number(bot.out_offset));
    const err = await readLogChunk(this.runtime, bot.sandbox_id, "run.err.log", Number(bot.err_offset));
    if (out.text) await this.log(bot.id, bot.current_deployment_id, "stdout", out.text);
    if (err.text) await this.log(bot.id, bot.current_deployment_id, "stderr", err.text);
    if (out.text || err.text) await q("UPDATE bots SET out_offset=$2, err_offset=$3 WHERE id=$1", [bot.id, out.newOffset, err.newOffset]);
  }

  private async tickLogs() {
    try {
      const bots = await q("SELECT * FROM bots WHERE status='running' AND sandbox_id IS NOT NULL");
      for (const bot of bots.rows) {
        try {
          const st = await this.runtime.status(bot.sandbox_id);
          if (st === "terminated" || st === "errored" || st === "unknown") {
            await q("UPDATE bots SET status='failed', sandbox_id=NULL WHERE id=$1", [bot.id]);
            await this.log(bot.id, bot.current_deployment_id, "system", `Sandbox is ${st}. Bot is no longer running; use Redeploy.\n`);
            continue;
          }
          await this.collectOne(bot);
          if ((await processState(this.runtime, bot.sandbox_id)) === "stopped") {
            await q("UPDATE bots SET status='failed', updated_at=now() WHERE id=$1", [bot.id]);
            await this.log(bot.id, bot.current_deployment_id, "system", "Bot process exited unexpectedly. Check stderr above.\n");
          }
          await q("DELETE FROM logs WHERE bot_id=$1 AND id < COALESCE((SELECT id FROM logs WHERE bot_id=$1 ORDER BY id DESC OFFSET 20000 LIMIT 1),0)", [bot.id]);
        } catch (e: any) { console.warn(`log poll failed for ${bot.id}:`, e?.message); }
        await sleep(100);
      }
    } catch (e) { console.error("tickLogs", e); }
  }

  private async tickReaper() {
    try {
      const mins = await getSetting<number>("auto_release_minutes", 30);
      const maxH = await getSetting<number>("max_run_hours", 8);
      if (maxH > 0) {
        const old = await q("SELECT b.* FROM bots b JOIN sandbox_instances s ON s.sandbox_id=b.sandbox_id WHERE s.terminated_at IS NULL AND s.created_at < now() - ($1 || ' hours')::interval", [String(maxH)]);
        for (const b of old.rows) await this.release(b, `Sandbox ran for over ${maxH} hours; released automatically to save credit. Press Start to run it again.`);
      }
      if (!mins) return;
      const r = await q("SELECT * FROM bots WHERE status IN ('stopped','failed') AND sandbox_id IS NOT NULL AND COALESCE(stopped_at, updated_at) < now() - ($1 || ' minutes')::interval", [String(mins)]);
      for (const b of r.rows) await this.release(b, `Stopped for over ${mins} minutes; sandbox released automatically to save credit.`);
    } catch (e) { console.error("reaper", e); }
  }
}

export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
