# Cost estimate (read before deploying)

Sandbox rates below come from third-party summaries of Render's pricing, **not** from Render's own pricing page, which I could not
load. Confirm at https://render.com/pricing before relying on them. Credits may not apply to every product — check your account.

| Item | Estimate / month |
|---|---|
| Web service `starter` | ≈ $7 |
| Postgres `basic-256mb` | ≈ $6 |
| 1 always-on bot, sandbox `1c-2g`: memory ≈ $0.038/h × 730 h | ≈ $28 |
| …plus active CPU ≈ $0.12 per active CPU-hour (a mostly idle bot: ~2–10% active) | ≈ $2–9 |
| **Total with ONE always-on bot** | **≈ $43–50** |

**So $50 of credit lasts roughly one month with a single always-on bot. Two bots will not fit.** The defaults protect you:
max 1 concurrent sandbox, 1 bot per user, auto-release of stopped sandboxes after 30 min, only `1c-2g` allowed, admin kill switch.

Cheaper options: stop and *Free sandbox* when not testing; delete the web service/DB when finished; the free Postgres tier expires and
is not suitable. The in-app cost card is an estimate from sandbox uptime in this platform's own records; it is not your bill and never
shows remaining credit. Nothing in this project upgrades a plan or authorises spending.

## Reducing usage (built in)
`max_run_hours` (Admin → system, default **8**, 0 = off) terminates any sandbox that has been alive that long. Press **Start** to run it again
(it redeploys). Approximate monthly totals with the fixed ≈ $13 (web + database) included, sandbox memory ≈ $0.038/h plus a little CPU:

| Bot runs | Estimate |
|---|---|
| 24 h/day | ≈ $43–50 |
| 8 h/day | ≈ $23–25 |
| 4 h/day | ≈ $19 |

These are estimates from unverified third-party rates; the Render Billing page is the only source of truth.
