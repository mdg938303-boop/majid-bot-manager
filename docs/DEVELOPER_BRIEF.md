# Bot hosting requirements (give this to your bot developer)

**Deliver** one `.zip` (< 25 MB, < 5000 files). Files at the ZIP root (or inside one single folder). Do NOT include `node_modules`, `.venv`, `vendor`, `.git`.

**Language / entry point** (one language only):
- Python (recommended): `main.py` or `bot.py` (or `app.py`) + `requirements.txt` (plain `package==version` lines; no `-r`, `--index-url`, `git+https://`, local paths).
- Node.js: `package.json` (+ `package-lock.json` if possible); `npm start` or `index.js` / `bot.js`.
- PHP: `index.php` or `bot.php` (+ `composer.json` if needed).
- Which of Python / Node / PHP the sandbox really supports: ask the platform owner to run **Admin → Overview → "Run check"**.

**Token:** never hard-code it. Read `BOT_TOKEN` from the environment (`TELEGRAM_BOT_TOKEN` / `TELEGRAM_TOKEN` hold the same value). Other secrets: tell the owner the variable names; they go in the bot's *Variables* tab.

**Receiving updates — pick ONE:**
1. **Long polling (default, simplest):** call `deleteWebhook` once, then loop on `getUpdates`. The process must never exit.
2. **Webhook-style bot:** the bot runs a small HTTP server on `0.0.0.0:$PORT` (path from `WEBHOOK_PATH`, default `/`). The platform runs a bridge inside the sandbox that forwards Telegram updates to `http://127.0.0.1:$PORT$WEBHOOK_PATH` as JSON POSTs (same body Telegram sends). If `TELEGRAM_WEBHOOK_SECRET` is set as a variable, it is sent in the `X-Telegram-Bot-Api-Secret-Token` header. **The bot must NOT call `setWebhook`.** The owner enables this in the bot's *Settings → Webhook mode*. Needs `python3` in the sandbox (the bridge is Python).

**Persistent data:** the sandbox disk is ephemeral. Files written to `$DATA_DIR` (a `data/` folder next to your code) are saved to the platform database when the bot stops/redeploys and every 10 minutes (max 10 MB), and restored on the next deploy. For anything larger or critical (orders, balances), use an external hosted database and give the owner its domain (it must be added to the bot's allowed websites).

**Network:** the sandbox can only reach Telegram, PyPI, npm, Packagist and GitHub over HTTPS, plus domains the owner adds to the bot. There is no MySQL, no inbound public URL.

**Runtime:** 1 CPU / 2 GB RAM, one long-running process, logs to stdout/stderr (`python -u`; never print the token). Handle `SIGTERM` gracefully.

**Test before delivery:** `BOT_TOKEN=<test token> DATA_DIR=./data python main.py`.
