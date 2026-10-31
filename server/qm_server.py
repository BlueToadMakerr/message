#!/usr/bin/env python3
"""
QuickMessage private server: a stand-alone replacement for Firebase (Auth + Realtime Database) that serves the site too.
Pure Python 3.8+ standard library. No internet, no accounts, no packages.

  python3 qm_server.py                       # http://0.0.0.0:8080 , data kept in ./qm-data
  python3 qm_server.py --port 9000 --data /srv/qm
  python3 qm_server.py adduser me@example.com 'a password'
  python3 qm_server.py --help

What it does: accounts (email + password), the chat database with live updates (Server-Sent Events), a simplified permission model
(see docs/SERVER-PRIVATE.md), the "lite" API used by very old browsers (legacy/), file uploads, and static hosting of the web app.
What it does not do: Google sign-in, e-mail (verification, password reset), push notifications while the page is closed, HTTPS (put a reverse
proxy in front for that), and the native apps (they are built for the Firebase setup).
"""
import argparse, base64, hashlib, hmac, json, mimetypes, os, queue, re, secrets, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
VERSION = "1.0.0"
LOCK = threading.RLock()
TREE = {}            # the database
USERS = {}           # uid -> {uid,email,salt,hash,created,last}
BY_EMAIL = {}
CLIENTS = {}         # cid -> Client
CFG = {"secret": b"", "data": "", "signup": True, "max_body": 40 * 1024 * 1024, "token_days": 60}
SAVE_TIMER = [None]

# ---------------------------------------------------------------- storage
def load():
    global TREE
    p = os.path.join(CFG["data"], "db.json")
    if os.path.exists(p):
        with open(p, "r", encoding="utf-8") as f: TREE = json.load(f)
    p = os.path.join(CFG["data"], "users.json")
    if os.path.exists(p):
        with open(p, "r", encoding="utf-8") as f: USERS.update(json.load(f))
    for u in USERS.values(): BY_EMAIL[u["email"].lower()] = u["uid"]
    sp = os.path.join(CFG["data"], "secret.key")
    if os.path.exists(sp):
        CFG["secret"] = open(sp, "rb").read()
    else:
        CFG["secret"] = secrets.token_bytes(32)
        with open(sp, "wb") as f: f.write(CFG["secret"])
        try: os.chmod(sp, 0o600)
        except OSError: pass

def _write_atomic(name, obj):
    p = os.path.join(CFG["data"], name); tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f: json.dump(obj, f, separators=(",", ":"), ensure_ascii=False)
    os.replace(tmp, p)

def save_soon(users=False):
    def run():
        with LOCK:
            _write_atomic("db.json", TREE)
            _write_atomic("users.json", USERS)
    if SAVE_TIMER[0]: SAVE_TIMER[0].cancel()
    t = threading.Timer(0.8, run); t.daemon = True; SAVE_TIMER[0] = t; t.start()

# ---------------------------------------------------------------- tree helpers
def parts(path): return [p for p in (path or "").split("/") if p]

def get_at(path_parts, tree=None):
    n = TREE if tree is None else tree
    for p in path_parts:
        if not isinstance(n, dict) or p not in n: return None
        n = n[p]
    return n

def clean(v):
    """Firebase semantics: null / empty objects disappear."""
    if isinstance(v, dict):
        out = {}
        for k, x in v.items():
            x = clean(x)
            if x is not None: out[k] = x
        return out or None
    return v

def sv(v, now):
    if isinstance(v, dict):
        if set(v.keys()) == {".sv"}: return now
        return {k: sv(x, now) for k, x in v.items()}
    return v

def set_at(path_parts, value):
    if not path_parts:
        TREE.clear()
        if isinstance(value, dict): TREE.update(value)
        return
    n = TREE
    for p in path_parts[:-1]:
        if not isinstance(n.get(p), dict): n[p] = {}
        n = n[p]
    if value is None: n.pop(path_parts[-1], None)
    else: n[path_parts[-1]] = value
    # prune empty parents
    for i in range(len(path_parts) - 1, 0, -1):
        par = get_at(path_parts[:i])
        if isinstance(par, dict) and not par:
            set_at_raw_remove(path_parts[:i])
        else: break

def set_at_raw_remove(pp):
    n = TREE
    for p in pp[:-1]:
        n = n.get(p)
        if not isinstance(n, dict): return
    n.pop(pp[-1], None)

# ---------------------------------------------------------------- queries
def _rank(v):
    if v is None: return (0, 0)
    if v is False: return (1, 0)
    if v is True: return (2, 0)
    if isinstance(v, (int, float)): return (3, v)
    if isinstance(v, str): return (4, v)
    return (5, 0)

def run_query(node, q):
    """node -> ordered list of [key, value] after applying the query spec (orderBy, startAt, endAt, equalTo, startAfter, endBefore, limitFirst, limitLast)."""
    if not isinstance(node, dict): return []
    q = q or {}
    ob = q.get("orderBy") or "key"
    def okey(k, v):
        if ob == "key": return (k,)
        if ob == "value": return (_rank(v), k)
        c = v.get(ob[6:]) if isinstance(v, dict) else None
        return (_rank(c), k)
    items = sorted(node.items(), key=lambda kv: okey(*kv))
    def cmpv(k, v, bound):
        if ob == "key": return (k > bound) - (k < bound)
        x = v if ob == "value" else (v.get(ob[6:]) if isinstance(v, dict) else None)
        rx, rb = _rank(x), _rank(bound)
        return (rx > rb) - (rx < rb)
    out = []
    for k, v in items:
        if "equalTo" in q and cmpv(k, v, q["equalTo"]) != 0: continue
        if "startAt" in q and cmpv(k, v, q["startAt"]) < 0: continue
        if "startAfter" in q and cmpv(k, v, q["startAfter"]) <= 0: continue
        if "endAt" in q and cmpv(k, v, q["endAt"]) > 0: continue
        if "endBefore" in q and cmpv(k, v, q["endBefore"]) >= 0: continue
        out.append([k, v])
    if "limitFirst" in q: out = out[: q["limitFirst"]]
    if "limitLast" in q: out = out[-q["limitLast"]:] if q["limitLast"] > 0 else []
    return out

# ---------------------------------------------------------------- permissions (simplified; see docs/SERVER-PRIVATE.md)
def member(chat, uid, new_tree=None):
    p = get_at(["privateChats", chat, "participants"])
    if isinstance(p, dict) and p.get(uid): return True
    if p is None and new_tree is not None:
        np_ = get_at(["privateChats", chat, "participants"], new_tree)
        return isinstance(np_, dict) and bool(np_.get(uid))
    return False

def can_read(uid, pp):
    if not pp: return False
    t = pp[0]
    if t in ("accsettings", "userKeys", "linkPreviews"): return len(pp) > 1
    if t in ("chatList", "live", "FCM"): return len(pp) > 1 and pp[1] == uid
    if t in ("privateChats", "calls"): return len(pp) > 1 and member(pp[1], uid)
    return False

def can_write(uid, pp, value, newtree):
    if not pp: return False
    t = pp[0]
    if t in ("accsettings", "userKeys", "FCM"): return len(pp) > 1 and pp[1] == uid
    if t == "chatList":
        if len(pp) < 2: return False
        if pp[1] == uid: return True
        return len(pp) >= 3 and member(pp[2], uid, newtree)           # putting a new chat into someone else's list
    if t == "live":
        if len(pp) < 2: return False
        if pp[1] == uid: return True
        return len(pp) >= 4 and member(pp[3], uid, newtree) and member(pp[3], pp[1], newtree)
    if t == "calls":
        return len(pp) > 1 and member(pp[1], uid, newtree)
    if t == "privateChats":
        if len(pp) < 2: return False
        chat = pp[1]
        existed = get_at(["privateChats", chat]) is not None
        if len(pp) == 2:
            if value is None: return member(chat, uid)
            return (not existed) and member(chat, uid, newtree)
        if not member(chat, uid, newtree): return False
        sub = pp[2]
        if sub == "messages" and len(pp) >= 4:
            old = get_at(["privateChats", chat, "messages", pp[3]])
            if len(pp) == 4:
                if old is None: return isinstance(value, dict) and value.get("fromUid") == uid
                return isinstance(old, dict) and old.get("fromUid") == uid
            return isinstance(old, dict) and old.get("fromUid") == uid or (old is None and get_at(["privateChats", chat, "messages", pp[3], "fromUid"], newtree) == uid)
        if sub == "media" and len(pp) >= 4:
            old_m = get_at(["privateChats", chat, "messages", pp[3]])
            if value is None: return old_m is None or (isinstance(old_m, dict) and old_m.get("fromUid") == uid)
            return get_at(pp) is None
        if sub in ("messageRead", "typing") and len(pp) >= 4: return pp[3] == uid or value is None
        return True
    return False

# ---------------------------------------------------------------- writes + live listeners
class Client:
    def __init__(self, cid, uid):
        self.cid, self.uid = cid, uid
        self.q = queue.Queue()
        self.listeners = {}      # lid -> {path, query, mode, last}
        self.ondisc = {}         # id -> {path: value}
        self.alive = True

def related(a, b):
    n = min(len(a), len(b))
    return a[:n] == b[:n]

def snapshot_for(l):
    node = get_at(l["path"])
    if l["mode"] == "value":
        if l["query"]: return json.loads(json.dumps(run_query(node, l["query"])))
        return json.loads(json.dumps(node))              # a copy: listeners compare old and new, the tree itself keeps changing
    return {k: v for k, v in run_query(node, l["query"])}

def dispatch(changed_paths):
    for c in list(CLIENTS.values()):
        for lid, l in list(c.listeners.items()):
            if not any(related(l["path"], cp) for cp in changed_paths): continue
            now = snapshot_for(l)
            if l["mode"] == "value":
                if json.dumps(now, sort_keys=True) == l["last"]: continue
                l["last"] = json.dumps(now, sort_keys=True)
                c.q.put({"lid": lid, "type": "value", "v": now})
            else:
                prev = json.loads(l["last"]) if l["last"] else {}
                ups = [[k, v] for k, v in now.items() if k not in prev or prev[k] != v]
                dels = [k for k in prev if k not in now]
                l["last"] = json.dumps(now, sort_keys=True)
                if ups or dels: c.q.put({"lid": lid, "type": "delta", "ups": ups, "del": dels})

def apply_update(uid, updates, trusted=False):
    """updates: {path: value}. All-or-nothing. Returns (ok, error)."""
    with LOCK:
        now = int(time.time() * 1000)
        ups = {}
        for p, v in updates.items():
            if not isinstance(p, str) or ".." in p: return False, "bad path"
            ups[p.strip("/")] = clean(sv(v, now))
        pps = {p: parts(p) for p in ups}
        if not trusted:
            overlay = {}                                   # just the new values: enough to see who a brand-new chat's members are
            _apply_to(overlay, pps, {p: v for p, v in ups.items()})
            for p, pp in pps.items():
                if not can_write(uid, pp, ups[p], overlay): return False, "permission denied: " + p
        for p, pp in pps.items():
            set_at(pp, ups[p])
        dispatch(list(pps.values()))
        save_soon()
        return True, None

def _apply_to(tree, pps, ups):
    for p, pp in pps.items():
        v = ups[p]
        if not pp:
            tree.clear(); tree.update(v or {}); continue
        n = tree
        for k in pp[:-1]:
            if not isinstance(n.get(k), dict): n[k] = {}
            n = n[k]
        if v is None: n.pop(pp[-1], None)
        else: n[pp[-1]] = v

def add_listener(c, lid, path, query, mode):
    pp = parts(path)
    if not can_read(c.uid, pp): return False
    l = {"path": pp, "query": query or None, "mode": mode, "last": ""}
    with LOCK:
        c.listeners[lid] = l
        now = snapshot_for(l)
        l["last"] = json.dumps(now, sort_keys=True)
        if mode == "value": c.q.put({"lid": lid, "type": "value", "v": now})
        else: c.q.put({"lid": lid, "type": "init", "items": run_query(get_at(pp), query)})
    return True

def drop_client(c):
    with LOCK:
        c.alive = False
        if CLIENTS.get(c.cid) is c: CLIENTS.pop(c.cid, None)
        ops = list(c.ondisc.values())
    for op in ops:
        apply_update(c.uid, op, trusted=True)

# ---------------------------------------------------------------- accounts
def hash_pw(pw, salt): return hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, 120000).hex()

def make_token(uid):
    body = base64.urlsafe_b64encode(json.dumps({"u": uid, "e": int(time.time()) + CFG["token_days"] * 86400}).encode()).decode().rstrip("=")
    sig = hmac.new(CFG["secret"], body.encode(), hashlib.sha256).hexdigest()
    return body + "." + sig

def check_token(tok):
    try:
        body, sig = tok.rsplit(".", 1)
        if not hmac.compare_digest(sig, hmac.new(CFG["secret"], body.encode(), hashlib.sha256).hexdigest()): return None
        d = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
        if d["e"] < time.time(): return None
        return d["u"] if d["u"] in USERS else None
    except Exception: return None

def user_json(u):
    return {"uid": u["uid"], "email": u["email"], "emailVerified": True, "displayName": None,
            "creationTime": u["created"], "lastSignInTime": u["last"], "providers": ["password"]}

def create_user(email, pw):
    email = (email or "").strip()
    if not re.match(r"^[^@\s]+@[^@\s]+$", email): raise ValueError("Enter a valid email address (it only needs to look like one, e.g. me@home).")
    if len(pw or "") < 6: raise ValueError("The password needs at least 6 characters.")
    with LOCK:
        if email.lower() in BY_EMAIL: raise ValueError("That email is already registered.")
        uid = secrets.token_urlsafe(21)[:28]
        salt = secrets.token_bytes(16)
        now = time.strftime("%a, %d %b %Y %H:%M:%S GMT", time.gmtime())
        USERS[uid] = {"uid": uid, "email": email, "salt": salt.hex(), "hash": hash_pw(pw, salt), "created": now, "last": now}
        BY_EMAIL[email.lower()] = uid
        if get_at(["accsettings", uid]) is None: set_at(["accsettings", uid, "settings"], {"displayName": email.split("@")[0][:40] or "user"})
        save_soon()
        return USERS[uid]

def login(email, pw):
    uid = BY_EMAIL.get((email or "").strip().lower())
    u = USERS.get(uid) if uid else None
    if not u or not hmac.compare_digest(u["hash"], hash_pw(pw or "", bytes.fromhex(u["salt"]))):
        raise ValueError("Wrong email or password.")
    u["last"] = time.strftime("%a, %d %b %Y %H:%M:%S GMT", time.gmtime()); save_soon()
    return u

# ---------------------------------------------------------------- lite API (very old browsers)
def push_id():
    chars = "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz"
    t = int(time.time() * 1000); s = ""
    for _ in range(8): s = chars[t % 64] + s; t //= 64
    return "-" + s + "".join(secrets.choice(chars) for _ in range(11))

def display_name(uid):
    n = get_at(["accsettings", uid, "settings", "displayName"])
    return n if isinstance(n, str) and n.strip() else (USERS.get(uid, {}).get("email", "?").split("@")[0])

def lite_chats(uid):
    out = []
    for chat in (get_at(["chatList", uid]) or {}):
        c = get_at(["privateChats", chat])
        if not isinstance(c, dict) or uid not in (c.get("participants") or {}): continue
        last = c.get("lastMessage") or {}
        others = [display_name(u) for u in c["participants"] if u != uid]
        name = (c.get("chatData") or {}).get("name") or ", ".join(others) or "Chat"
        enc = bool((c.get("chatData") or {}).get("encrypted"))
        out.append({"id": chat, "name": name, "ts": last.get("timestamp", 0), "enc": enc})       # no last message: the compatibility client loads the list once and keeps it light
    out.sort(key=lambda x: -x["ts"]); return out

def lite_text(m):
    t = m.get("type") or "text"
    if m.get("enc"): return "(encrypted message - open QuickMessage on a newer browser to read it)"
    if t == "text": return m.get("text", "")
    if t == "file": return "[file: %s]" % (m.get("name") or m.get("text") or "")
    return "[%s]" % t

def lite_messages(uid, chat, after, before="", page=30):
    """after: only newer than this key (refresh). before: one page of older messages. Neither: the newest page. Returns (messages, more_older) or None."""
    if not member(chat, uid): return None
    node = get_at(["privateChats", chat, "messages"]) or {}
    keys = [k for k in sorted(node) if node[k].get("type") != "event"]
    if after: keys = [k for k in keys if k > after][-200:]; more = False
    else:
        if before: keys = [k for k in keys if k < before]
        more = len(keys) > page; keys = keys[-page:]
    return [{"key": k, "from": node[k].get("fromUid"), "name": display_name(node[k].get("fromUid")), "me": node[k].get("fromUid") == uid,
             "text": lite_text(node[k]), "ts": node[k].get("timestamp", 0)} for k in keys], more

def lite_send(uid, chat, text):
    text = (text or "")[:4000]
    if not text.strip() or not member(chat, uid): return None
    if (get_at(["privateChats", chat, "chatData", "encrypted"])): return None
    key = push_id(); ts = int(time.time() * 1000)
    ups = {"privateChats/%s/messages/%s" % (chat, key): {"fromUid": uid, "text": text, "timestamp": ts, "deliveredAt": ts},
           "privateChats/%s/lastMessage" % chat: {"fromUid": uid, "text": text, "timestamp": ts, "id": key},
           "privateChats/%s/messageRead/%s" % (chat, uid): key}
    for u in (get_at(["privateChats", chat, "participants"]) or {}):
        if u != uid: ups["live/%s/pings/%s" % (u, chat)] = {"id": key, "ts": ts, "from": uid}
    return key if apply_update(uid, ups)[0] else None

def lite_delete(uid, chat, key):
    if not member(chat, uid) or not isinstance(key, str): return False
    m = get_at(["privateChats", chat, "messages", key])
    if not isinstance(m, dict) or m.get("fromUid") != uid: return False
    ups = {"privateChats/%s/messages/%s" % (chat, key): None, "privateChats/%s/media/%s" % (chat, key): None}
    if (get_at(["privateChats", chat, "lastMessage"]) or {}).get("id") == key:       # keep the chat list's preview right in the normal app
        rest = [k for k in sorted(get_at(["privateChats", chat, "messages"]) or {}) if k != key]
        prev = get_at(["privateChats", chat, "messages", rest[-1]]) if rest else None
        ups["privateChats/%s/lastMessage" % chat] = ({"fromUid": prev.get("fromUid"), "text": prev.get("text", "") if not prev.get("enc") else "", "timestamp": prev.get("timestamp", 0), "id": rest[-1]} if prev else {"fromUid": "", "text": "(No messages yet)", "timestamp": int(time.time() * 1000)})
    return apply_update(uid, ups)[0]

def lite_newchat(uid, email):
    other = BY_EMAIL.get((email or "").strip().lower())
    if not other: return None
    chat = push_id(); ts = int(time.time() * 1000)
    ok, _ = apply_update(uid, {"privateChats/" + chat: {"participants": {uid: True, other: True}, "lastMessage": {"fromUid": "", "text": "(No messages yet)", "timestamp": ts}},
                               "chatList/%s/%s" % (uid, chat): True, "chatList/%s/%s" % (other, chat): True})
    return chat if ok else None

# ---------------------------------------------------------------- HTTP
HIDDEN = re.compile(r"(^|/)(server|data|qm-data|functions|android|ios|incoming|docs|\.github|downloads/.*\.(ipa|apk))(/|$)|\.(php|zip|md|py|pyc)$|^secrets|database\.rules", re.I)
PRIVATE_FLAG = b'<script>window.__QM_PRIVATE=1</script>'

class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "QuickMessagePrivate/" + VERSION

    def log_message(self, fmt, *a):
        if os.environ.get("QM_VERBOSE"): sys.stderr.write("%s %s\n" % (self.address_string(), fmt % a))

    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Name")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")

    def send_json(self, code, obj):
        b = json.dumps(obj, separators=(",", ":")).encode()
        self.send_response(code); self.cors()
        self.send_header("Content-Type", "application/json; charset=utf-8"); self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > CFG["max_body"]: raise ValueError("too large")
        return self.rfile.read(n) if n else b""

    def jbody(self):
        b = self.body()
        try: return json.loads(b.decode("utf-8")) if b else {}
        except Exception: return {}

    def auth(self, q=None):
        h = self.headers.get("Authorization") or ""
        tok = h[7:] if h.startswith("Bearer ") else (q or {}).get("token", [""])[0]
        return check_token(tok) if tok else None

    def do_OPTIONS(self):
        self.send_response(204); self.cors(); self.send_header("Content-Length", "0"); self.end_headers()

    def do_GET(self): self.route("GET")
    def do_POST(self): self.route("POST")
    def do_PUT(self): self.route("PUT")
    def do_PATCH(self): self.route("PATCH")
    def do_DELETE(self): self.route("DELETE")

    def route(self, method):
        u = urlparse(self.path); q = parse_qs(u.query)
        try:
            if u.path.startswith("/api/"): return self.api(method, u.path[5:], q)
            if u.path.startswith("/db/"): return self.rest(method, u.path[4:], q)
            if u.path.startswith("/files/"): return self.serve_file(os.path.join(CFG["data"], "files", os.path.basename(unquote(u.path))), download=True)
            return self.static(u.path)
        except (BrokenPipeError, ConnectionResetError): pass
        except ValueError as e: self.send_json(400, {"error": str(e)})
        except Exception as e:
            sys.stderr.write("error: %r\n" % (e,))
            try: self.send_json(500, {"error": "server error"})
            except Exception: pass

    # ---- static
    def static(self, path):
        path = unquote(path)
        if path in ("", "/"): path = "/index.html"
        rel = os.path.normpath(path.lstrip("/"))
        if rel.startswith("..") or HIDDEN.search(rel.replace(os.sep, "/")): return self.send_json(404, {"error": "not found"})
        fp = os.path.join(ROOT, rel)
        if os.path.isdir(fp): fp = os.path.join(fp, "index.html")
        return self.serve_file(fp)

    def serve_file(self, fp, download=False):
        if not os.path.isfile(fp): return self.send_json(404, {"error": "not found"})
        ctype = mimetypes.guess_type(fp)[0] or "application/octet-stream"
        if fp.endswith(".js"): ctype = "text/javascript"
        data = open(fp, "rb").read()
        if fp.endswith(".html"):
            data = re.sub(rb"(<head[^>]*>)", lambda m: m.group(1) + PRIVATE_FLAG, data, count=1, flags=re.I)
        self.send_response(200); self.cors()
        self.send_header("Content-Type", ctype + ("; charset=utf-8" if ctype.startswith("text/") else ""))
        self.send_header("Cache-Control", "no-cache")
        if download: self.send_header("Content-Disposition", "inline")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)

    # ---- API
    def api(self, method, name, q):
        if name == "time": return self.send_json(200, {"now": int(time.time() * 1000)})
        if name == "ping": return self.send_json(200, {"ok": True, "server": "quickmessage-private", "version": VERSION, "signup": CFG["signup"]})
        if name == "auth/signup":
            d = self.jbody()
            if not CFG["signup"]: return self.send_json(403, {"error": "Sign-ups are closed on this server. Ask the owner to add you."})
            try: u = create_user(d.get("email"), d.get("password"))
            except ValueError as e: return self.send_json(400, {"error": str(e), "code": "auth/invalid"})
            return self.send_json(200, {"token": make_token(u["uid"]), "user": user_json(u)})
        if name == "auth/login":
            d = self.jbody()
            try: u = login(d.get("email"), d.get("password"))
            except ValueError as e: return self.send_json(401, {"error": str(e), "code": "auth/invalid-credential"})
            return self.send_json(200, {"token": make_token(u["uid"]), "user": user_json(u)})
        uid = self.auth(q)
        if not uid: return self.send_json(401, {"error": "Not signed in", "code": "auth/expired"})
        u = USERS[uid]
        if name == "auth/me": return self.send_json(200, {"token": make_token(uid), "user": user_json(u)})
        if name == "auth/password":
            d = self.jbody()
            if not hmac.compare_digest(u["hash"], hash_pw(d.get("old") or "", bytes.fromhex(u["salt"]))): return self.send_json(401, {"error": "Wrong password.", "code": "auth/wrong-password"})
            if len(d.get("new") or "") < 6: return self.send_json(400, {"error": "The password needs at least 6 characters."})
            salt = secrets.token_bytes(16); u["salt"] = salt.hex(); u["hash"] = hash_pw(d["new"], salt); save_soon()
            return self.send_json(200, {"ok": True})
        if name == "auth/delete":
            d = self.jbody()
            if not hmac.compare_digest(u["hash"], hash_pw(d.get("password") or "", bytes.fromhex(u["salt"]))): return self.send_json(401, {"error": "Wrong password."})
            with LOCK:
                USERS.pop(uid, None); BY_EMAIL.pop(u["email"].lower(), None)
                apply_update(uid, {"accsettings/" + uid: None, "userKeys/" + uid: None, "chatList/" + uid: None, "live/" + uid: None, "FCM/" + uid: None}, trusted=True)
            return self.send_json(200, {"ok": True})
        if name == "lookup":                         # replaces email-lookup.php
            e = (q.get("email", [""])[0] or "").strip().lower(); t = BY_EMAIL.get(e)
            return self.send_json(200, {"uid": t, "found": bool(t)})
        if name == "db/get":
            d = self.jbody(); pp = parts(d.get("path"))
            if not can_read(uid, pp): return self.send_json(403, {"error": "permission denied"})
            with LOCK:
                node = get_at(pp)
                if d.get("query"): return self.send_json(200, {"items": run_query(node, d["query"])})
                return self.send_json(200, {"v": node})
        if name == "db/update":
            d = self.jbody(); ok, err = apply_update(uid, d.get("updates") or {})
            return self.send_json(200 if ok else 403, {"ok": ok, "error": err})
        if name == "db/tx":                          # compare-and-set for transactions: {path, expect, value}
            d = self.jbody(); pp = parts(d.get("path"))
            with LOCK:
                if json.dumps(get_at(pp), sort_keys=True) != json.dumps(d.get("expect"), sort_keys=True): return self.send_json(200, {"ok": False, "conflict": True, "current": get_at(pp)})
                ok, err = apply_update(uid, {d["path"]: d.get("value")})
            return self.send_json(200, {"ok": ok, "error": err})
        if name == "stream": return self.stream(uid, q)
        if name in ("listen", "unlisten", "ondisconnect"):
            d = self.jbody(); c = CLIENTS.get(d.get("cid"))
            if not c or c.uid != uid: return self.send_json(404, {"error": "no stream"})
            if name == "listen":
                ok = add_listener(c, d["lid"], d.get("path"), d.get("query"), d.get("mode") or "value")
                return self.send_json(200 if ok else 403, {"ok": ok})
            if name == "unlisten": c.listeners.pop(d.get("lid"), None); return self.send_json(200, {"ok": True})
            if d.get("cancel"): c.ondisc.pop(d["id"], None)
            else: c.ondisc[d["id"]] = d.get("updates") or {}
            return self.send_json(200, {"ok": True})
        if name == "upload":                         # a file stored on this server: returns its address
            data = self.body(); fn = re.sub(r"[^\w.\-]+", "_", unquote(self.headers.get("X-Name") or "file"))[-80:]
            os.makedirs(os.path.join(CFG["data"], "files"), exist_ok=True)
            fid = secrets.token_urlsafe(9) + "-" + fn
            with open(os.path.join(CFG["data"], "files", fid), "wb") as f: f.write(data)
            return self.send_json(200, {"url": "files/" + fid, "size": len(data)})
        # ---- lite
        if name == "lite/chats": return self.send_json(200, {"me": display_name(uid), "chats": lite_chats(uid)})
        if name == "lite/messages":
            r = lite_messages(uid, q.get("chat", [""])[0], q.get("after", [""])[0], q.get("before", [""])[0])
            return self.send_json(200 if r is not None else 403, {"messages": r[0] if r else [], "more": bool(r and r[1])})
        if name == "lite/send":
            d = self.jbody(); k = lite_send(uid, d.get("chat"), d.get("text")); return self.send_json(200, {"ok": bool(k), "key": k})
        if name == "lite/delete":
            d = self.jbody(); return self.send_json(200, {"ok": lite_delete(uid, d.get("chat"), d.get("key"))})
        if name == "lite/newchat":
            d = self.jbody(); c = lite_newchat(uid, d.get("email")); return self.send_json(200 if c else 404, {"chat": c, "error": None if c else "No account with that email."})
        return self.send_json(404, {"error": "unknown api"})

    # ---- Firebase-REST look-alike (/db/<path>.json?auth=TOKEN): what the Android / iPhone apps' background service talks to.
    # Supports GET (with orderBy / limitToLast / limitToFirst / startAt / endAt / equalTo), PUT, PATCH, POST, DELETE and the text/event-stream "put" events.
    def rest(self, method, rest_path, q):
        uid = self.auth({"token": q.get("auth", [""])})
        if not uid: return self.send_json(401, {"error": "Permission denied"})
        path = unquote(rest_path)
        if path.endswith(".json"): path = path[:-5]
        pp = parts(path)
        if method == "GET" and "text/event-stream" in (self.headers.get("Accept") or ""): return self.rest_stream(uid, pp)
        if method == "GET":
            if not can_read(uid, pp): return self.send_json(401, {"error": "Permission denied"})
            with LOCK:
                node = get_at(pp)
                query = {}
                ob = (q.get("orderBy", [""])[0] or "").strip('"')
                if ob: query["orderBy"] = "key" if ob == "$key" else "value" if ob == "$value" else "child:" + ob
                for qk, name in (("limitToLast", "limitLast"), ("limitToFirst", "limitFirst")):
                    if qk in q: query[name] = int(q[qk][0])
                for qk in ("startAt", "endAt", "equalTo"):
                    if qk in q:
                        try: query[qk] = json.loads(q[qk][0])
                        except Exception: query[qk] = q[qk][0]
                if query and isinstance(node, dict): return self.send_json(200, {k: v for k, v in run_query(node, query)})
                return self.send_json(200, node)
        body = self.jbody() if method != "DELETE" else None
        key = "/".join(pp)
        if method == "PUT": ups = {key: body}
        elif method == "DELETE": ups = {key: None}
        elif method == "PATCH":
            if not isinstance(body, dict): return self.send_json(400, {"error": "bad body"})
            ups = {(key + "/" + k if key else k): v for k, v in body.items()}
        elif method == "POST":
            nid = push_id(); ups = {(key + "/" + nid if key else nid): body}
        else: return self.send_json(405, {"error": "method"})
        ok, err = apply_update(uid, ups)
        if not ok: return self.send_json(401, {"error": "Permission denied"})
        return self.send_json(200, {"name": nid} if method == "POST" else body)

    def rest_stream(self, uid, pp):
        if not can_read(uid, pp): return self.send_json(401, {"error": "Permission denied"})
        c = Client("rest" + secrets.token_hex(8), uid)
        with LOCK: CLIENTS[c.cid] = c
        self.send_response(200); self.cors()
        self.send_header("Content-Type", "text/event-stream"); self.send_header("Cache-Control", "no-store"); self.send_header("Connection", "close"); self.end_headers()
        def emit(event, path, data):
            self.wfile.write(("event: %s\ndata: %s\n\n" % (event, json.dumps({"path": path, "data": data}, separators=(",", ":")))).encode()); self.wfile.flush()
        prev = None
        try:
            add_listener(c, "r", "/".join(pp), None, "value")
            while c.alive:
                try: ev = c.q.get(timeout=8)
                except queue.Empty: self.wfile.write(b"event: keep-alive\ndata: null\n\n"); self.wfile.flush(); continue
                new = ev.get("v")
                if prev is None: emit("put", "/", new)                                   # everything that is there now
                else:                                                                      # then only what changed (two levels deep, like the app expects: /kind/key)
                    a = prev if isinstance(prev, dict) else {}; b = new if isinstance(new, dict) else {}
                    for k in set(a) | set(b):
                        if a.get(k) == b.get(k): continue
                        av, bv = a.get(k), b.get(k)
                        if isinstance(av, dict) or isinstance(bv, dict):
                            av = av if isinstance(av, dict) else {}; bv = bv if isinstance(bv, dict) else {}
                            for k2 in set(av) | set(bv):
                                if av.get(k2) != bv.get(k2): emit("put", "/%s/%s" % (k, k2), bv.get(k2))
                        else: emit("put", "/" + k, bv)
                prev = new if new is not None else {}
        except (BrokenPipeError, ConnectionResetError, OSError): pass
        finally: drop_client(c); self.close_connection = True

    def stream(self, uid, q):
        cid = q.get("cid", [""])[0]
        if not re.match(r"^[\w-]{6,64}$", cid): return self.send_json(400, {"error": "bad cid"})
        c = Client(cid, uid)
        with LOCK: CLIENTS[cid] = c
        self.send_response(200); self.cors()
        self.send_header("Content-Type", "text/event-stream"); self.send_header("Cache-Control", "no-store"); self.send_header("X-Accel-Buffering", "no")
        self.send_header("Connection", "close"); self.end_headers()
        try:
            self.wfile.write(b"retry: 2000\n\nevent: hello\ndata: {}\n\n"); self.wfile.flush()
            while c.alive:
                try: ev = c.q.get(timeout=8)
                except queue.Empty: ev = None
                self.wfile.write((b": keepalive\n\n" if ev is None else b"data: " + json.dumps(ev, separators=(",", ":")).encode() + b"\n\n")); self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError): pass
        finally: drop_client(c); self.close_connection = True

class Server(ThreadingHTTPServer):
    daemon_threads = True; allow_reuse_address = True; request_queue_size = 128

def main():
    ap = argparse.ArgumentParser(description="QuickMessage private server")
    ap.add_argument("cmd", nargs="?", choices=["serve", "adduser", "passwd", "listusers"], default="serve")
    ap.add_argument("args", nargs="*")
    ap.add_argument("--host", default="0.0.0.0"); ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--data", default=os.path.join(os.getcwd(), "qm-data"), help="folder for the database, users and uploaded files")
    ap.add_argument("--no-signup", action="store_true", help="only accounts made with 'adduser' can log in")
    a = ap.parse_args()
    CFG["data"] = os.path.abspath(a.data); CFG["signup"] = not a.no_signup
    os.makedirs(CFG["data"], exist_ok=True); load()
    if a.cmd == "adduser":
        if len(a.args) != 2: sys.exit("usage: qm_server.py adduser EMAIL PASSWORD")
        u = create_user(a.args[0], a.args[1]); _write_atomic("users.json", USERS); print("created", u["email"]); return
    if a.cmd == "passwd":
        if len(a.args) != 2: sys.exit("usage: qm_server.py passwd EMAIL NEWPASSWORD")
        uid = BY_EMAIL.get(a.args[0].lower()) or sys.exit("no such user")
        salt = secrets.token_bytes(16); USERS[uid]["salt"] = salt.hex(); USERS[uid]["hash"] = hash_pw(a.args[1], salt); _write_atomic("users.json", USERS); print("ok"); return
    if a.cmd == "listusers":
        for u in USERS.values(): print(u["email"], u["created"])
        return
    srv = Server((a.host, a.port), H)
    print("QuickMessage private server %s\n  open  http://localhost:%d/\n  data  %s\n  sign-ups: %s\n  Ctrl+C to stop" % (VERSION, a.port, CFG["data"], "open" if CFG["signup"] else "closed"))
    try: srv.serve_forever()
    except KeyboardInterrupt: pass
    finally:
        with LOCK: _write_atomic("db.json", TREE); _write_atomic("users.json", USERS)

if __name__ == "__main__":
    main()
