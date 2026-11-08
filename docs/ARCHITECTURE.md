# Architecture

```
Android browser ──HTTPS──▶ Render Web Service (Express + React build)
                              │  │
                              │  └─ Render Postgres: users, sessions, bots (tokens AES-256-GCM encrypted),
                              │     project_files (source of truth), deployments, logs, audit_logs, settings
                              │
                              └─ Render Sandboxes SDK (@renderinc/sdk) ──▶ one sandbox per bot
                                   • create (idleTimeoutSeconds:0, timeoutSeconds:0, network allow-list)
                                   • upload tar of project + .bot.env, exec install/build, exec start
                                   • exec "kill -0 pid" for real status, exec "tail -c +N" for logs
```

**Why this shape (verified against Render docs):** sandboxes have no private network to your database and no public URLs,
so the control plane *pushes* everything in (`upload`/`exec`) and *pulls* logs out (`exec`). The sandbox never receives
`DATABASE_URL`, `RENDER_API_KEY` or `ENCRYPTION_KEY`; only the bot's own token and its own env vars.

**Persistence:** sandboxes are ephemeral. Project files live in Postgres (`project_files`, 100 MB/project cap), so no paid
Persistent Disk is needed. Logs are copied into Postgres by a collector every `LOG_POLL_SECONDS` (default 5s), so they survive
sandbox termination. "Live" console = SSE over those stored rows, i.e. near-live (poll delay), not a raw process stream.

**Deployment pipeline** (`backend/src/services/deployer.ts`): provision → upload → tool check → install → build → start →
verify process alive. A deployment is marked *succeeded* only if `kill -0 <pid>` is true after the start wait. On any failure the
sandbox is terminated (no silent charges) and the real command output is kept in logs.

**ZIP handling:** parsed by the control plane with a hardened reader (no code execution): size/entry/ratio limits, traversal,
absolute/backslash paths, symlinks/special files, encrypted/ZIP64 rejection, CRC + declared-size checks, duplicate detection.
Validated files are re-packed as tar and extracted inside the sandbox. Uploaded code is never run on the dashboard server.

**Queue:** DB-backed (`deployments.status='queued'`), processed one at a time by the web process using `FOR UPDATE SKIP LOCKED`.
On restart, in-flight deployments are marked failed (honest) instead of resumed. A separate Background Worker is not needed.

**Auth:** random session token (stored hashed) in an HttpOnly, SameSite=Lax, Secure cookie; per-session CSRF token header +
Origin check; scrypt (N=2^16) password hashes; login rate limit + account lockout; RBAC enforced in route middleware.

**Stop vs. cost:** a stopped bot's sandbox still bills. Stopped/failed sandboxes are auto-released after `auto_release_minutes`
(default 30). "Free sandbox" releases immediately. Starting a released bot redeploys (re-installs dependencies).
