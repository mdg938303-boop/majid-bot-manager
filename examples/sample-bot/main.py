"""Minimal echo bot using only the Python standard library (no dependencies to install)."""
import json, os, time, urllib.parse, urllib.request

TOKEN = os.environ["BOT_TOKEN"]
API = f"https://api.telegram.org/bot{TOKEN}"

def call(method, **params):
    data = urllib.parse.urlencode(params).encode()
    with urllib.request.urlopen(urllib.request.Request(f"{API}/{method}", data=data), timeout=60) as r:
        return json.load(r)

print("Bot started. Waiting for messages…", flush=True)
offset = 0
while True:
    try:
        for u in call("getUpdates", timeout=30, offset=offset).get("result", []):
            offset = u["update_id"] + 1
            m = u.get("message") or {}
            if "text" in m:
                print("message from", m["chat"]["id"], flush=True)
                call("sendMessage", chat_id=m["chat"]["id"], text="Echo: " + m["text"])
    except Exception as e:
        print("error:", e, flush=True)
        time.sleep(5)
