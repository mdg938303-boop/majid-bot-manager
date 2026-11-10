/**
 * Webhook bridge. Sandboxes have no public URL, so Telegram cannot call a bot directly.
 * This small stdlib-only Python program runs INSIDE the sandbox next to the bot: it long-polls Telegram
 * (getUpdates) and POSTs every update to the bot's local web server, exactly like a webhook delivery.
 */
export const BRIDGE_PY = String.raw`import json, os, time, urllib.request, urllib.error, urllib.parse

TOKEN = os.environ["BOT_TOKEN"]
PORT = os.environ.get("PORT", "8080")
PATH = os.environ.get("WEBHOOK_PATH", "/") or "/"
SECRET = os.environ.get("TELEGRAM_WEBHOOK_SECRET", "")
BASE = os.environ.get("TELEGRAM_API_BASE", "https://api.telegram.org").rstrip("/") + "/bot" + TOKEN
TARGET = "http://127.0.0.1:%s%s" % (PORT, PATH if PATH.startswith("/") else "/" + PATH)


def log(msg):
    print("[bridge] " + str(msg).replace(TOKEN, "***"), flush=True)


def api(method, params=None, timeout=40):
    data = urllib.parse.urlencode(params or {}).encode()
    req = urllib.request.Request(BASE + "/" + method, data=data)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def deliver(update):
    body = json.dumps(update).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if SECRET:
        headers["X-Telegram-Bot-Api-Secret-Token"] = SECRET
    for _ in range(60):
        try:
            req = urllib.request.Request(TARGET, data=body, headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=30) as r:
                r.read()
            return True
        except urllib.error.HTTPError as e:
            log("bot answered HTTP %s for update %s; skipping it" % (e.code, update.get("update_id")))
            return False
        except Exception:
            time.sleep(1)  # the bot is not listening yet
    log("bot never accepted update %s; skipping it" % update.get("update_id"))
    return False


def main():
    try:
        api("deleteWebhook", {"drop_pending_updates": "false"})
    except Exception as e:
        log("deleteWebhook failed: %s" % e)
    log("forwarding Telegram updates to " + TARGET)
    offset = 0
    while True:
        try:
            res = api("getUpdates", {"timeout": 25, "offset": offset})
            for u in res.get("result", []):
                deliver(u)
                offset = u["update_id"] + 1
        except urllib.error.HTTPError as e:
            if e.code == 409:
                log("a webhook is set on this bot; removing it so updates can be received")
                try:
                    api("deleteWebhook", {})
                except Exception:
                    pass
            else:
                log("getUpdates HTTP %s" % e.code)
            time.sleep(3)
        except Exception as e:
            log("getUpdates error: %s" % e)
            time.sleep(3)


main()
`;
