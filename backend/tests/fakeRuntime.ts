import type { CreateOptions, ExecResult, Runtime } from "../src/sandbox/runtime.js";

export class FakeRuntime implements Runtime {
  sandboxes = new Map<string, { alive: boolean; files: Map<string, Buffer>; env?: Buffer; terminated: boolean; opts: CreateOptions }>();
  commands: string[] = [];
  missingTools = new Set<string>();
  failCommandMatching: RegExp | null = null;
  crashOnStart = false;
  stubborn = false;
  runtimeOk = true;
  private n = 0;
  async available() { return this.runtimeOk ? { ok: true } : { ok: false, reason: "Sandboxes are not enabled for this workspace." }; }
  async create(opts: CreateOptions) {
    const id = `sbx-${++this.n}`;
    this.sandboxes.set(id, { alive: false, files: new Map(), terminated: false, opts });
    return { id };
  }
  async exec(id: string, command: string, onOutput?: (s: "stdout" | "stderr", c: string) => void): Promise<ExecResult> {
    const sb = this.sandboxes.get(id);
    if (!sb || sb.terminated) throw new Error("sandbox ended");
    this.commands.push(command);
    const ok = (stdout = ""): ExecResult => ({ exitCode: 0, stdout, stderr: "" });
    let m: RegExpMatchArray | null;
    if ((m = command.match(/command -v (\S+)/)) && !command.includes("setsid")) return this.missingTools.has(m[1]) ? { exitCode: 1, stdout: "", stderr: "" } : ok("ok\n");
    if (command.includes("kill -0")) return ok(sb.alive ? "RUNNING\n" : "STOPPED\n");
    if (command.includes("nohup")) { sb.alive = !this.crashOnStart; return ok(); }
    if (command.includes("kill -TERM")) { if (!this.stubborn) sb.alive = false; return ok(); }
    if (command.includes("kill -KILL")) { sb.alive = false; return ok(); }
    if (command === "cat bot.pid") return ok("4242\n");
    if (command.startsWith("tail -c 2000")) return ok("Traceback: boom\n");
    if (command.startsWith("cd app && ")) {
      if (this.failCommandMatching?.test(command)) { onOutput?.("stderr", "ERROR: failed\n"); return { exitCode: 1, stdout: "", stderr: "ERROR: failed\n" }; }
      onOutput?.("stdout", "installing…\n"); return ok("installing…\n");
    }
    return ok();
  }
  async upload(id: string, path: string, data: Buffer) { const sb = this.sandboxes.get(id)!; if (path === ".bot.env") sb.env = data; else sb.files.set(path, data); }
  async status(id: string) { const s = this.sandboxes.get(id); return !s ? "unknown" : s.terminated ? "terminated" : "running"; }
  async terminate(id: string) { const s = this.sandboxes.get(id); if (s) { s.terminated = true; s.alive = false; } }
}
