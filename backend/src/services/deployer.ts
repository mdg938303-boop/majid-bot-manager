/**
 * Deployment pipeline. Pure orchestration over a Runtime so it can be tested with a fake runtime.
 * Success is only reported after the bot process is confirmed alive.
 */
import type { Manifest } from "../lib/detect.js";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { buildTar } from "../lib/tar.js";
import { BRIDGE_PY } from "../sandbox/bridge.js";
import type { NetworkPolicy, Runtime } from "../sandbox/runtime.js";

export type LogStream = "system" | "build" | "stdout" | "stderr";
export interface DeployHooks {
  log(stream: LogStream, text: string): void | Promise<void>;
  stage(stage: string): void | Promise<void>;
  sandboxCreated(id: string): void | Promise<void>;
}
export interface DeployInput {
  botToken: string; env: Record<string, string>; files: Map<string, Buffer>; manifest: Manifest;
  plan: string; egress: string[]; groupId?: string; previousSandboxId?: string | null; startupWaitMs?: number;
  webhook?: WebhookCfg | null; dataArchive?: Buffer | null; // dataArchive = plain tar of the bot's data/ folder
}
export interface WebhookCfg { port: number; path: string }
export class DeployError extends Error { constructor(public stage: string, message: string) { super(message); } }

export const BASE_EGRESS = [
  "api.telegram.org", "pypi.org", "files.pythonhosted.org", "registry.npmjs.org",
  "repo.packagist.org", "packagist.org", "api.github.com", "codeload.github.com", "github.com",
];
export const RESERVED_ENV = new Set(["PATH", "HOME", "LD_PRELOAD", "LD_LIBRARY_PATH", "SHELL", "USER", "PWD", "IFS", "BASH_ENV", "ENV", "NODE_OPTIONS", "PYTHONPATH", "PYTHONSTARTUP", "PORT", "WEBHOOK_PATH", "DATA_DIR"]);

export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function buildNetworkPolicy(extra: string[]): NetworkPolicy {
  const domains = [...new Set([...BASE_EGRESS, ...extra])];
  return { type: "allow-list", rules: domains.map((domain) => ({ domain })) };
}

export function buildEnvFile(botToken: string, env: Record<string, string>): string {
  const all: Record<string, string> = { ...env, BOT_TOKEN: botToken, TELEGRAM_BOT_TOKEN: botToken, TELEGRAM_TOKEN: botToken };
  return Object.entries(all).map(([k, v]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`Invalid environment variable name: ${k}`);
    return `export ${k}=${shq(v)}`;
  }).join("\n") + "\n";
}

export function startCommand(m: Manifest, webhook?: WebhookCfg | null): string {
  const run = webhook ? `python3 ../bridge.py & exec ${m.startCommand}` : `exec ${m.startCommand}`;
  const inner = shq(run);
  const parts = ["cd app", "mkdir -p data", ". ../.bot.env", 'export DATA_DIR="$(pwd)/data"'];
  if (webhook) {
    if (!Number.isInteger(webhook.port) || webhook.port < 1024 || webhook.port > 65535) throw new Error("Invalid webhook port");
    if (!/^\/[A-Za-z0-9_\-./]*$/.test(webhook.path)) throw new Error("Invalid webhook path");
    parts.push(`export PORT=${webhook.port} WEBHOOK_PATH=${shq(webhook.path)}`);
  }
  parts.push(`(nohup $(command -v setsid || true) sh -c ${inner} >> ../run.out.log 2>> ../run.err.log < /dev/null & echo $! > ../bot.pid)`);
  return parts.join(" && ");
}
export const STATUS_CMD = `if [ -f bot.pid ] && kill -0 "$(cat bot.pid)" 2>/dev/null; then echo RUNNING; else echo STOPPED; fi`;

export async function processState(rt: Runtime, id: string): Promise<"running" | "stopped"> {
  const r = await rt.exec(id, STATUS_CMD);
  return r.stdout.includes("RUNNING") ? "running" : "stopped";
}

export async function stopProcess(rt: Runtime, id: string, graceMs = 8000): Promise<void> {
  await rt.exec(id, `if [ -f bot.pid ]; then P="$(cat bot.pid)"; kill -TERM -- -"$P" 2>/dev/null || kill -TERM "$P" 2>/dev/null; fi; true`);
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if ((await processState(rt, id)) === "stopped") return;
    await new Promise((r) => setTimeout(r, 500));
  }
  await rt.exec(id, `if [ -f bot.pid ]; then P="$(cat bot.pid)"; kill -KILL -- -"$P" 2>/dev/null || kill -KILL "$P" 2>/dev/null; fi; true`);
  await new Promise((r) => setTimeout(r, 500));
  if ((await processState(rt, id)) !== "stopped") throw new DeployError("stop", "Process did not stop.");
}

/** Starts the bot process in an already-prepared sandbox and verifies it stays alive. */
export async function startProcess(rt: Runtime, id: string, m: Manifest, hooks: DeployHooks, waitMs = 4000, webhook?: WebhookCfg | null): Promise<number> {
  await hooks.stage("starting");
  await hooks.log("system", `$ ${m.startCommand}${webhook ? `  (webhook bridge → 127.0.0.1:${webhook.port}${webhook.path})` : ""}\n`);
  const r = await rt.exec(id, startCommand(m, webhook));
  if (r.exitCode !== 0) throw new DeployError("starting", `Failed to launch the process (exit ${r.exitCode}): ${r.stderr.slice(-500)}`);
  await new Promise((res) => setTimeout(res, waitMs));
  if ((await processState(rt, id)) !== "running") {
    const err = await rt.exec(id, "tail -c 2000 run.err.log 2>/dev/null; tail -c 1000 run.out.log 2>/dev/null");
    await hooks.log("stderr", err.stdout);
    throw new DeployError("starting", "The bot process exited immediately after starting. See the output above.");
  }
  const pid = await rt.exec(id, "cat bot.pid");
  await hooks.log("system", "Process is running.\n");
  return parseInt(pid.stdout.trim(), 10) || 0;
}

async function run(rt: Runtime, id: string, cmd: string, hooks: DeployHooks, stage: string, dir = "app") {
  await hooks.log("build", `$ ${cmd}\n`);
  const r = await rt.exec(id, `cd ${dir} && ${cmd}`, (stream, chunk) => { void hooks.log("build", chunk); });
  if (r.exitCode !== 0) throw new DeployError(stage, `Command failed with exit code ${r.exitCode}: ${cmd}`);
}

export async function runDeployment(rt: Runtime, input: DeployInput, hooks: DeployHooks): Promise<{ sandboxId: string; pid: number }> {
  const { manifest: m } = input;
  let sandboxId: string | null = null;
  try {
    await hooks.stage("provisioning");
    const avail = await rt.available();
    if (!avail.ok) throw new DeployError("provisioning", avail.reason ?? "Runtime unavailable.");
    if (input.previousSandboxId) {
      await hooks.log("system", "Terminating previous sandbox (prevents duplicate Telegram polling).\n");
      await rt.terminate(input.previousSandboxId).catch(() => undefined);
    }
    await hooks.log("system", `Creating sandbox (${input.plan}) with restricted egress…\n`);
    sandboxId = (await rt.create({ plan: input.plan, networkPolicy: buildNetworkPolicy(input.egress), groupId: input.groupId })).id;
    await hooks.sandboxCreated(sandboxId);

    await hooks.stage("uploading");
    const mk = await rt.exec(sandboxId, "mkdir -p app && : > run.out.log && : > run.err.log");
    if (mk.exitCode !== 0) throw new DeployError("uploading", "Could not prepare the sandbox workspace.");
    await rt.upload(sandboxId, "app", buildTar(input.files), "tar");
    await rt.upload(sandboxId, ".bot.env", Buffer.from(buildEnvFile(input.botToken, input.env)), "file");
    await rt.exec(sandboxId, "chmod 600 .bot.env");
    await hooks.log("system", `Uploaded ${input.files.size} files.\n`);
    if (input.dataArchive) {
      await rt.upload(sandboxId, "app", input.dataArchive, "tar");
      await hooks.log("system", "Restored the bot's saved data folder.\n");
    }
    if (input.webhook) await rt.upload(sandboxId, "bridge.py", Buffer.from(BRIDGE_PY), "file");

    await hooks.stage("checking");
    const tools = input.webhook ? [...new Set([...m.requiredTools, "python3"])] : m.requiredTools;
    for (const tool of tools) {
      const r = await rt.exec(sandboxId, `command -v ${tool} >/dev/null 2>&1 && echo ok`);
      if (!r.stdout.includes("ok")) throw new DeployError("checking", `Required tool "${tool}" is not installed in the sandbox image. This platform cannot run ${m.language} projects until it is available.`);
    }

    await hooks.stage("installing");
    for (const c of m.installCommands) await run(rt, sandboxId, c, hooks, "installing");
    if (m.buildCommands.length) {
      await hooks.stage("building");
      for (const c of m.buildCommands) await run(rt, sandboxId, c, hooks, "building");
    }
    const pid = await startProcess(rt, sandboxId, m, hooks, input.startupWaitMs ?? 4000, input.webhook);
    return { sandboxId, pid };
  } catch (e) {
    if (sandboxId) { await rt.terminate(sandboxId).catch(() => undefined); await hooks.log("system", "Sandbox terminated after failure to avoid charges.\n"); }
    if (e instanceof DeployError) { e.message = e.message; throw Object.assign(e, { sandboxId: null }); }
    throw new DeployError("provisioning", (e as Error).message);
  }
}

/** Fetch new log bytes from a running sandbox. Returns the new byte offset. */
export async function readLogChunk(rt: Runtime, id: string, file: "run.out.log" | "run.err.log", offset: number, max = 65536) {
  const r = await rt.exec(id, `tail -c +${offset + 1} ${file} 2>/dev/null | head -c ${max}`);
  const bytes = Buffer.byteLength(r.stdout);
  return { text: r.stdout, newOffset: offset + bytes };
}

// ---------- persistent bot data (data/ folder) ----------
export const MAX_DATA_BYTES = 10 * 1024 * 1024;
export type ExportResult =
  | { status: "saved"; tar: Buffer; sha: string; gz: Buffer }
  | { status: "none" }
  | { status: "too_large"; kb: number }
  | { status: "error"; message: string };

/** Pulls the bot's data/ folder out of a live sandbox as a tar (never throws). */
export async function exportData(rt: Runtime, id: string, maxBytes = MAX_DATA_BYTES): Promise<ExportResult> {
  try {
    const has = await rt.exec(id, "test -d app/data && echo yes || echo no");
    if (!has.stdout.includes("yes")) return { status: "none" };
    const files = parseInt((await rt.exec(id, "find app/data -type f | wc -l")).stdout.trim(), 10);
    if (!(files > 0)) return { status: "none" };
    const kb = parseInt((await rt.exec(id, "du -sk app/data | cut -f1")).stdout.trim(), 10);
    if (Number.isFinite(kb) && kb * 1024 > maxBytes) return { status: "too_large", kb };
    const mk = await rt.exec(id, "tar cf data.tar -C app data");
    if (mk.exitCode !== 0) return { status: "error", message: "tar failed: " + mk.stderr.slice(0, 200) };
    const tar = await rt.download(id, "data.tar", maxBytes * 2);
    await rt.exec(id, "rm -f data.tar").catch(() => undefined);
    return { status: "saved", tar, sha: createHash("sha256").update(tar).digest("hex"), gz: gzipSync(tar) };
  } catch (e: any) {
    return { status: "error", message: e?.message ?? String(e) };
  }
}

// ---------- runtime tool check ----------
export const TOOL_CHECKS = ["python3", "pip", "node", "npm", "php", "composer"];
export interface ToolStatus { found: boolean; version: string }

export async function checkRuntimeTools(rt: Runtime, id: string): Promise<Record<string, ToolStatus>> {
  const cmd = `for t in ${TOOL_CHECKS.join(" ")}; do p=$(command -v $t 2>/dev/null); if [ -n "$p" ]; then echo "$t|yes|$($t --version 2>&1 | head -1)"; else echo "$t|no|"; fi; done; if python3 -m venv --help >/dev/null 2>&1; then echo "venv|yes|"; else echo "venv|no|"; fi`;
  const r = await rt.exec(id, cmd);
  const out: Record<string, ToolStatus> = {};
  for (const line of r.stdout.split("\n")) {
    const [name, yes, ...ver] = line.trim().split("|");
    if (name && (yes === "yes" || yes === "no")) out[name] = { found: yes === "yes", version: ver.join("|").slice(0, 80) };
  }
  return out;
}
