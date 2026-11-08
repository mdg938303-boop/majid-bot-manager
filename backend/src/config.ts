import { parseKey } from "./lib/crypto.js";

const need = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`Missing required environment variable ${k}`); return v; };

export function loadConfig() {
  return {
    port: Number(process.env.PORT ?? 3000),
    isProd: process.env.NODE_ENV === "production",
    databaseUrl: need("DATABASE_URL"),
    encryptionKey: parseKey(need("ENCRYPTION_KEY")),
    adminEmail: process.env.ADMIN_EMAIL?.toLowerCase() ?? "",
    adminPassword: process.env.ADMIN_PASSWORD ?? "",
    sandboxGroupId: process.env.RENDER_SANDBOX_GROUP_ID || undefined,
    logPollSeconds: Math.max(2, Number(process.env.LOG_POLL_SECONDS ?? 5)),
    sessionDays: Number(process.env.SESSION_DAYS ?? 7),
    maxUploadMb: Number(process.env.MAX_UPLOAD_MB ?? 25),
    sslDb: process.env.DATABASE_SSL !== "false",
  };
}
export type Config = ReturnType<typeof loadConfig>;
