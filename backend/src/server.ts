import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import cookieParser from "cookie-parser";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { loadConfig } from "./config.js";
import { initPool, migrate, q } from "./db.js";
import { hashPassword } from "./lib/crypto.js";
import { csrfGuard, loadUser } from "./middleware/auth.js";
import { RenderRuntime } from "./sandbox/renderRuntime.js";
import { Engine } from "./services/engine.js";
import { adminRoutes } from "./routes/admin.js";
import { authRoutes } from "./routes/auth.js";
import { botRoutes } from "./routes/bots.js";
import { fileRoutes } from "./routes/files.js";
import { deploymentRoutes, logRoutes } from "./routes/logs.js";
import { errorHandler } from "./routes/util.js";

const here = dirname(fileURLToPath(import.meta.url));

async function ensureAdmin(cfg: ReturnType<typeof loadConfig>) {
  if (!cfg.adminEmail || !cfg.adminPassword) { console.warn("ADMIN_EMAIL/ADMIN_PASSWORD not set: no admin will be created."); return; }
  if (cfg.adminPassword.length < 10) throw new Error("ADMIN_PASSWORD must be at least 10 characters.");
  const exists = await q("SELECT 1 FROM users WHERE role='admin' LIMIT 1");
  if (exists.rowCount) return; // never overwrite an existing admin from env on later boots
  await q("INSERT INTO users(email,password_hash,role,display_name,bot_quota) VALUES ($1,$2,'admin','Admin',50) ON CONFLICT (email) DO UPDATE SET role='admin'", [cfg.adminEmail, await hashPassword(cfg.adminPassword)]);
  console.log(`Initial admin created: ${cfg.adminEmail}`);
}

async function main() {
  const cfg = loadConfig();
  initPool(cfg.databaseUrl, cfg.sslDb);
  await migrate(join(here, "..", "..", "migrations"));
  await ensureAdmin(cfg);
  const runtime = await RenderRuntime.tryCreate();
  const avail = await runtime.available();
  console.log(avail.ok ? "Render Sandboxes: available" : `Render Sandboxes: DISABLED — ${avail.reason}`);
  const engine = new Engine(cfg, runtime);
  await engine.boot();

  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", "data:"], connectSrc: ["'self'"] } } }));
  app.use(rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: true, legacyHeaders: false }));
  app.use(cookieParser());
  app.use(express.json({ limit: "3mb" }));
  app.use(loadUser);
  app.use("/api", csrfGuard);

  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.get("/api/runtime", (req, res, next) => (req.user ? runtime.available().then((a) => res.json(a)).catch(next) : res.status(401).json({ error: "Please sign in." })));
  app.use("/api/auth", authRoutes(cfg));
  app.use("/api/bots/:id/files", fileRoutes());
  app.use("/api/bots/:id/logs", logRoutes(cfg.logPollSeconds));
  app.use("/api/bots", botRoutes(cfg, engine));
  app.use("/api/deployments", deploymentRoutes());
  app.use("/api/admin", adminRoutes(cfg, engine));
  app.use("/api", (_req, res) => res.status(404).json({ error: "Not found." }));

  const web = join(here, "..", "..", "frontend", "dist");
  if (existsSync(web)) {
    app.use(express.static(web, { index: false, maxAge: "1h" }));
    app.get("*", (_req, res) => res.sendFile(join(web, "index.html")));
  }
  app.use(errorHandler);
  const server = app.listen(cfg.port, () => console.log(`Majid Bot Manager listening on :${cfg.port}`));
  const shutdown = () => { engine.stop(); server.close(() => process.exit(0)); };
  process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
}
main().catch((e) => { console.error(e); process.exit(1); });
