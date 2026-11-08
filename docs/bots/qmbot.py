"""Tiny QuickMessage bot client. A bot talks to the worker THROUGH THE DATABASE (no web address, no open port):

    request  ->  PUT  <db>/botInbox/<botId>/<reqId>.json     {token, op, ts, ...arguments}      (the database rules check the token)
    answer   <-  GET  <db>/botOutbox/<botId>/<reqId>.json    {status, body: "<json>", ts}       (then DELETE it)
    messages <-  GET  <db>/botEvents/<botId>/<sha256(token)>.json?orderBy="$key"&startAt=...     new messages in the bot's chats

Needs the worker (worker/qm_worker.py) to be running. `pip install requests`.

    from qmbot import QMBot
    bot = QMBot(token="qmbot.bot_xxx.yyy", db_url="https://YOURPROJECT-default-rtdb.firebaseio.com")
    bot.send(chat_id, "Hello", as_name="Zed", as_pfp="https://example.com/z.png", src="Discord")
    for key, ev in bot.events(): print(ev["message"]["from"], ev["message"]["text"])
"""
import hashlib, json, re, secrets, time

TOKEN_RE = re.compile(r"^qmbot\.(bot_[a-z0-9]{12})\.[A-Za-z0-9_-]{32,64}$")


class QMError(Exception):
    def __init__(self, status, msg):
        super().__init__(f"{status}: {msg}")
        self.status = status


class RestTransport:
    """The three database calls the client needs, over the Realtime Database REST API (no sign-in)."""
    def __init__(self, db_url, timeout=15):
        import requests
        self.r, self.base, self.timeout = requests.Session(), db_url.rstrip("/"), timeout

    def put(self, path, value):
        x = self.r.put(f"{self.base}/{path}.json", data=json.dumps(value), timeout=self.timeout)
        if x.status_code == 401 or x.status_code == 403: raise QMError(401, "The database refused the request: wrong or outdated token? (Make a new token on the Bots page; bots made before the database transport need one.)")
        x.raise_for_status()

    def get(self, path, params=None):
        x = self.r.get(f"{self.base}/{path}.json", params=params, timeout=self.timeout)
        x.raise_for_status()
        return x.json()

    def delete(self, path):
        try: self.r.delete(f"{self.base}/{path}.json", timeout=self.timeout)
        except Exception: pass


class QMBot:
    def __init__(self, token, db_url=None, transport=None, timeout=20):
        m = TOKEN_RE.match(token.strip())
        if not m: raise ValueError("That doesn't look like a bot token (qmbot.bot_xxx.yyy).")
        self.token, self.id, self.timeout = token.strip(), m.group(1), timeout
        self.feed = hashlib.sha256(self.token.encode()).hexdigest()
        self.t = transport or RestTransport(db_url)

    def call(self, op, **args):
        """Sends one request and waits for the worker's answer. Raises QMError (status, message). Retries are safe (same request id)."""
        rid = secrets.token_urlsafe(18)
        req = {"token": self.token, "op": op, "ts": int(time.time() * 1000), **{k: v for k, v in args.items() if v is not None}}
        for attempt in range(3):
            try: self.t.put(f"botInbox/{self.id}/{rid}", req); break
            except QMError: raise
            except Exception:
                if attempt == 2: raise
                time.sleep(1)
        end, wait = time.time() + self.timeout, 0.2
        while time.time() < end:
            try: ans = self.t.get(f"botOutbox/{self.id}/{rid}")
            except Exception: ans = None
            if ans:
                self.t.delete(f"botOutbox/{self.id}/{rid}")
                body = json.loads(ans.get("body") or "{}")
                if ans.get("status") != 200: raise QMError(ans.get("status"), body.get("error", "error"))
                return body
            time.sleep(wait); wait = min(1.0, wait * 1.4)
        raise QMError(504, "No answer: is the worker running? (see status.html)")

    # ---- the API
    def me(self): return self.call("me")
    def set_profile(self, name=None, pfp=None): return self.call("setProfile", name=name, pfp=pfp)
    def chats(self): return self.call("chats").get("chats", [])
    def members(self, chat): return self.call("members", chat=chat).get("members", [])
    def messages(self, chat, after=None, limit=30): return self.call("messages", chat=chat, after=after, limit=limit).get("messages", [])
    def send(self, chat, text=None, as_name=None, as_pfp=None, src=None, reply_to=None, file=None):
        a = {k: v for k, v in (("name", as_name), ("pfp", as_pfp)) if v}
        return self.call("send", chat=chat, text=text, **({"as": a} if a else {}), src=src, **({"replyTo": {"key": reply_to}} if reply_to else {}), **({"file": file} if file else {}))
    def edit(self, chat, id, text): return self.call("edit", chat=chat, id=id, text=text)
    def delete(self, chat, id): return self.call("delete", chat=chat, id=id)

    # ---- new messages
    def latest_event_key(self):
        d = self.t.get(f"botEvents/{self.id}/{self.feed}", {"orderBy": '"$key"', "limitToLast": 1}) or {}
        return max(d) if d else ""

    def events(self, after=""):
        """[(key, {event, bot, chat, message})] newer than `after` (a key from a previous call; "" = everything kept, about the last hour)."""
        p = {"orderBy": '"$key"', "limitToFirst": 100}
        if after: p["startAt"] = json.dumps(after)
        d = self.t.get(f"botEvents/{self.id}/{self.feed}", p) or {}
        return [(k, json.loads(d[k]["body"])) for k in sorted(d) if k > after]
