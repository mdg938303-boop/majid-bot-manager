import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

export let pool: pg.Pool;
export function initPool(url: string, ssl: boolean) {
  pool = new pg.Pool({ connectionString: url, max: 10, ssl: ssl && !/localhost|127\.0\.0\.1/.test(url) ? { rejectUnauthorized: false } : undefined });
  return pool;
}
export const q = <T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []) => pool.query<T>(text, params);

export async function migrate(dir: string) {
  await q("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  const done = new Set((await q("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(f)) continue;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(readFileSync(join(dir, f), "utf8"));
      await client.query("INSERT INTO schema_migrations(name) VALUES ($1)", [f]);
      await client.query("COMMIT");
      console.log(`migration applied: ${f}`);
    } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
  }
}

export async function getSetting<T = any>(key: string, fallback: T): Promise<T> {
  const r = await q("SELECT value FROM system_settings WHERE key=$1", [key]);
  return r.rowCount ? (r.rows[0].value as T) : fallback;
}
export async function setSetting(key: string, value: unknown) {
  await q("INSERT INTO system_settings(key,value,updated_at) VALUES ($1,$2,now()) ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=now()", [key, JSON.stringify(value)]);
}
