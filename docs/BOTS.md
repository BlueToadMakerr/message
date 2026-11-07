# Bots

A bot is an account a program controls. Make one in **Account → Bots**, copy its token (shown once), then open a chat → chat options → **Add one of my bots…**.

The API runs on **Firebase (Cloud Functions)**, not on the web host, so it keeps working where the host (for example InfinityFree) blocks or challenges automated requests. On the private server the same routes are at `/api/bot/...`. Deploy: `firebase deploy --only functions` and republish `database.rules.json`.

Base address (shown on the Bots page): `https://us-central1-<project>.cloudfunctions.net/botApi`. Every request has `Authorization: Bearer <token>`.

| Request | What it does |
|---|---|
| `GET /me` | The bot's profile |
| `PATCH /me {name, pfp}` | The bot changes its own default name / picture (`pfp` is an https address) |
| `GET /chats` | Chats the bot was added to |
| `GET /members?chat=` | Members of a chat |
| `GET /messages?chat=&after=<id>&limit=` | Messages (oldest first). Encrypted ones come back `encrypted:true` with no text |
| `POST /send {chat, text, as:{name,pfp}, src, replyTo:{key}, file:{url,name,kind,mime,size}}` | Post a message |
| `PATCH /message {chat,id,text}` / `DELETE /message {chat,id}` | Edit or delete the bot's own messages |

**Who posted what.** Every bot message is stored with `botId` (the bot that really posted it). `as` lets the bot show another name/picture for just that message (a Discord user) and `src` says where it came from (`"Discord"`). The chat shows the chosen name and picture plus a **BOT** badge and the real bot's name and source. People can never write `botId`, `as` or `src` (the database rules forbid it), so a bot's identity can't be faked.

**Webhook (optional).** Set an https address on the bot's Edit screen and every new message in its chats is POSTed to it as `{event:"message", bot, chat, message}` with `X-QM-Signature` = HMAC-SHA256 of the body, key = SHA-256 (hex) of your token. The bot's own messages aren't sent back. Without a webhook, poll `GET /messages?after=`.

**Limits.** 20 posts per 10 seconds per bot, 4000 characters per message. A bot can't read or write end-to-end encrypted messages: what it posts in an encrypted chat is stored unencrypted, and the app warns about this when you add it.

**Safety.** The token is the bot's password (only its hash is stored). A bot sees the plain messages in the chats you add it to; only add bots you control. "New token" on the Bots page replaces a leaked one at once.

`docs/bots/discord_bridge.py` is a ready-made two-way Discord ↔ QuickMessage bridge.
