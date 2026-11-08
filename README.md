# Majid Bot Manager V2

Multi-bot Telegram hosting/management platform for **Render + GitHub only** (no VPS). Node 22 + TypeScript + Express,
PostgreSQL, React + Tailwind, and **Render Sandboxes** (official `@renderinc/sdk`) to run user bots in isolation.

> **Read first:** [docs/COSTS.md](docs/COSTS.md) — one always-on bot ≈ $43–50/month. · [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) — what was and was not executed in the build environment.
> Bangla Android guide: [docs/INSTALL_BN.md](docs/INSTALL_BN.md) · Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Layout
```
backend/src   config, db, middleware (auth/RBAC/CSRF), routes, services (engine, deployer), sandbox (runtime + Render SDK), lib (crypto, zip, detect, paths, tar)
backend/tests core unit tests + fake runtime + API integration tests
frontend/     Vite + React + TS + Tailwind (mobile-first, dark/light)
migrations/   001_init.sql (users, roles, permissions, bots, projects, project_files, deployments, sandbox_instances,
              environment_variables, logs, audit_logs, system_settings, sessions)
examples/     sample-bot.zip (stdlib-only echo bot)
render.yaml   web service + Postgres blueprint
```

## Run locally
```
cp .env.example .env     # fill in values; export them (or use your shell's env loader)
npm install --include=dev && npm run build && npm start
npm test                 # core tests (no DB/network needed)
API_BASE_URL=http://localhost:3000 TEST_ADMIN_EMAIL=… TEST_ADMIN_PASSWORD=… npm run test:api   # integration tests
```

## Security summary
Hashed passwords (scrypt), HttpOnly/SameSite/Secure session cookies (tokens stored hashed), CSRF token + Origin check, rate limits +
lockout, parameterised SQL only, AES-256-GCM for bot tokens and env values (never returned after saving), hardened ZIP reader,
per-bot path sandboxing, RBAC enforced server-side, audit log, per-user quotas, global sandbox cap, kill switch, sandbox egress
allow-list, and no platform secrets ever sent into sandboxes.
