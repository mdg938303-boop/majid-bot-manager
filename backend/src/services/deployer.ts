/**
 * Deployment pipeline. Pure orchestration over a Runtime so it can be tested with a fake runtime.
 * Success is only reported after the bot process is confirmed alive.
 */
import type { Manifest } from "../lib/detect.js";
import { buildTar } from "../lib/tar.js";
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
}
export class DeployError extends Error { constructor(public stage: string, message: string) { super(message); } }

export const BASE_EGRESS = [
  "api.telegram.org", "pypi.org", "files.pythonhosted.org", "registry.npmjs.org",
  "repo.packagist.org", "packagist.org", "api.github.com", "codeload.github.com", "github.com",
];
export const RESERVED_ENV = new Set(["PATH", "HOME", "LD_PRELOAD", "LD_LIBRARY_PATH", "SHELL", "USER", "PWD", "IFS", "BASH_ENV", "ENV", "NODE_OPTIONS", "PYTHONPATH", "PYTHONSTARTUP"]);

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

export function startCommand(m: Manifest): string {
  const inner = shq(`exec ${m.startCommand}`);
  return [
    "cd app",
    ". ../.bot.env",
    `(nohup $(command -v setsid || true) sh -c ${inner} >> ../run.out.log 2>> ../run.err.log < /dev/null & echo $! > ../bot.pid)`,
  ].join(" && ");
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
export async function startProcess(rt: Runtime, id: string, m: Manifest, hooks: DeployHooks, waitMs = 4000): Promise<number> {
  await hooks.stage("starting");
  await hooks.log("system", `$ ${m.startCommand}\n`);
  const r = await rt.exec(id, startCommand(m));
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

    await hooks.stage("checking");
    for (const tool of m.requiredTools) {
      const r = await rt.exec(sandboxId, `command -v ${tool} >/dev/null 2>&1 && echo ok`);
      if (!r.stdout.includes("ok")) throw new DeployError("checking", `Required tool "${tool}" is not installed in the sandbox image. This platform cannot run ${m.language} projects until it is available.`);
    }

    await hooks.stage("installing");
    for (const c of m.installCommands) await run(rt, sandboxId, c, hooks, "installing");
    if (m.buildCommands.length) {
      await hooks.stage("building");
      for (const c of m.buildCommands) await run(rt, sandboxId, c, hooks, "building");
    }
    const pid = await startProcess(rt, sandboxId, m, hooks, input.startupWaitMs ?? 4000);
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
