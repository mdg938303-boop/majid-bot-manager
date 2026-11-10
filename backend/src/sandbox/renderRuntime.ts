/**
 * Runtime backed by the official Render Sandboxes TypeScript SDK (@renderinc/sdk >= 1.5.0).
 * Methods used are those documented at https://render.com/docs/sandboxes-sdk-typescript :
 * create, get, exec (async generator of output/exit events), upload, terminate, updateGroup.
 */
import type { CreateOptions, ExecResult, Runtime } from "./runtime.js";

export class RenderRuntime implements Runtime {
  private sandboxes: any;
  private constructor(sandboxes: any) { this.sandboxes = sandboxes; }

  static async tryCreate(): Promise<Runtime> {
    const { RENDER_API_KEY, RENDER_WORKSPACE_ID } = process.env;
    if (!RENDER_API_KEY || !RENDER_WORKSPACE_ID) return new DisabledRuntime("RENDER_API_KEY and RENDER_WORKSPACE_ID are not set.");
    try {
      const mod: any = await import("@renderinc/sdk");
      return new RenderRuntime(new mod.Render({ token: RENDER_API_KEY, ownerId: RENDER_WORKSPACE_ID }).sandboxes);
    } catch (e: any) {
      return new DisabledRuntime(`Render SDK could not be loaded: ${e?.message ?? e}`);
    }
  }

  async available() {
    try { await this.sandboxes.list({ limit: 1 }); return { ok: true }; }
    catch (e: any) { return { ok: false, reason: `Render Sandboxes API call failed (${e?.name ?? "error"}: ${e?.message ?? e}). Check that Sandboxes are enabled for this workspace and the API key is valid.` }; }
  }

  async create(o: CreateOptions) {
    const sb = await this.sandboxes.create({
      plan: o.plan,
      networkPolicy: o.networkPolicy,
      sandboxGroupId: o.groupId || undefined,
      env: o.env,
      // Bots must keep running: disable idle suspension and runtime timeout (documented: 0 disables each).
      idleTimeoutSeconds: 0,
      timeoutSeconds: 0,
      wait: { timeoutMs: 120_000 },
    });
    return { id: sb.id as string };
  }

  async exec(id: string, command: string, onOutput?: (s: "stdout" | "stderr", c: string) => void): Promise<ExecResult> {
    const events = await this.sandboxes.exec(id, command);
    let stdout = "", stderr = "", exitCode = -1;
    for await (const ev of events) {
      if (ev.type === "output") {
        if (ev.stream === "stderr") stderr += ev.data; else stdout += ev.data;
        onOutput?.(ev.stream, ev.data);
      } else if (ev.type === "exit") exitCode = ev.exit_code;
    }
    return { exitCode, stdout, stderr };
  }

  async upload(id: string, path: string, data: Buffer, kind: "file" | "tar") {
    await this.sandboxes.upload(id, path, data, undefined, { contentType: kind === "tar" ? "application/x-tar" : "application/octet-stream" });
  }

  async download(id: string, path: string, maxBytes: number) {
    const d = await this.sandboxes.download(id, path, undefined, { maxSizeBytes: maxBytes });
    return Buffer.from(d.data);
  }

  async status(id: string) {
    try { return (await this.sandboxes.get(id)).status as string; } catch { return "unknown"; }
  }

  async terminate(id: string) { await this.sandboxes.terminate(id); }

  async setGroupConcurrency(groupId: string, limit: number) { await this.sandboxes.updateGroup(groupId, limit); }
}

export class DisabledRuntime implements Runtime {
  constructor(private reason: string) {}
  async available() { return { ok: false, reason: this.reason }; }
  private fail(): never { throw new Error(`Execution runtime is not available: ${this.reason}`); }
  async create(_o: CreateOptions): Promise<{ id: string }> { return this.fail(); }
  async exec(): Promise<ExecResult> { return this.fail(); }
  async upload(): Promise<void> { return this.fail(); }
  async download(): Promise<Buffer> { return this.fail(); }
  async status() { return "unknown"; }
  async terminate() { /* nothing to terminate */ }
}
