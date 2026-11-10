/** Abstraction over the execution runtime. The control plane never executes uploaded code itself. */
export interface NetworkPolicy { type: "allow-all" | "deny-all" | "allow-list"; rules?: { domain: string }[] }
export interface ExecResult { exitCode: number; stdout: string; stderr: string }
export interface CreateOptions { plan: string; networkPolicy: NetworkPolicy; groupId?: string; env?: Record<string, string> }

export interface Runtime {
  /** Verifies the runtime is configured and reachable. Never pretends to work. */
  available(): Promise<{ ok: boolean; reason?: string }>;
  create(opts: CreateOptions): Promise<{ id: string }>;
  exec(id: string, command: string, onOutput?: (stream: "stdout" | "stderr", chunk: string) => void): Promise<ExecResult>;
  upload(id: string, path: string, data: Buffer, kind: "file" | "tar"): Promise<void>;
  download(id: string, path: string, maxBytes: number): Promise<Buffer>; // raw bytes of a single file
  status(id: string): Promise<string>; // creating | running | suspending | suspended | resuming | errored | terminated | unknown
  terminate(id: string): Promise<void>;
  setGroupConcurrency?(groupId: string, limit: number): Promise<void>;
}
