"""QuickMessage bot API (Python port of functions/bots.js, same routes and behaviour).

Talks to the database only through a `Backend` object:
    get(path) -> value or None          update({path: value|None, ...})          new_key() -> str
    messages(chat, after, limit) -> {key: message}   (oldest first when sorted by key)
Routes (header "Authorization: Bearer <token>"): GET /me, PATCH /me, GET /chats, GET /members, GET /messages, POST /send, PATCH|DELETE /message.
"""
import hashlib, hmac, ipaddress, json, re, socket, ssl, threading, time, http.client
from urllib.parse import urlparse

BOT_RE = re.compile(r"^bot_[a-z0-9]{12}$")
TOKEN_RE = re.compile(r"^qmbot\.(bot_[a-z0-9]{12})\.([A-Za-z0-9_-]{32,64})$")
CHAT_RE = re.compile(r"^[\w-]{1,64}$")
_CTRL = re.compile(r"[\x00-\x1f\x7f‪-‮⁦-⁩]")
_HITS, _HLOCK = {}, threading.Lock()


class BotError(Exception):
    def __init__(self, status, msg):
        super().__init__(msg)
        self.status = status


def bad(msg, status=400):
    raise BotError(status, msg)


def sha256(s): return hashlib.sha256(s.encode()).hexdigest()
def clean(x, n): return _CTRL.sub(" ", str(x if x is not None else "")).strip()[:n]
def https_url(u, n):
    u = str(u if u is not None else "").strip()
    return u if re.match(r"^https://\S+$", u, re.I) and len(u) <= n else ""


def auth_bot(db, tok):
    m = TOKEN_RE.match((tok or "").strip())
    if not m: bad("Missing or malformed bot token.", 401)
    th = db.get(f"botKeys/{m.group(1)}/th")
    if not isinstance(th, str) or not hmac.compare_digest(th, sha256(m.group(0))): bad("Wrong bot token.", 401)
    bot = db.get(f"bots/{m.group(1)}")
    if not isinstance(bot, dict): bad("This bot was deleted.", 401)
    return m.group(1), bot


def in_chat(db, bid, chat):
    if not CHAT_RE.match(str(chat or "")): bad("chat is required.")
    if db.get(f"privateChats/{chat}/participants/{bid}") is not True: bad("This bot is not in that chat.", 403)


def name_of(db, uid): return db.get(f"accsettings/{uid}/settings/displayName") or "Unknown"


def view(db, bid, key, m, names):
    def who(u):
        if u not in names: names[u] = name_of(db, u)
        return names[u]
    o = {"id": key, "fromUid": m.get("fromUid"), "from": (m.get("as") or {}).get("name") or who(m.get("fromUid")),
         "fromBot": m.get("botId") if isinstance(m.get("botId"), str) else None, "fromMe": m.get("fromUid") == bid,
         "type": m.get("type") or "text", "timestamp": m.get("timestamp") or 0, "edited": bool(m.get("editedAt"))}
    if m.get("src"): o["src"] = m["src"]
    if m.get("enc"):
        o["encrypted"] = True; o["text"] = None
    else:
        o["text"] = (m.get("name") or "") if m.get("type") == "file" else (m.get("text") if isinstance(m.get("text"), str) else None)
        if m.get("type") == "file":
            o["file"] = {"url": m.get("url", ""), "name": m.get("name", ""), "kind": m.get("kind", "file"), "mime": m.get("mime", ""), "size": m.get("size", 0)}
    r = m.get("replyTo")
    if isinstance(r, dict) and r.get("key"): o["replyTo"] = {"key": r["key"], "uid": r.get("uid")}
    return o


def handle(db, method, route, q, b, tok, stats=None):
    """Returns the JSON-able answer or raises BotError."""
    bid, bot = auth_bot(db, tok)
    route = method + " /" + str(route or "").strip("/")
    q = {k: (v[0] if isinstance(v, list) else v) for k, v in (q or {}).items()}
    if not isinstance(b, dict): b = {}
    if stats is not None: stats["botCalls"] = stats.get("botCalls", 0) + 1
    if route == "GET /me":
        st = db.get(f"accsettings/{bid}/settings") or {}
        return {"id": bid, "name": st.get("displayName") or bot.get("name"), "pfp": st.get("pfp", ""), "owner": bot.get("owner"),
                "created": bot.get("created"), "webhook": bool(db.get(f"botKeys/{bid}/webhook"))}
    if route == "PATCH /me":
        up = {}
        if "name" in b:
            n = clean(b["name"], 100)
            if not n: bad("name can't be empty.")
            up[f"accsettings/{bid}/settings/displayName"] = n; up[f"bots/{bid}/name"] = n
        if "pfp" in b:
            u = "" if b["pfp"] in ("", None) else https_url(b["pfp"], 2000)
            if b["pfp"] and not u: bad("pfp must be an https:// address.")
            up[f"accsettings/{bid}/settings/pfp"] = u or None; up[f"bots/{bid}/pfp"] = u or None
        if not up: bad("Send name and/or pfp.")
        db.update(up); return {"ok": True}
    if route == "GET /chats":
        out = []
        for chat in list(db.get(f"chatList/{bid}") or {})[:200]:
            if db.get(f"privateChats/{chat}/participants/{bid}") is not True: continue
            cd = db.get(f"privateChats/{chat}/chatData") or {}
            out.append({"id": chat, "name": cd.get("name", ""), "encrypted": cd.get("encrypted") is True})
        return {"chats": out}
    if route == "GET /members":
        in_chat(db, bid, q.get("chat"))
        return {"members": [{"uid": u, "name": name_of(db, u), "bot": bool(BOT_RE.match(u))} for u in (db.get(f"privateChats/{q['chat']}/participants") or {})]}
    if route == "GET /messages":
        in_chat(db, bid, q.get("chat"))
        try: limit = max(1, min(100, int(q.get("limit") or 30)))
        except ValueError: limit = 30
        node = db.messages(q["chat"], str(q.get("after") or ""), limit) or {}
        names = {}
        return {"messages": [view(db, bid, k, node[k], names) for k in sorted(node) if node[k].get("type") != "event"]}
    if route == "POST /send":
        in_chat(db, bid, b.get("chat")); chat = b["chat"]
        now = time.time()
        with _HLOCK:
            hits = [t for t in _HITS.get(bid, []) if now - t < 10] + [now]; _HITS[bid] = hits
        if len(hits) > 20: bad("Slow down: at most 20 messages per 10 seconds.", 429)
        ts = int(now * 1000); key = db.new_key()
        msg = {"fromUid": bid, "botId": bid, "timestamp": ts, "deliveredAt": ts, "type": "text"}
        f = b.get("file")
        if f:
            url = https_url(f.get("url"), 300) if isinstance(f, dict) else ""
            if not url: bad("file.url must be an https:// address of at most 300 characters.")
            kind = f.get("kind") if f.get("kind") in ("image", "video", "audio", "file") else "file"
            nm = clean(f.get("name") or url.split("/")[-1], 300) or "file"
            msg.update({"type": "file", "url": url, "name": nm, "kind": kind, "text": nm})
            if f.get("mime"): msg["mime"] = clean(f["mime"], 120)
            if isinstance(f.get("size"), (int, float)) and not isinstance(f.get("size"), bool): msg["size"] = f["size"]
            preview = "📎 " + nm
        else:
            text = str(b.get("text") if b.get("text") is not None else "")[:4000]
            if not text.strip(): bad("text is required.")
            msg["text"] = text; preview = text[:300]
        a = b.get("as")
        if isinstance(a, dict):
            asd = {}
            if clean(a.get("name"), 80): asd["name"] = clean(a.get("name"), 80)
            if https_url(a.get("pfp"), 600): asd["pfp"] = https_url(a.get("pfp"), 600)
            if asd: msg["as"] = asd
        if clean(b.get("src"), 30): msg["src"] = clean(b.get("src"), 30)
        r = b.get("replyTo")
        if isinstance(r, dict) and isinstance(r.get("key"), str):
            rm = db.get(f"privateChats/{chat}/messages/{r['key']}")
            if isinstance(rm, dict) and not rm.get("enc"):
                msg["replyTo"] = {"key": r["key"], "uid": rm.get("fromUid"), "text": str(rm.get("text") or rm.get("name") or "")[:700]}
        ups = {f"privateChats/{chat}/messages/{key}": msg,
               f"privateChats/{chat}/lastMessage": {"fromUid": bid, "text": preview, "timestamp": ts, "id": key}}
        for u in (db.get(f"privateChats/{chat}/participants") or {}):
            if u != bid and not BOT_RE.match(u): ups[f"live/{u}/pings/{chat}"] = {"id": key, "ts": ts, "from": bid}
        db.update(ups)                                   # the pings make the worker's own listener send the push notifications
        return {"id": key, "timestamp": ts}
    if route in ("PATCH /message", "DELETE /message"):
        chat = b.get("chat") or q.get("chat"); key = str(b.get("id") or q.get("id") or "")
        in_chat(db, bid, chat)
        if not re.match(r"^[\w-]{1,40}$", key): bad("id is required.")
        m = db.get(f"privateChats/{chat}/messages/{key}")
        if not isinstance(m, dict): bad("No such message.", 404)
        if m.get("fromUid") != bid: bad("A bot can only change its own messages.", 403)
        if method == "PATCH":
            text = str(b.get("text") if b.get("text") is not None else "")[:4000]
            if not text.strip(): bad("text is required.")
            if m.get("type") != "text": bad("Only text messages can be edited.")
            ups = {f"privateChats/{chat}/messages/{key}/text": text, f"privateChats/{chat}/messages/{key}/editedAt": int(time.time() * 1000)}
            if db.get(f"privateChats/{chat}/lastMessage/id") == key: ups[f"privateChats/{chat}/lastMessage/text"] = text[:300]
            db.update(ups); return {"ok": True}
        db.update({f"privateChats/{chat}/messages/{key}": None, f"privateChats/{chat}/media/{key}": None}); return {"ok": True}
    bad("Unknown route " + route, 404)


# ---------------------------------------------------------------- requests through the database (botInbox -> botOutbox)
OPS = {"me": ("GET", "/me"), "setProfile": ("PATCH", "/me"), "chats": ("GET", "/chats"), "members": ("GET", "/members"), "messages": ("GET", "/messages"),
       "send": ("POST", "/send"), "edit": ("PATCH", "/message"), "delete": ("DELETE", "/message")}


def run_request(db, bot_id, req, stats=None):
    """One request from botInbox/{bot_id}/{reqId}: {token, op, ts, ...arguments}. Returns (status, json-able). Never raises BotError."""
    try:
        if not isinstance(req, dict) or req.get("op") not in OPS: bad("Unknown op.")
        tok = str(req.get("token") or "")
        who, _ = auth_bot(db, tok)
        if who != bot_id: bad("Wrong bot token.", 401)
        method, route = OPS[req["op"]]
        args = {k: v for k, v in req.items() if k not in ("token", "op", "ts")}
        return 200, handle(db, method, route, args if method == "GET" else {}, {} if method == "GET" else args, tok, stats)
    except BotError as e:
        return e.status, {"error": str(e)}


def event_payload(db, bot_id, chat, key, msg):
    """What a bot is told about a new message (botEvents feed / webhook body)."""
    return {"event": "message", "bot": bot_id, "chat": chat, "message": view(db, bot_id, key, msg, {})}


def feed_hash(db, bot_id):
    th = db.get(f"botKeys/{bot_id}/th")
    return th if isinstance(th, str) and re.match(r"^[0-9a-f]{64}$", th) else None


# ---------------------------------------------------------------- webhooks
def webhook_payload(db, bid, chat, key, msg):
    """(url, body bytes, signature) for one bot, or None when it has no usable webhook."""
    k = db.get(f"botKeys/{bid}") or {}
    url, th = https_url(k.get("webhook"), 300), k.get("th")
    if not url or not isinstance(th, str): return None
    body = json.dumps(event_payload(db, bid, chat, key, msg), separators=(",", ":")).encode()
    return url, body, hmac.new(th.encode(), body, hashlib.sha256).hexdigest()


def public_address(host):
    """Resolves host and returns one IP, but only if EVERY answer is a public address. Anybody with an account can set a webhook,
    so the worker must never be talked into calling things on its own machine or network."""
    infos = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    ips = [ipaddress.ip_address(i[4][0]) for i in infos]
    if not ips or any(not ip.is_global or ip.is_multicast for ip in ips): raise ValueError("webhook address is not public")
    return infos[0][4][0]


def post_webhook(url, body, sig, timeout=8):
    u = urlparse(url)
    if u.scheme != "https" or not u.hostname or (u.port not in (None, 443)): raise ValueError("webhook must be https on port 443")
    ip = public_address(u.hostname)
    sock = socket.create_connection((ip, 443), timeout=timeout)       # connect to the address we checked (no second DNS lookup)
    tls = ssl.create_default_context().wrap_socket(sock, server_hostname=u.hostname)
    conn = http.client.HTTPSConnection(u.hostname, 443, timeout=timeout)
    conn.sock = tls
    try:
        conn.request("POST", (u.path or "/") + (("?" + u.query) if u.query else ""), body, {"Content-Type": "application/json", "X-QM-Signature": sig, "User-Agent": "QuickMessage-Worker"})
        r = conn.getresponse(); r.read(1024)
        return r.status
    finally:
        conn.close()
