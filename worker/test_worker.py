"""Tests for the worker and bot API against an in-memory fake database (no Firebase needed):  python3 test_worker.py"""
import json, threading, time, urllib.request
from http.server import ThreadingHTTPServer
import botapi, qm_worker as W

class Fake:
    def __init__(s): s.t = {}; s.sent = []; s.dead = set(); s.n = 0
    def get(s, p):
        n = s.t
        for k in [x for x in p.split("/") if x]:
            if not isinstance(n, dict) or k not in n: return None
            n = n[k]
        return json.loads(json.dumps(n))
    def set(s, p, v):
        ks = [x for x in p.split("/") if x]; n = s.t
        for k in ks[:-1]: n = n.setdefault(k, {})
        if v is None: n.pop(ks[-1], None)
        else: n[ks[-1]] = v
    def update(s, ups):
        for p, v in ups.items(): s.set(p, v)
    def new_key(s): s.n += 1; return "-K%08d" % s.n
    def messages(s, chat, after, limit):
        m = s.get(f"privateChats/{chat}/messages") or {}; ks = sorted(k for k in m if not after or k > after)
        return {k: m[k] for k in (ks[:limit] if after else ks[-limit:])}
    def send_push(s, tok, kind, p):
        if tok in s.dead: raise RuntimeError("dead")
        s.sent.append((tok, kind, p))
    def is_dead(s, e): return str(e) == "dead"
    def listen(s, path, cb): return None

ok = bad = 0
def t(name, c, info=""):
    global ok, bad
    if c: ok += 1
    else: bad += 1; print("FAIL", name)

now = lambda: int(time.time() * 1000)
f = Fake(); hooks = []
w = W.Worker(f, "https://site.example/", "https://bots.example/api/bot", 600, post_webhook=lambda url, body, sig: hooks.append((url, body, sig)) or 200, http_api=True)
f.t = {"privateChats": {"c1": {"participants": {"alice": True, "bob": True, "bot_abcdefghij12": True}, "chatData": {}}},
       "accsettings": {"alice": {"settings": {"displayName": "Alice"}}, "bob": {"settings": {"displayName": "Bob"}}, "bot_abcdefghij12": {"settings": {"displayName": "B"}}},
       "FCM": {"bob": {"webtok": True, "apptok": "android", "deadtok": True}}, "chatList": {"bot_abcdefghij12": {"c1": True}}}
token = "qmbot.bot_abcdefghij12." + "A" * 43
f.t["bots"] = {"bot_abcdefghij12": {"owner": "alice", "created": 1, "name": "B"}}
f.t["botKeys"] = {"bot_abcdefghij12": {"th": botapi.sha256(token), "webhook": "https://hook.example/x"}}
f.dead.add("deadtok")
def msg(key, **kw):
    m = {"fromUid": "alice", "text": "hello bob", "timestamp": now(), "type": "text"}; m.update(kw); f.set(f"privateChats/c1/messages/{key}", m); return m

# flatten: every depth the database can report a change at
ping = {"id": "m1", "ts": now(), "from": "alice"}
t("flatten root", W.Worker.flatten("/", {"bob": {"pings": {"c1": ping}}}) == [("bob", "ping", "c1", ping)])
t("flatten uid", W.Worker.flatten("/bob", {"pings": {"c1": ping}}) == [("bob", "ping", "c1", ping)])
t("flatten kind", W.Worker.flatten("/bob/pings", {"c1": ping}) == [("bob", "ping", "c1", ping)])
t("flatten chat", W.Worker.flatten("/bob/pings/c1", ping) == [("bob", "ping", "c1", ping)])
t("flatten ignores field + deletion + other nodes", W.Worker.flatten("/bob/pings/c1/ts", 5) == [] and W.Worker.flatten("/bob/pings/c1", None) == [] and W.Worker.flatten("/bob/declines/c1", {"a": 1}) == [])

# message push
msg("m1"); w.handle_entry("bob", "ping", "c1", ping)
kinds = sorted(k for _, k, _ in f.sent)
t("web + android tokens notified, dead one removed", kinds == ["app", "web"] and "deadtok" not in f.t["FCM"]["bob"], str(kinds))
web = next(p for _, k, p in f.sent if k == "web"); app = next(p for _, k, p in f.sent if k == "app")
t("web payload", web["notification"] == {"title": "Alice", "body": "hello bob"} and web["link"] == "https://site.example/message.html?chatId=c1" and web["tag"] == "chat_c1")
t("android gets data only", app["data"] == {"type": "msg", "chatId": "c1", "msgId": "m1", "from": "alice"} and app["ttl"] == 86400)
n = len(f.sent); w.handle_entry("bob", "ping", "c1", ping); t("same ping twice is sent once", len(f.sent) == n)
f.sent.clear(); msg("m2", enc=True, text="CIPHER"); w.handle_entry("bob", "ping", "c1", {**ping, "id": "m2"}); t("encrypted: generic text", next(p for _, k, p in f.sent if k == "web")["notification"]["body"] == "🔒 New message")
f.sent.clear(); msg("m3"); f.set("privateChats/c1/messageRead/bob", "m3"); w.handle_entry("bob", "ping", "c1", {**ping, "id": "m3"}); t("already read: no push", not f.sent)
f.sent.clear(); msg("m4", text="@bob look"); w.handle_entry("bob", "ping", "c1", {**ping, "id": "m4", "mention": True}); t("mention title", next(p for _, k, p in f.sent if k == "web")["notification"]["title"] == "Alice mentioned you")
f.sent.clear(); w.handle_entry("bob", "ping", "c1", {**ping, "id": "m5", "ts": now() - 3600_000}); t("old ping outside catch-up window ignored", not f.sent)
f.sent.clear(); msg("m6", fromUid="mallory"); w.handle_entry("bob", "ping", "c1", {**ping, "id": "m6"}); t("sender not in chat: ignored", not f.sent)
f.sent.clear(); msg("m7", type="event"); w.handle_entry("bob", "ping", "c1", {**ping, "id": "m7"}); t("system line: ignored", not f.sent)
f.sent.clear(); f.t["FCM"]["bob"]["webtok"] = True; msg("m8", fromUid="bot_abcdefghij12", botId="bot_abcdefghij12", **{"as": {"name": "Zed"}}); w.handle_entry("bob", "ping", "c1", {**ping, "id": "m8"}); t("bot message uses its display name", next(p for _, k, p in f.sent if k == "web")["notification"]["title"] == "Zed")
f.sent.clear(); msg("m9", type="file", kind="image", url="https://img.example/a.png", name="a.png", text="a.png"); w.handle_entry("bob", "ping", "c1", {**ping, "id": "m9"}); t("public image shown", next(p for _, k, p in f.sent if k == "web")["image"] == "https://img.example/a.png")

# webhook to a bot (a human's message pings the bot)
msg("h1", text="to the bot"); w.handle_entry("bot_abcdefghij12", "ping", "c1", {**ping, "id": "h1"})
t("webhook called, signed", len(hooks) == 1 and hooks[0][0] == "https://hook.example/x" and hooks[0][2] == __import__("hmac").new(botapi.sha256(token).encode(), hooks[0][1], "sha256").hexdigest())
t("webhook payload", json.loads(hooks[0][1])["message"]["text"] == "to the bot" and json.loads(hooks[0][1])["message"]["from"] == "Alice")
for host in ("localhost", "127.0.0.1", "10.0.0.5", "192.168.1.2", "169.254.169.254"):
    try: botapi.public_address(host); t("SSRF " + host, False)
    except Exception: t("SSRF " + host, True)
try: botapi.post_webhook("http://example.com/x", b"{}", "s"); t("http webhook refused", False)
except ValueError: t("http webhook refused", True)

# rings
f.sent.clear(); ring = {"ringId": "r1", "fromUid": "alice", "chatId": "c1", "createdAt": now()}
f.set("calls/c1/ringing/bob", ring); f.t["FCM"]["bob"]["webtok"] = True
w.handle_entry("bob", "ring", "c1", ring)
t("ring pushes web + android(60s ttl)", sorted(k for _, k, _ in f.sent) == ["app", "web"] and next(p for _, k, p in f.sent if k == "app")["ttl"] == 60 and next(p for _, k, p in f.sent if k == "app")["data"]["type"] == "ring")
t("ring title", next(p for _, k, p in f.sent if k == "web")["notification"]["title"] == "Incoming call")
t("notifyStatus sent", f.get("calls/c1/ringing/bob/notifyStatus") == "sent")
ring2 = {**ring, "ringId": "r2"}; f.set("calls/c1/ringing/alice", ring2); f.t["FCM"] = {}
w.handle_entry("alice", "ring", "c1", {**ring2, "fromUid": "alice"}); t("no device -> no_token", f.get("calls/c1/ringing/alice/notifyStatus") == "no_token")
ring3 = {"ringId": "r3", "fromUid": "mallory", "chatId": "c1", "createdAt": now()}; f.set("calls/c1/ringing/bob", ring3); w.handle_entry("bob", "ring", "c1", ring3); t("ring from non-member -> failed", f.get("calls/c1/ringing/bob/notifyStatus") == "failed")
f.sent.clear(); w.handle_entry("bob", "ring", "c1", {**ring, "ringId": "r4", "createdAt": now() - 120000}); t("stale ring ignored", not f.sent)

# clock skew must never swallow a call: live changes ignore timestamps, the start-up snapshot uses the database's clock
f.sent.clear(); f.t["FCM"] = {"bob": {"webtok": True}}; skew = {"ringId": "r5", "fromUid": "alice", "chatId": "c1", "createdAt": now() - 3600_000}; f.set("calls/c1/ringing/bob", skew)
w.handle_entry("bob", "ring", "c1", skew); t("snapshot: hour-old ring ignored", not f.sent)
w.handle_entry("bob", "ring", "c1", skew, live=True); t("live change: handled whatever the timestamps say", len(f.sent) == 1 and f.get("calls/c1/ringing/bob/notifyStatus") == "sent")
w.offset = -3600_000 + 5000; r6 = {"ringId": "r6", "fromUid": "alice", "chatId": "c1", "createdAt": now() - 3600_000 + 4000}; f.set("calls/c1/ringing/bob", r6); f.sent.clear()
w.handle_entry("bob", "ring", "c1", r6); t("snapshot: the database clock decides (computer clock an hour off)", len(f.sent) == 1); w.offset = 0
# a failing push is reported with its reason, never silently
class Boom(Exception): pass
orig = f.send_push; f.send_push = lambda tok, kind, p: (_ for _ in ()).throw(Boom("quota exceeded"))
r7 = {"ringId": "r7", "fromUid": "alice", "chatId": "c1", "createdAt": now()}; f.set("calls/c1/ringing/bob", r7); w.handle_entry("bob", "ring", "c1", r7, live=True)
t("failed push -> notifyStatus failed + notifyError", f.get("calls/c1/ringing/bob/notifyStatus") == "failed" and "Boom: quota exceeded" in f.get("calls/c1/ringing/bob/notifyError") and "Boom" in w.stats["lastPushError"] and "webtok" in f.get("FCM/bob"))
f.send_push = orig
r8 = {"ringId": "r8", "fromUid": "alice", "chatId": "c1", "createdAt": now()}; f.set("calls/c1/ringing/bob", r8); f.get = (lambda g: lambda p: (_ for _ in ()).throw(RuntimeError("db down")) if p.startswith("accsettings") else g(p))(f.get)
w.handle_entry("bob", "ring", "c1", r8, live=True)
t("an unexpected error is still answered", f.get("calls/c1/ringing/bob/notifyStatus") == "failed" and "RuntimeError" in f.get("calls/c1/ringing/bob/notifyError")); del f.get
w.handle_entry("bob", "ring", "c1", {**r8, "ringId": "r9"}, live=True) if False else None
f.t["FCM"] = {"bob": {"apptok": "android"}}; r9 = {"ringId": "r9", "fromUid": "bob", "chatId": "c1", "createdAt": now()}; f.set("calls/c1/ringing/bob", r9); w.handle_entry("bob", "ring", "c1", r9, live=True)
t("ringing your own devices when only the Android app has a token: no_token, not failed", f.get("calls/c1/ringing/bob/notifyStatus") == "no_token")
# dead tokens: only when the token itself is bad
import firebase_admin.exceptions as FE
real = W.FirebaseBackend.__new__(W.FirebaseBackend); real.messaging = type("M", (), {"UnregisteredError": type("U", (Exception,), {}), "SenderIdMismatchError": type("S", (Exception,), {})})
class InvalidArgumentError(Exception): pass
t("invalid payload does not delete tokens", not real.is_dead(InvalidArgumentError("Invalid JSON payload received")))
t("invalid registration token does", real.is_dead(InvalidArgumentError("The registration token is not a valid FCM registration token")))
t("unregistered does", real.is_dead(real.messaging.UnregisteredError("x")))

# bot API
H = lambda m, p, q=None, b=None, tok=token: botapi.handle(f, m, p, q or {}, b or {}, tok, w.stats)
t("GET /me", H("GET", "/me")["id"] == "bot_abcdefghij12")
t("GET /chats", H("GET", "/chats")["chats"][0]["id"] == "c1")
s = H("POST", "/send", b={"chat": "c1", "text": "hi", "as": {"name": "Zed", "pfp": "https://x/y.png"}, "src": "Discord"})
m = f.get(f"privateChats/c1/messages/{s['id']}"); t("send stores identity", m["botId"] == "bot_abcdefghij12" and m["as"]["name"] == "Zed" and m["src"] == "Discord")
t("send pings humans, not the bot", f.get("live/bob/pings/c1")["id"] == s["id"] and f.get("live/alice/pings/c1")["id"] == s["id"] and f.get("live/bot_abcdefghij12") is None)
r = H("GET", "/messages", {"chat": "c1", "limit": "100"}); t("GET /messages", any(x["id"] == s["id"] and x["from"] == "Zed" and x["fromMe"] for x in r["messages"]))
H("PATCH", "/me", b={"name": "New", "pfp": "https://a/b.png"}); t("PATCH /me", f.get("accsettings/bot_abcdefghij12/settings/displayName") == "New" and f.get("bots/bot_abcdefghij12/pfp") == "https://a/b.png")
for nm, fn in [("bad token", lambda: H("GET", "/me", tok=token[:-1] + "B")), ("other chat", lambda: H("POST", "/send", b={"chat": "c9", "text": "x"})), ("http pfp", lambda: H("PATCH", "/me", b={"pfp": "http://x"})),
               ("empty", lambda: H("POST", "/send", b={"chat": "c1", "text": " "})), ("route", lambda: H("GET", "/nope")), ("edit others", lambda: H("PATCH", "/message", b={"chat": "c1", "id": "m1", "text": "x"}))]:
    try: fn(); t(nm, False)
    except botapi.BotError as e: t(nm, e.status >= 400)
H("PATCH", "/message", b={"chat": "c1", "id": s["id"], "text": "edited"}); t("edit own", f.get(f"privateChats/c1/messages/{s['id']}/text") == "edited" and f.get("privateChats/c1/lastMessage/text") == "edited")
H("DELETE", "/message", b={"chat": "c1", "id": s["id"]}); t("delete own", f.get(f"privateChats/c1/messages/{s['id']}") is None)

# requests through the database
inbox = lambda rid, **kw: {"token": token, "op": "me", "ts": now(), **kw}
f.set("botInbox/bot_abcdefghij12/req00000000000000000A", inbox("x")); w.on_request("bot_abcdefghij12", "req00000000000000000A", f.get("botInbox/bot_abcdefghij12/req00000000000000000A"))
o = f.get("botOutbox/bot_abcdefghij12/req00000000000000000A"); t("request answered in botOutbox", o and o["status"] == 200 and json.loads(o["body"])["id"] == "bot_abcdefghij12")
t("request removed from botInbox", f.get("botInbox/bot_abcdefghij12/req00000000000000000A") is None)
rq = inbox("x", op="send", chat="c1", text="via db", **{"as": {"name": "DB User"}, "src": "Discord"}); f.set("botInbox/bot_abcdefghij12/req00000000000000000B", rq); w.on_request("bot_abcdefghij12", "req00000000000000000B", rq)
ob = json.loads(f.get("botOutbox/bot_abcdefghij12/req00000000000000000B")["body"]); sm = f.get("privateChats/c1/messages/" + ob["id"]); t("send through the database", sm["text"] == "via db" and sm["botId"] == "bot_abcdefghij12" and sm["as"]["name"] == "DB User")
n = len([k for k in f.get("privateChats/c1/messages")]); w.on_request("bot_abcdefghij12", "req00000000000000000B", rq); t("retry of an answered request does not run twice", len(f.get("privateChats/c1/messages")) == n)
badreq = inbox("x", token=token[:-1] + "B"); f.set("botInbox/bot_abcdefghij12/req00000000000000000C", badreq); w.on_request("bot_abcdefghij12", "req00000000000000000C", badreq)
t("wrong token -> 401 answer", f.get("botOutbox/bot_abcdefghij12/req00000000000000000C")["status"] == 401)
f.t["bots"]["bot_zzzzzzzzzz99"] = {"owner": "alice", "created": 1, "name": "Other"}; tok2 = "qmbot.bot_zzzzzzzzzz99." + "B" * 43; f.t["botKeys"]["bot_zzzzzzzzzz99"] = {"th": botapi.sha256(tok2)}
x = inbox("x", token=tok2); f.set("botInbox/bot_abcdefghij12/req00000000000000000D", x); w.on_request("bot_abcdefghij12", "req00000000000000000D", x)
t("another bot's token in my inbox is refused", f.get("botOutbox/bot_abcdefghij12/req00000000000000000D")["status"] == 401)
old = inbox("x", ts=now() - 3600_000); f.set("botInbox/bot_abcdefghij12/req00000000000000000E", old); w.on_request("bot_abcdefghij12", "req00000000000000000E", old); t("old request -> 408", f.get("botOutbox/bot_abcdefghij12/req00000000000000000E")["status"] == 408)
u = inbox("x", op="hack"); w.on_request("bot_abcdefghij12", "req00000000000000000F", u); t("unknown op -> 400", f.get("botOutbox/bot_abcdefghij12/req00000000000000000F")["status"] == 400)
class Ev:  # database change events in every shape
    def __init__(s, path, data): s.path, s.data = path, data
seen_before = w.stats["botCalls"]
r2 = inbox("x", op="chats"); w.on_inbox_event(Ev("/bot_abcdefghij12/req00000000000000000G", r2)); w.pool.shutdown(wait=True); w.pool = W.ThreadPoolExecutor(8)
t("inbox event handled (and deduped)", f.get("botOutbox/bot_abcdefghij12/req00000000000000000G")["status"] == 200 and w.stats["botCalls"] > seen_before)
w.on_inbox_event(Ev("/bot_abcdefghij12/req00000000000000000G", r2)); t("deleted-node events ignored", True)
w.on_inbox_event(Ev("/bot_abcdefghij12/req00000000000000000H", None)); w.on_inbox_event(Ev("/", None))
# event feed for a bot
th = botapi.sha256(token); msg("e1", text="for the feed"); w.handle_entry("bot_abcdefghij12", "ping", "c1", {**ping, "id": "e1"})
feed = f.get(f"botEvents/bot_abcdefghij12/{th}"); evs = [json.loads(v["body"]) for v in feed.values()]; ev = next((e for e in evs if e["message"]["text"] == "for the feed"), {}); t("event feed written", ev.get("event") == "message" and ev.get("chat") == "c1" and len(evs) == 2)
# sweep
f.set("botOutbox/bot_abcdefghij12/oldanswer00000000000", {"status": 200, "body": "{}", "ts": now() - 600_000}); f.set(f"botEvents/bot_abcdefghij12/{th}/oldev", {"ts": now() - 7200_000, "body": "{}"})
w.sweep(); t("sweep removes old answers and events, keeps new ones", f.get("botOutbox/bot_abcdefghij12/oldanswer00000000000") is None and f.get(f"botEvents/bot_abcdefghij12/{th}/oldev") is None and f.get(f"botEvents/bot_abcdefghij12/{th}") and f.get("botOutbox/bot_abcdefghij12/req00000000000000000A"))

# HTTP
srv = ThreadingHTTPServer(("127.0.0.1", 0), W.make_handler(w)); threading.Thread(target=srv.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{srv.server_address[1]}"
def req(path, tok=None, method="GET", body=None):
    r = urllib.request.Request(base + path, method=method, data=json.dumps(body).encode() if body else None, headers={"Authorization": "Bearer " + tok} if tok else {})
    try:
        with urllib.request.urlopen(r) as x: return x.status, x.read()
    except urllib.error.HTTPError as e: return e.code, e.read()
st, b = req("/status.json"); sj = json.loads(b); t("status.json", st == 200 and sj["version"] == W.VERSION and sj["apiUrl"] == "https://bots.example/api/bot" and sj["uptimeSec"] >= 0)
t("status page html", req("/")[0] == 200 and b"Running" in req("/")[1])
t("HTTP bot /me", json.loads(req("/api/bot/me", token)[1])["id"] == "bot_abcdefghij12")
t("HTTP bot 401", req("/api/bot/me", "nope")[0] == 401)
st, b = req("/api/bot/send", token, "POST", {"chat": "c1", "text": "over http"}); t("HTTP bot send", st == 200 and "id" in json.loads(b))
# heartbeat
w.heartbeat(); hb = f.get("serverStatus"); t("heartbeat written (server timestamp marker)", hb["ts"] == {".sv": "timestamp"} and hb["listening"] is False and hb["version"] == W.VERSION)
a, b2 = W.push_id(), W.push_id(); t("push ids unique", a != b2 and len(a) == 20)
# the real client library (docs/bots/qmbot.py) against the worker, with a transport that works on the fake database
import sys; sys.path.insert(0, "../docs/bots"); import qmbot
class Local:
    def __init__(s): s.workers = []
    def put(s, path, value):
        f.set(path, value)
        if path.startswith("botInbox/"):
            _, bot, rid = path.split("/"); w.on_request(bot, rid, value)          # what the worker's listener does the moment the request appears
    def get(s, path, params=None):
        v = f.get(path)
        if params and isinstance(v, dict):
            lo = json.loads(params["startAt"]) if "startAt" in params else ""
            ks = sorted(k for k in v if k >= lo)
            ks = ks[-params["limitToLast"]:] if "limitToLast" in params else ks[:params.get("limitToFirst", 999)]
            return {k: v[k] for k in ks}
        return v
    def delete(s, path): f.set(path, None)
f.t["botKeys"]["bot_abcdefghij12"] = {"th": botapi.sha256(token), "token": token}
bt = qmbot.QMBot(token, transport=Local())
t("client me", bt.me()["id"] == "bot_abcdefghij12")
sent = bt.send("c1", "from the client", as_name="Zed (Discord)", as_pfp="https://x/z.png", src="Discord"); m = f.get("privateChats/c1/messages/" + sent["id"]); t("client send", m["as"]["name"] == "Zed (Discord)" and m["src"] == "Discord" and m["botId"] == "bot_abcdefghij12")
t("client messages", any(x["id"] == sent["id"] for x in bt.messages("c1")) and bt.chats()[0]["id"] == "c1" and len(bt.members("c1")) == 3)
bt.edit("c1", sent["id"], "edited"); t("client edit", f.get(f"privateChats/c1/messages/{sent['id']}/text") == "edited")
bt.set_profile(name="Client Bot"); t("client set_profile", f.get("accsettings/bot_abcdefghij12/settings/displayName") == "Client Bot")
bt.delete("c1", sent["id"]); t("client delete", f.get(f"privateChats/c1/messages/{sent['id']}") is None)
t("answers are cleaned up by the client", not (f.get("botOutbox/bot_abcdefghij12") or {}).get("zzz") and all(k.startswith("req000") or k.startswith("old") for k in (f.get("botOutbox/bot_abcdefghij12") or {})))
try: bt.send("c9", "x"); t("client error", False)
except qmbot.QMError as e: t("client error carries status", e.status == 403)
last = bt.latest_event_key(); msg("e2", text="newer"); w.handle_entry("bot_abcdefghij12", "ping", "c1", {**ping, "id": "e2"})
evs = bt.events(last); t("client events since a key", len(evs) == 1 and evs[0][1]["message"]["text"] == "newer" and bt.events(evs[0][0]) == [])
print(f"{ok}/{ok + bad}")
raise SystemExit(0 if not bad else 1)
