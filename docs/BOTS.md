# Bots

A bot is an account a program controls. Make one in **Account → Bots**, copy its token (shown once), then open a chat → chat options → **Add one of my bots…**.

Bots talk to your **worker** (`worker/qm_worker.py`, no Blaze plan needed) **through the database**, so there is nothing to expose and nothing on the web host: a bot writes a request into the database, the worker processes it and writes the answer. Bots only work while the worker runs: `status.html` and the Account / Bots pages show whether it is up. (On the private server the same operations are plain HTTP at `/api/bot/...`; the worker can also serve that with `--http-api`.)

**The database protocol** (REST, no sign-in; `docs/bots/qmbot.py` does all of this for you):

1. Request: `PUT <db>/botInbox/<botId>/<reqId>.json` with `{"token": "<token>", "op": "<op>", "ts": <ms>, ...arguments}`. `reqId` is 20 to 64 random characters (`A-Za-z0-9_-`). The database rules accept the write only if the token is the bot's real token, so nobody else can write a request; nobody can read the inbox.
2. Answer: poll `GET <db>/botOutbox/<botId>/<reqId>.json` until it isn't `null`: `{"status": 200, "body": "<json string>", "ts": ...}`. Then `DELETE` it (unread answers are removed after 5 minutes). The random `reqId` is the key to read it, so keep it secret. Retrying a request with the same `reqId` is safe: it runs once.
3. New messages: `GET <db>/botEvents/<botId>/<sha256 hex of token>.json?orderBy="$key"&startAt="<last key>"` returns `{key: {"ts", "body": "<json>"}}` with `body` = `{event:"message", bot, chat, message}`. Events are kept for an hour. Your bot's own messages never appear.

Ops and arguments (the answer `body` is the JSON shown for the HTTP routes below):

| Request (HTTP route = database `op`) | What it does |
|---|---|
| `GET /me` = `me` | The bot's profile |
| `PATCH /me {name, pfp}` = `setProfile` | The bot changes its own default name / picture (`pfp` is an https address) |
| `GET /chats` = `chats` | Chats the bot was added to |
| `GET /members?chat=` = `members` | Members of a chat |
| `GET /messages?chat=&after=<id>&limit=` = `messages` | Messages (oldest first). Encrypted ones come back `encrypted:true` with no text |
| `POST /send {chat, text, as:{name,pfp}, src, replyTo:{key}, file:{url,name,kind,mime,size}}` = `send` | Post a message |
| `PATCH /message {chat,id,text}` = `edit`, `DELETE /message {chat,id}` = `delete` | Edit or delete the bot's own messages |

**Who posted what.** Every bot message is stored with `botId` (the bot that really posted it). `as` lets the bot show another name/picture for just that message (a Discord user) and `src` says where it came from (`"Discord"`). The chat shows the chosen name and picture plus a **BOT** badge and the real bot's name and source. People can never write `botId`, `as` or `src` (the database rules forbid it), so a bot's identity can't be faked.

**Webhook (optional, instead of reading the event feed).** Set an https address on the bot's Edit screen and every new message in its chats is POSTed to it as `{event:"message", bot, chat, message}` with `X-QM-Signature` = HMAC-SHA256 of the body, key = SHA-256 (hex) of your token. The bot's own messages aren't sent back. Without a webhook, poll `GET /messages?after=`.

**Limits.** 20 posts per 10 seconds per bot, 4000 characters per message. A bot can't read or write end-to-end encrypted messages: what it posts in an encrypted chat is stored unencrypted, and the app warns about this when you add it.

**Safety.** The token is the bot's password (the owner can show it on the Bots page; the database rules compare it with the token in each request). A bot sees the plain messages in the chats you add it to; only add bots you control. "New token" on the Bots page replaces a leaked one at once.

`docs/bots/discord_bridge.py` is a ready-made two-way Discord ↔ QuickMessage bridge.
