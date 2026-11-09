#!/usr/bin/env python3
"""QuickMessage worker: the push-notification + bot server you run yourself (replaces the Cloud Functions, so no Blaze plan is needed).

What it does
  * Listens to the database (Firebase Admin SDK, service account) for "something new" pings and rings, and sends the push notifications
    (Android app, browsers/PWA; iOS only when the web app is installed) exactly like functions/index.js did.
  * Answers bots' requests, which they write to the database (botInbox -> botOutbox), gives them their new messages (botEvents) and calls
    their webhooks. No open port is needed. (--http-api additionally serves the same API over HTTP.)
  * Writes a heartbeat to the database (serverStatus) every 30 s. The site's Status page and the Account page read it, so you can see at a glance
    when this computer is off and notifications / bot calls are NOT working.
Run:  pip install -r requirements.txt ; python3 qm_worker.py --key serviceAccount.json      (see worker/README.md)
"""
import argparse, collections, json, os, random, socket, sys, threading, time, traceback, warnings
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import botapi

VERSION = "1.2.1"
DEFAULT_DB = "https://quickmessage-ac953-default-rtdb.firebaseio.com"
_PCH = "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz"
_pl, _plock = {"last": 0, "rand": [0] * 12}, threading.Lock()


def push_id():
    """Firebase push id: 8 chars of time + 12 random, so keys sort by creation time."""
    with _plock:
        now = int(time.time() * 1000); dup = now == _pl["last"]; _pl["last"] = now
        ts = []
        for _ in range(8): ts.append(_PCH[now % 64]); now //= 64
        s = "".join(reversed(ts))
        if not dup: _pl["rand"] = [random.randrange(64) for _ in range(12)]
        else:
            i = 11
            while i >= 0 and _pl["rand"][i] == 63: _pl["rand"][i] = 0; i -= 1
            if i >= 0: _pl["rand"][i] += 1
        return s + "".join(_PCH[i] for i in _pl["rand"])


def log(*a): print(time.strftime("%H:%M:%S"), *a, flush=True)


def unslash(d):
    """A multi-path update (the app writes the message and everybody's ping in ONE update) reaches a listener as a "patch" event whose keys are
    whole paths: {"uidA/pings/chat": {...}, "uidB/pings/chat": {...}}. Turn that into the nested form {"uidA": {"pings": {"chat": {...}}}, ...}."""
    if not isinstance(d, dict) or not any("/" in str(k) for k in d): return d
    out = {}
    for k, v in d.items():
        ks = [x for x in str(k).split("/") if x]
        if not ks: continue
        n = out
        for x in ks[:-1]:
            if not isinstance(n.get(x), dict): n[x] = {}
            n = n[x]
        n[ks[-1]] = unslash(v)
    return out


# ---------------------------------------------------------------- the real database / push (thin wrappers around firebase_admin)
class FirebaseBackend:
    def __init__(self, key, db_url):
        import firebase_admin
        from firebase_admin import credentials, db, messaging
        warnings.filterwarnings("ignore", category=DeprecationWarning)
        cred = credentials.Certificate(key) if key else credentials.ApplicationDefault()
        firebase_admin.initialize_app(cred, {"databaseURL": db_url})
        self._db, self.messaging = db, messaging
        self.db_url = db_url

    def get(self, path): return self._db.reference(path).get()
    def update(self, ups): self._db.reference().update(ups)
    def set(self, path, v): self._db.reference(path).set(v)
    def new_key(self): return push_id()

    def messages(self, chat, after, limit):
        ref = self._db.reference(f"privateChats/{chat}/messages")
        if after:
            d = ref.order_by_key().start_at(after).limit_to_first(limit + 1).get() or {}
            return {k: v for k, v in d.items() if k > after and isinstance(v, dict)}
        return {k: v for k, v in (ref.order_by_key().limit_to_last(limit).get() or {}).items() if isinstance(v, dict)}

    def listen(self, path, cb): return self._db.reference(path).listen(cb)

    def send_push(self, token, kind, p):
        """kind 'app' = data-only for the Android app; 'web' = normal notification payload. p is a plain dict (see Worker.build_*)."""
        m = self.messaging
        if kind == "app":
            msg = m.Message(token=token, data=p["data"], android=m.AndroidConfig(priority="high", ttl=p["ttl"], collapse_key=p["collapse"]))
        else:
            n = p["notification"]
            msg = m.Message(token=token, notification=m.Notification(title=n["title"], body=n["body"]), data=p["data"],
                android=m.AndroidConfig(priority="high", ttl=p.get("ttl"), collapse_key=p.get("collapse"), notification=m.AndroidNotification(tag=p["tag"], image=p.get("image"))),
                webpush=m.WebpushConfig(headers={"TTL": str(p["web_ttl"]), "Urgency": "high"}, notification=m.WebpushNotification(title=n["title"], body=n["body"], tag=p["tag"], renotify=True, require_interaction=p["require"], image=p.get("image")), fcm_options=m.WebpushFCMOptions(link=p["link"])),
                apns=m.APNSConfig(headers=p["apns"], payload=m.APNSPayload(aps=m.Aps(alert=m.ApsAlert(title=n["title"], body=n["body"]), sound="default"))))
        m.send(msg)

    def is_dead(self, e):
        """The device token is gone for good (app removed / token replaced). An INVALID_ARGUMENT only counts when it is about the token:
        otherwise a bad payload would wipe every working token."""
        m = self.messaging
        if isinstance(e, (m.UnregisteredError, m.SenderIdMismatchError)): return True
        return e.__class__.__name__ == "InvalidArgumentError" and "registration token" in str(e).lower()


# ---------------------------------------------------------------- the worker
class Worker:
    def __init__(self, be, app_url, public_url="", catchup=600, post_webhook=None, http_api=False):
        self.be, self.app_url = be, app_url.rstrip("/") + "/"
        self.public_url, self.catchup, self.http_api = public_url, catchup, http_api
        self.post_webhook = post_webhook or botapi.post_webhook
        self.pool = ThreadPoolExecutor(8)
        self.seen, self.slock = collections.OrderedDict(), threading.Lock()
        self.started = int(time.time() * 1000)
        self.stats = {"pushed": 0, "pushFailed": 0, "rings": 0, "webhooks": 0, "webhookFailed": 0, "botCalls": 0, "events": 0, "lastError": "", "lastEvent": 0}
        self.listeners, self.listener_started, self.sweeps = [], 0, 0
        self.offset = 0                                              # database clock minus this computer's clock (ms), measured at each heartbeat
        self.stats["clockOffsetMs"] = 0; self.stats["lastPushError"] = ""

    def server_now(self): return time.time() * 1000 + self.offset

    # ---- events from live/{uid}/{pings|rings}/{chat}
    def on_event(self, ev):
        try:
            self.stats["events"] += 1
            path = getattr(ev, "path", "/")
            live = getattr(ev, "event_type", "put") == "patch" or str(path).strip("/") != ""      # a change that just happened (not the whole tree sent when the listener starts)
            for uid, kind, chat, val in self.flatten(path, unslash(getattr(ev, "data", None))):
                self.pool.submit(self.safe, self.handle_entry, uid, kind, chat, val, live)
        except Exception as e: self.err("event", e)

    # ---- bot requests: botInbox/{bot}/{reqId}
    def on_inbox_event(self, ev):
        try:
            self.stats["events"] += 1
            parts = [p for p in str(getattr(ev, "path", "/")).split("/") if p]
            data = unslash(getattr(ev, "data", None))
            if len(parts) > 2 or data is None: return
            items = [(parts[0], parts[1], data)] if len(parts) == 2 else [(parts[0], r, v) for r, v in data.items()] if len(parts) == 1 and isinstance(data, dict) \
                else [(b, r, v) for b, reqs in data.items() if isinstance(reqs, dict) for r, v in reqs.items()] if isinstance(data, dict) else []
            for bot, rid, v in items:
                if isinstance(v, dict) and self.first_time(("req", bot, rid)): self.pool.submit(self.safe, self.on_request, bot, rid, v)
        except Exception as e: self.err("inbox", e)

    def on_request(self, bot, rid, v):
        """Answer a bot's request: write botOutbox/{bot}/{rid} and remove the request, in one atomic update."""
        be = self.be
        ib, ob = f"botInbox/{bot}/{rid}", f"botOutbox/{bot}/{rid}"
        if be.get(ob) is not None:                                  # a retry of a request that was already answered
            be.update({ib: None}); return
        ts = v.get("ts") if isinstance(v.get("ts"), (int, float)) else 0
        if time.time() * 1000 - ts > 10 * 60 * 1000: status, out = 408, {"error": "This request is too old (the worker was off?). Send it again."}
        else: status, out = botapi.run_request(be, bot, v, self.stats)
        be.update({ob: {"status": status, "body": json.dumps(out, separators=(",", ":")), "ts": int(time.time() * 1000)}, ib: None})

    def emit_event(self, bot, chat, mid, msg):
        """A new message in a bot's chat -> botEvents/{bot}/{sha256(token)}/{key}, which the bot reads with the path as its key."""
        th = botapi.feed_hash(self.be, bot)
        if not th: return
        self.be.update({f"botEvents/{bot}/{th}/{self.be.new_key()}": {"ts": int(time.time() * 1000), "body": json.dumps(botapi.event_payload(self.be, bot, chat, mid, msg), separators=(",", ":"))}})
        self.stats["events_sent"] = self.stats.get("events_sent", 0) + 1

    def sweep(self):
        """Tidy up: answers nobody picked up (5 min), events (1 hour), requests that never got answered (1 hour)."""
        be, now, ups = self.be, int(time.time() * 1000), {}
        for bot, reqs in (be.get("botOutbox") or {}).items():
            for rid, v in (reqs or {}).items():
                if not isinstance(v, dict) or v.get("ts", 0) < now - 300000: ups[f"botOutbox/{bot}/{rid}"] = None
        for bot, feeds in (be.get("botEvents") or {}).items():
            for feed, evs in (feeds or {}).items():
                for k, v in (evs or {}).items():
                    if not isinstance(v, dict) or v.get("ts", 0) < now - 3600000: ups[f"botEvents/{bot}/{feed}/{k}"] = None
        for bot, reqs in (be.get("botInbox") or {}).items():
            for rid, v in (reqs or {}).items():
                if not isinstance(v, dict) or v.get("ts", 0) < now - 3600000: ups[f"botInbox/{bot}/{rid}"] = None
        if now - getattr(self, "_log_sweep", 0) > 3600000:                         # notification results are kept for 3 days
            self._log_sweep = now
            for chat, mids in (be.get("pushLog") or {}).items():
                for mid, users in (mids or {}).items():
                    for u, v in (users or {}).items():
                        if not isinstance(v, dict) or v.get("ts", 0) < now - 3 * 86400000: ups[f"pushLog/{chat}/{mid}/{u}"] = None
        if ups: be.update(ups)

    @staticmethod
    def flatten(path, data):
        """(path, data) of a database change -> [(uid, kind, chat, value)], whatever depth the change was reported at."""
        parts = [p for p in str(path).split("/") if p]
        out = []
        def walk(prefix, d):
            if len(prefix) == 3:
                if prefix[1] in ("pings", "rings") and isinstance(d, dict): out.append((prefix[0], prefix[1][:-1], prefix[2], d))
            elif isinstance(d, dict):
                for k, v in d.items(): walk(prefix + [k], v)
        if len(parts) > 3: return out                            # a single field of a ping changed: the whole ping was already handled
        walk(parts, data)
        return out

    def handle_entry(self, uid, kind, chat, v, live=False):
        """live=True: the change just happened, so it is handled whatever its timestamp says (a wrong clock must never swallow a call).
        Otherwise (the snapshot sent at start-up) only recent ones are handled, judged by the database's clock."""
        now = self.server_now()
        if kind == "ping":
            mid, ts = v.get("id"), v.get("ts")
            if not isinstance(mid, str) or not isinstance(ts, (int, float)) or (not live and now - ts > self.catchup * 1000): return
            if not self.first_time(("ping", uid, chat, mid)): return
            return self.on_ping(uid, chat, mid, v)
        rid, ts = v.get("ringId"), v.get("createdAt")
        if not isinstance(rid, str) or not isinstance(ts, (int, float)) or (not live and abs(now - ts) > 45000): return
        if not self.first_time(("ring", uid, chat, rid)): return
        self.on_ring(uid, chat, v)

    def first_time(self, key):
        with self.slock:
            if key in self.seen: return False
            self.seen[key] = 1
            while len(self.seen) > 5000: self.seen.popitem(last=False)
            return True

    def safe(self, fn, *a):
        try: fn(*a)
        except Exception as e: self.err(fn.__name__, e)

    def err(self, where, e):
        self.stats["lastError"] = f"{where}: {e.__class__.__name__}: {str(e)[:160]}"
        log("ERROR", where, repr(e)); 
        if os.environ.get("QM_DEBUG"): traceback.print_exc()

    # ---- push
    def push_to(self, uid, build, app_data):
        tokens = self.be.get(f"FCM/{uid}") or {}
        acc = fail = eligible = 0; err = ""
        for tok, kind in list(tokens.items()):
            app = kind == "android"
            if app and not app_data: continue
            eligible += 1
            try:
                if app: self.be.send_push(tok, "app", {"data": app_data, "ttl": 86400, "collapse": f"{app_data['type']}_{app_data['chatId']}"})
                else: self.be.send_push(tok, "web", build())
                acc += 1
            except Exception as e:
                fail += 1; err = f"{e.__class__.__name__}: {str(e)[:100]}"; self.stats["lastPushError"] = err
                if self.be.is_dead(e): self.be.update({f"FCM/{uid}/{tok}": None}); err += " (device removed)"
                else: log("push failed", uid, err)
        self.stats["pushed"] += acc; self.stats["pushFailed"] += fail
        return acc, fail, eligible, err

    def log_push(self, chat, mid, uid, status, why=None, ok=0, total=0):
        """What happened to the notification for one person: shown in the message's Info dialog (readable by that person and the sender only)."""
        try:
            v = {"status": status, "ts": int(time.time() * 1000), "ok": ok, "total": total}
            if why: v["why"] = str(why)[:160]
            self.be.update({f"pushLog/{chat}/{mid}/{uid}": v}); log("notify", uid[:8], status, f"{ok}/{total}", (why or "")[:70])
        except Exception as e: log("push log failed", str(e)[:80])

    def on_ping(self, uid, chat, mid, ping):
        be = self.be
        participants = be.get(f"privateChats/{chat}/participants") or {}
        msg = be.get(f"privateChats/{chat}/messages/{mid}")
        if not isinstance(msg, dict) or msg.get("type") == "event" or not participants.get(uid): return
        frm = msg.get("fromUid")
        if not frm or not participants.get(frm) or frm == uid: return
        if botapi.BOT_RE.match(uid):                                        # a bot: its event feed, and its webhook if it has one (its own messages never ping it)
            self.emit_event(uid, chat, mid, msg)
            hook = botapi.webhook_payload(be, uid, chat, mid, msg)
            if hook:
                try:
                    st = self.post_webhook(*hook); self.stats["webhooks"] += 1
                    if st >= 400: self.stats["webhookFailed"] += 1
                except Exception as e:
                    self.stats["webhookFailed"] += 1; log("webhook failed", uid, str(e)[:100])
            return
        if be.get(f"privateChats/{chat}/messageRead/{uid}") == mid:                 # already looking at it
            return self.log_push(chat, mid, uid, "skipped", "They had already read it (or had the chat open), so no notification was needed.")
        last = be.get(f"privateChats/{chat}/lastMessage") or {}
        name = (msg.get("as") or {}).get("name") or be.get(f"accsettings/{frm}/settings/displayName") or "New message"
        same = last.get("id") == mid
        enc = bool(last.get("enc")) if same else bool(msg.get("_enc") or msg.get("enc") or msg.get("iv"))
        text = "🔒 New message" if enc else str((same and last.get("text")) or msg.get("text") or msg.get("content") or ("📎 " + msg["fileName"] if msg.get("fileName") else "New message"))[:100]
        link = f"{self.app_url}message.html?chatId={chat}"
        img = None
        if not enc:
            if msg.get("type") == "file" and msg.get("kind") == "image" and str(msg.get("url", "")).startswith("https://"): img = msg["url"]
            elif msg.get("type") == "image" and str(msg.get("content", "")).startswith("https://"): img = msg["content"]
        mentioned = bool(ping.get("mention"))
        title = f"{name} mentioned you" if mentioned else name
        build = lambda: {"notification": {"title": title, "body": text}, "tag": f"chat_{chat}", "collapse": f"chat_{chat}", "image": img, "web_ttl": 86400, "require": False, "link": link,
                         "apns": {"apns-collapse-id": f"chat_{chat}", "apns-priority": "10"}, "data": {"link": link, "chatId": chat, **({"image": img} if img else {})}}
        acc, fail, eligible, err = self.push_to(uid, build, {"type": "msg", "chatId": chat, "msgId": mid, "from": frm})
        if acc > 0: self.log_push(chat, mid, uid, "sent", f"{fail} of {eligible} devices failed: {err}" if fail else None, acc, eligible)
        elif eligible == 0: self.log_push(chat, mid, uid, "no_token", "No device of theirs is set up for notifications.", 0, 0)
        else: self.log_push(chat, mid, uid, "failed", err or "The push service refused every device.", 0, eligible)

    def on_ring(self, uid, chat, ring):
        """A ring was written: push to the person's devices and ALWAYS answer in calls/{chat}/ringing/{uid}/notifyStatus (the caller waits for it),
        with notifyError saying why when it failed."""
        be = self.be
        sp = f"calls/{chat}/ringing/{uid}"
        def answer(status, why=None):
            if be.get(f"{sp}/ringId") != ring.get("ringId"): return          # answered / replaced meanwhile: don't touch a newer ring
            be.update({f"{sp}/notifyStatus": status, f"{sp}/notifyError": (why or None) and str(why)[:140]})
        try:
            frm = ring.get("fromUid")
            participants = be.get(f"privateChats/{chat}/participants") or {}
            if not frm or not participants.get(frm) or not participants.get(uid): return answer("failed", "Not a member of this chat.")
            self.stats["rings"] += 1
            selfring = frm == uid
            name = be.get(f"accsettings/{frm}/settings/displayName") or "QuickMessage"
            title = "Call in progress" if selfring else "Incoming call"
            text = "Join the call on this device" if selfring else f"{name} is calling you"
            from urllib.parse import quote
            link = f"{self.app_url}call.html?chatId={quote(chat)}&session={quote(ring['ringId'])}"
            build = lambda: {"notification": {"title": title, "body": text}, "tag": f"call_{chat}", "ttl": 60, "web_ttl": 60, "require": True, "link": link,
                             "apns": {"apns-priority": "10", "apns-expiration": str(int(time.time()) + 60)}, "data": {"call": "1", "chatId": chat, "sessionId": ring["ringId"], "link": link}}
            app_data = None if selfring else {"type": "ring", "chatId": chat, "ringId": str(ring["ringId"]), "from": str(frm), "createdAt": str(ring.get("createdAt") or int(time.time() * 1000))}
            acc, fail, eligible, err = self.push_to_ring(uid, build, app_data)
            if acc > 0: answer("sent")
            elif eligible == 0: answer("no_token")
            else: answer("failed", err or "The push service refused every device.")
        except Exception as e:
            self.err("ring", e)
            try: answer("failed", f"Worker error: {e.__class__.__name__}: {str(e)[:100]}")
            except Exception: pass

    def push_to_ring(self, uid, build, app_data):
        """Like push_to, but app pushes for a ring expire after 60 s. Returns (accepted, failed, devices that could be tried, last error text)."""
        tokens = self.be.get(f"FCM/{uid}") or {}
        acc = fail = eligible = 0; err = ""
        for tok, kind in list(tokens.items()):
            app = kind == "android"
            if app and not app_data: continue
            eligible += 1
            try:
                if app: self.be.send_push(tok, "app", {"data": app_data, "ttl": 60, "collapse": f"ring_{app_data['chatId']}"})
                else: self.be.send_push(tok, "web", build())
                acc += 1
            except Exception as e:
                fail += 1; err = f"{e.__class__.__name__}: {str(e)[:100]}"
                self.stats["lastPushError"] = err
                if self.be.is_dead(e): self.be.update({f"FCM/{uid}/{tok}": None}); err += " (device removed)"
                else: log("push failed", uid, err)
        self.stats["pushed"] += acc; self.stats["pushFailed"] += fail
        return acc, fail, eligible, err

    # ---- listener + heartbeat
    def start_listener(self):
        for l in self.listeners:
            try: l and l.close()
            except Exception: pass
        self.listeners = [self.be.listen("live", self.on_event), self.be.listen("botInbox", self.on_inbox_event)]
        self.listener_started = time.time()
        log("listening to live/* (notifications) and botInbox/* (bot requests)")

    def snapshot(self, online=True):
        s = dict(self.stats)
        return {"ts": {".sv": "timestamp"}, "started": self.started, "version": VERSION, "listening": bool(self.listeners), "apiUrl": (self.public_url or None) if self.http_api else None, **{k: s[k] for k in ("pushed", "pushFailed", "rings", "webhooks", "webhookFailed", "botCalls", "lastError", "lastPushError", "clockOffsetMs")}}

    def heartbeat(self):
        try:
            before = time.time() * 1000
            self.be.set("serverStatus", self.snapshot())
            ts = self.be.get("serverStatus/ts")
            if isinstance(ts, (int, float)):                                  # the database wrote its own clock: compare with ours (midpoint of the round trip)
                self.offset = ts - (before + time.time() * 1000) / 2
                self.stats["clockOffsetMs"] = int(self.offset)
        except Exception as e: self.err("heartbeat", e)

    def run_loops(self):
        self.heartbeat()                                                      # first: learns the clock offset the listener's time checks use
        self.start_listener()
        while True:
            self.heartbeat()
            self.sweeps += 1
            if self.sweeps % 10 == 0: self.safe(self.sweep)                    # about every 5 minutes
            if time.time() - self.listener_started > 20 * 60:                 # the stream can go stale after a long time: reconnect (seen-pings are remembered)
                try: self.start_listener()
                except Exception as e: self.err("listener", e)
            time.sleep(30)


# ---------------------------------------------------------------- HTTP: bot API + local status
STATUS_HTML = """<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>QuickMessage worker</title>
<style>body{font:16px system-ui;max-width:34rem;margin:2rem auto;padding:0 1rem}.ok{color:#15803d}pre{background:#8881;padding:.7rem;border-radius:8px;overflow:auto}</style>
<h1>QuickMessage worker</h1><p class=ok><strong>Running.</strong> Notifications and bot calls are being served by this computer.</p><pre id=s>loading…</pre>
<script>async function t(){try{s.textContent=JSON.stringify(await (await fetch('status.json')).json(),null,2)}catch(e){s.textContent='unreachable'}}t();setInterval(t,5000)</script>"""


def make_handler(w):
    class H(BaseHTTPRequestHandler):
        server_version = "QuickMessageWorker/" + VERSION
        def log_message(self, *a): pass
        def cors(self):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
        def send(self, code, body, ctype="application/json; charset=utf-8"):
            b = body if isinstance(body, bytes) else (body if isinstance(body, str) else json.dumps(body, separators=(",", ":"))).encode()
            self.send_response(code); self.cors(); self.send_header("Content-Type", ctype); self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
        def do_OPTIONS(self): self.send(204, b"")
        def route(self, method):
            u = urlparse(self.path); q = parse_qs(u.query)
            try:
                if u.path in ("/", "/status") and method == "GET": return self.send(200, STATUS_HTML, "text/html; charset=utf-8")
                if u.path == "/status.json" and method == "GET":
                    s = w.snapshot(); s["ts"] = int(time.time() * 1000); s["uptimeSec"] = int((time.time() * 1000 - w.started) / 1000); return self.send(200, s)
                if u.path.startswith("/api/bot") and w.http_api:
                    n = int(self.headers.get("Content-Length") or 0)
                    if n > 65536: return self.send(413, {"error": "too large"})
                    try: body = json.loads(self.rfile.read(n).decode()) if n else {}
                    except Exception: body = {}
                    h = self.headers.get("Authorization") or ""
                    out = botapi.handle(w.be, method, u.path[len("/api/bot"):], q, body, h[7:] if h.startswith("Bearer ") else "", w.stats)
                    return self.send(200, out)
                self.send(404, {"error": "not found"})
            except botapi.BotError as e: self.send(e.status, {"error": str(e)})
            except Exception as e: w.err("http", e); self.send(500, {"error": "server error"})
        def do_GET(self): self.route("GET")
        def do_POST(self): self.route("POST")
        def do_PATCH(self): self.route("PATCH")
        def do_DELETE(self): self.route("DELETE")
    return H


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--key", default=os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"), help="service account JSON (Firebase console > Project settings > Service accounts)")
    ap.add_argument("--db-url", default=os.environ.get("QM_DB_URL", DEFAULT_DB))
    ap.add_argument("--app-url", default=os.environ.get("QM_APP_URL", "https://msg.infinityfreeapp.com/"), help="your site, used for notification links")
    ap.add_argument("--http-api", action="store_true", help="ALSO serve the bot API over HTTP (/api/bot). Not needed: bots normally talk to the worker through the database")
    ap.add_argument("--public-url", default=os.environ.get("QM_PUBLIC_URL", ""), help="with --http-api: the public address of the HTTP bot API, e.g. https://bots.example.com/api/bot")
    ap.add_argument("--host", default="127.0.0.1", help="where the local status page listens (use 0.0.0.0 for --http-api from other computers)"); ap.add_argument("--port", type=int, default=int(os.environ.get("QM_PORT", "8787")))
    ap.add_argument("--catchup", type=int, default=600, help="seconds: after downtime, still notify for pings newer than this")
    a = ap.parse_args()
    if not a.key: sys.exit("Give the service account key: --key serviceAccount.json (see worker/README.md)")
    w = Worker(FirebaseBackend(a.key, a.db_url), a.app_url, a.public_url, a.catchup, http_api=a.http_api)
    srv = ThreadingHTTPServer((a.host, a.port), make_handler(w)); srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    log(f"QuickMessage worker {VERSION}: status page on http://{a.host}:{a.port}/" + (" + HTTP bot API" if a.http_api else ""))
    try: w.run_loops()
    except KeyboardInterrupt: log("stopping"); 


if __name__ == "__main__":
    main()
