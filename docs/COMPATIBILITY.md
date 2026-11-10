# Feature compatibility & status

Legend: ✅ implemented and covered by tests that were run · 🟡 implemented, NOT executed in this build environment (needs your deploy to verify) · ⚠ limitation

| Feature | Status | Notes |
|---|---|---|
| ZIP validation (traversal, symlink, bomb, CRC, limits) | ✅ | 10+ unit tests run |
| Language/entry/manifest detection (Python, Node, PHP) | ✅ | content-based; ambiguity rejected |
| requirements.txt validation | ✅ | blocks index overrides, URLs, VCS, paths |
| Token/secret encryption (AES-256-GCM), password hashing | ✅ | scrypt used instead of Argon2id/bcrypt (see limitations) |
| Deployment pipeline against a fake runtime | ✅ | success, crash, build error, missing tool, disabled runtime, redeploy, stop/force-kill |
| Real Render Sandbox calls (`RenderRuntime`) | 🟡 | written from the official TS SDK docs; first real run is yours |
| Express API, RBAC, CSRF, sessions, quotas | 🟡 | type-checked only partly; integration tests in `backend/tests/api.integration.test.ts` need a live server |
| PostgreSQL migration | 🟡 | not executed here (no Postgres available) |
| React/Tailwind UI | 🟡 | not built here (no npm registry access) |
| Start/Stop/Restart/Rebuild/Redeploy/Delete/Free | 🟡 | call real runtime; process state read via `kill -0` |
| File manager (browse/edit/create/rename/delete/upload/download) | 🟡 | operates on Postgres rows; traversal blocked by `safeRelPath` (✅ unit-tested) |
| Change bot token (also while running; restarts the bot) | 🟡 | verified with getMe; new token pushed to the sandbox before start |
| Logs: stdout/stderr/build/system, filter, persistence, SSE | 🟡 | near-live (poll interval), not raw streaming |
| Admin / sub-admin permissions, audit log, kill switch | 🟡 | enforced server-side |
| Cost dashboard | ⚠ | **estimate only**; Render exposes no remaining-credit API I could verify |
| Python/Node/PHP availability inside sandbox image | ⚠ | unverified; the pipeline checks and fails with a clear message. Run the sample bot first |
| Bangla / English interface (toggle in menu) | 🟡 | all UI text translated; server error messages only if listed in `frontend/src/i18n.ts` |
| Bot data persistence (`DATA_DIR`, ≤ 10 MB, saved on stop/redeploy + every 10 min) | 🟡 | export/restore logic unit-tested with a fake runtime; real tar round-trip via Render `download`/`upload` not yet run |
| Webhook bridge (Python, inside sandbox) | ✅/🟡 | bridge program run for real against a mock Telegram + local bot server (✅); sandbox integration 🟡 |
| Runtime check (Admin → Overview) | 🟡 | tells you for certain which of python3/pip/venv/node/npm/php/composer exist |
| Render Persistent Disk | — | intentionally not used |
| Background Worker | — | not required |

## Known limitations
1. **Sandbox image tools unverified** (use Admin → Overview → "Run check" to find out). If `python3`, `node`, `php` or `composer` are missing, deployment fails at "checking" with a clear error.
2. **Always-on is expensive** (see COSTS.md). Sandboxes are beta; Render may change behavior/pricing.
3. **No lockfile shipped.** The npm registry was unreachable when this was built; Render's build runs `npm install`. Commit the generated `package-lock.json` afterwards and switch the build command to `npm ci`.
4. **Password hashing is scrypt**, not Argon2id/bcrypt (Node 22 has no built-in Argon2; I could not install and test a native module). It is memory-hard and OWASP-listed; swap `hashPassword/verifyPassword` if you prefer.
5. **Egress allow-list** is HTTPS-domain based; bots calling other APIs need those domains added in bot Settings.
6. **Single web instance.** The queue/collector run in the web process; do not scale to multiple instances without adding leader election.
7. Project files are stored in Postgres (100 MB each; `node_modules`/`.venv` are never stored — they're installed in the sandbox each deploy).
8. Sandbox max lifetime/limits can change; check https://render.com/docs/sandboxes-limits.
9. **Data persistence is best-effort:** a sudden sandbox crash loses data written since the last save (≤ 10 min). Kill switch does not save data. Data over 10 MB is not saved.
10. **Webhook bridge** supports bots that accept a local HTTP POST of the update JSON; bots needing MySQL/`.htaccess`/a public domain still will not run.
