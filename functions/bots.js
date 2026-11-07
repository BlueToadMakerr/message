// QuickMessage bot API. Runs inside Firebase (Cloud Functions), NOT on the web host, so it keeps working even though free hosts such as
// InfinityFree block or challenge server-to-server requests. The same routes exist on the private server (server/qm_server.py, /api/bot/...).
//
// A bot is a pseudo account:   bots/{botId}              { owner, created, name, pfp }   public: lets everyone see who owns it
//                              accsettings/{botId}/settings   { displayName, pfp }      so every existing screen shows it like a person
//                              botKeys/{botId}           { th, webhook }                 th = sha256 of the token (hex); webhook = optional https url
// The owner makes it on the Bots page (bots.html), then adds it to chats. Token format: qmbot.<botId>.<secret>. Only its hash is stored.
//
// Routes (JSON, header  Authorization: Bearer <token>):
//   GET    /me                          the bot's profile
//   PATCH  /me          {name, pfp}     change the bot's own default name and picture
//   GET    /chats                       chats the bot was added to
//   GET    /members?chat=               members of one of those chats
//   GET    /messages?chat=&after=&limit=   newest messages (plain ones; encrypted ones come back with encrypted:true and no text)
//   POST   /send        {chat, text, as:{name,pfp}, src, replyTo, file}   post a message. "as" changes name/picture for this one message
//                       (a Discord user, say) and "src" says where it came from ("Discord"). Every bot message carries botId.
//   PATCH  /message     {chat, id, text}    edit one of the bot's own messages
//   DELETE /message     {chat, id}          delete one of the bot's own messages
const crypto = require("crypto");

const BOT_RE = /^bot_[a-z0-9]{12}$/;
const TOKEN_RE = /^qmbot\.(bot_[a-z0-9]{12})\.([A-Za-z0-9_-]{32,64})$/;
const CHAT_RE = /^[\w-]{1,64}$/;
const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");
const clean = (s, n) => String(s ?? "").replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, " ").trim().slice(0, n);
const httpsUrl = (u, n) => { u = String(u ?? "").trim(); return /^https:\/\/[^\s]+$/i.test(u) && u.length <= n ? u : ""; };
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (m, s = 400) => { throw new HttpError(s, m); };
exports.HttpError = HttpError;
exports.sha256 = sha256;
exports.BOT_RE = BOT_RE;

// at most 20 posts per 10 seconds per bot (per server instance; enough to stop a runaway loop)
const hits = new Map();
const limited = id => { const now = Date.now(), a = (hits.get(id) || []).filter(t => now - t < 10000); a.push(now); hits.set(id, a); return a.length > 20; };

async function authBot(db, token) {
  const m = TOKEN_RE.exec(String(token || "").trim());
  if (!m) bad("Missing or malformed bot token.", 401);
  const [, id] = m;
  const th = await db.get(`botKeys/${id}/th`);
  const a = Buffer.from(String(th || "")), b = Buffer.from(sha256(m[0]));
  if (!th || a.length !== b.length || !crypto.timingSafeEqual(a, b)) bad("Wrong bot token.", 401);
  const bot = await db.get(`bots/${id}`);
  if (!bot) bad("This bot was deleted.", 401);
  return { id, bot };
}

const inChat = async (db, id, chat) => {
  if (!CHAT_RE.test(String(chat || ""))) bad("chat is required.");
  const p = await db.get(`privateChats/${chat}/participants/${id}`);
  if (p !== true) bad("This bot is not in that chat.", 403);
};
const nameOf = async (db, uid) => (await db.get(`accsettings/${uid}/settings/displayName`)) || "Unknown";

/** One stored message -> what a bot sees. */
async function view(db, id, key, m, names) {
  const who = async u => names.has(u) ? names.get(u) : (names.set(u, await nameOf(db, u)), names.get(u));
  const o = { id: key, chat: undefined, fromUid: m.fromUid, from: m.as && m.as.name ? m.as.name : await who(m.fromUid), fromBot: typeof m.botId === "string" ? m.botId : null,
    fromMe: m.fromUid === id, type: m.type || "text", timestamp: m.timestamp || 0, edited: !!m.editedAt };
  if (m.src) o.src = m.src;
  if (m.enc) { o.encrypted = true; o.text = null; }
  else {
    o.text = m.type === "file" ? (m.name || "") : (typeof m.text === "string" ? m.text : typeof m.content === "string" && m.type === "text" ? m.content : null);
    if (m.type === "file") o.file = { url: m.url || "", name: m.name || "", kind: m.kind || "file", mime: m.mime || "", size: m.size || 0 };
  }
  if (m.replyTo && m.replyTo.key) o.replyTo = { key: m.replyTo.key, uid: m.replyTo.uid };
  delete o.chat; return o;
}
exports.view = view;

/** @param db  { get(path), update(multiPathObject), messages(chat, {after, limit}) -> {key: msg}, newKey() }
 *  @param req { method, path, query, body, token }   @returns {status, json} (throws HttpError) */
exports.handle = async function handle(db, req) {
  const { id, bot } = await authBot(db, req.token);
  const route = req.method + " " + String(req.path || "/").replace(/\/+$/, "");
  const q = req.query || {}, b = req.body && typeof req.body === "object" ? req.body : {};
  const now = () => Date.now();

  if (route === "GET /me") {
    const s = (await db.get(`accsettings/${id}/settings`)) || {};
    return { id, name: s.displayName || bot.name, pfp: s.pfp || "", owner: bot.owner, created: bot.created, webhook: !!(await db.get(`botKeys/${id}/webhook`)) };
  }
  if (route === "PATCH /me") {
    const up = {};
    if (b.name !== undefined) { const n = clean(b.name, 100); if (!n) bad("name can't be empty."); up[`accsettings/${id}/settings/displayName`] = n; up[`bots/${id}/name`] = n; }
    if (b.pfp !== undefined) { const u = b.pfp === "" || b.pfp === null ? "" : httpsUrl(b.pfp, 2000); if (b.pfp && !u) bad("pfp must be an https:// address."); up[`accsettings/${id}/settings/pfp`] = u || null; up[`bots/${id}/pfp`] = u || null; }
    if (!Object.keys(up).length) bad("Send name and/or pfp.");
    await db.update(up);
    return { ok: true };
  }
  if (route === "GET /chats") {
    const list = (await db.get(`chatList/${id}`)) || {}, out = [];
    for (const chat of Object.keys(list).slice(0, 200)) {
      if ((await db.get(`privateChats/${chat}/participants/${id}`)) !== true) continue;
      const cd = (await db.get(`privateChats/${chat}/chatData`)) || {};
      out.push({ id: chat, name: cd.name || "", encrypted: cd.encrypted === true });
    }
    return { chats: out };
  }
  if (route === "GET /members") {
    await inChat(db, id, q.chat);
    const p = (await db.get(`privateChats/${q.chat}/participants`)) || {};
    const members = await Promise.all(Object.keys(p).map(async u => ({ uid: u, name: await nameOf(db, u), bot: BOT_RE.test(u) })));
    return { members };
  }
  if (route === "GET /messages") {
    await inChat(db, id, q.chat);
    const limit = Math.max(1, Math.min(100, parseInt(q.limit, 10) || 30));
    const all = await db.messages(q.chat, { after: q.after ? String(q.after) : "", limit });
    const names = new Map(), out = [];
    for (const key of Object.keys(all).sort()) if (all[key].type !== "event") out.push(await view(db, id, key, all[key], names));
    return { messages: out };
  }
  if (route === "POST /send") {
    await inChat(db, id, b.chat);
    if (limited(id)) bad("Slow down: at most 20 messages per 10 seconds.", 429);
    if ((await db.get(`privateChats/${b.chat}/chatData/encrypted`)) === true) { /* allowed: the message is simply not end-to-end encrypted */ }
    const ts = now(), key = db.newKey(), msg = { fromUid: id, botId: id, timestamp: ts, deliveredAt: ts, type: "text" };
    let preview;
    if (b.file) {
      const url = httpsUrl(b.file.url, 300); if (!url) bad("file.url must be an https:// address of at most 300 characters.");
      const kind = ["image", "video", "audio", "file"].includes(b.file.kind) ? b.file.kind : "file";
      Object.assign(msg, { type: "file", url, name: clean(b.file.name || url.split("/").pop(), 300) || "file", kind, mime: clean(b.file.mime, 120) || undefined, size: Number.isFinite(+b.file.size) ? +b.file.size : undefined });
      for (const k of Object.keys(msg)) if (msg[k] === undefined) delete msg[k];
      msg.text = msg.name; preview = "📎 " + msg.name;
    } else {
      const text = String(b.text ?? "").slice(0, 4000); if (!text.trim()) bad("text is required.");
      msg.text = text; preview = text.slice(0, 300);
    }
    if (b.as && typeof b.as === "object") {
      const as = {}, n = clean(b.as.name, 80), p = httpsUrl(b.as.pfp, 600);
      if (n) as.name = n; if (p) as.pfp = p;
      if (Object.keys(as).length) msg.as = as;
    }
    const src = clean(b.src, 30); if (src) msg.src = src;
    if (b.replyTo && typeof b.replyTo === "object" && typeof b.replyTo.key === "string") {
      const r = await db.get(`privateChats/${b.chat}/messages/${b.replyTo.key}`);
      if (r && !r.enc) msg.replyTo = { key: b.replyTo.key, uid: r.fromUid, text: String(r.text ?? r.name ?? "").slice(0, 700) };
    }
    const members = Object.keys((await db.get(`privateChats/${b.chat}/participants`)) || {});
    const up = { [`privateChats/${b.chat}/messages/${key}`]: msg,
      [`privateChats/${b.chat}/lastMessage`]: { fromUid: id, text: preview.slice(0, 300), timestamp: ts, id: key } };
    for (const u of members) if (u !== id && !BOT_RE.test(u)) up[`live/${u}/pings/${b.chat}`] = { id: key, ts, from: id };
    await db.update(up);
    return { id: key, timestamp: ts };
  }
  if (route === "PATCH /message" || route === "DELETE /message") {
    const chat = b.chat || q.chat, key = String(b.id || q.id || "");
    await inChat(db, id, chat);
    if (!/^[\w-]{1,40}$/.test(key)) bad("id is required.");
    const m = await db.get(`privateChats/${chat}/messages/${key}`);
    if (!m) bad("No such message.", 404);
    if (m.fromUid !== id) bad("A bot can only change its own messages.", 403);
    if (req.method === "PATCH") {
      const text = String(b.text ?? "").slice(0, 4000); if (!text.trim()) bad("text is required."); if (m.type !== "text") bad("Only text messages can be edited.");
      const up = { [`privateChats/${chat}/messages/${key}/text`]: text, [`privateChats/${chat}/messages/${key}/editedAt`]: now() };
      if ((await db.get(`privateChats/${chat}/lastMessage/id`)) === key) up[`privateChats/${chat}/lastMessage/text`] = text.slice(0, 300);
      await db.update(up); return { ok: true };
    }
    const up = { [`privateChats/${chat}/messages/${key}`]: null, [`privateChats/${chat}/media/${key}`]: null };
    await db.update(up); return { ok: true };
  }
  bad("Unknown route " + route, 404);
};

/** Tells every bot that is in the chat (and has a webhook) about a new message. Signed with HMAC-SHA256 (key = the token's sha256 hex). */
exports.webhookTargets = async function (db, chat, msg, key) {
  const members = Object.keys((await db.get(`privateChats/${chat}/participants`)) || {}).filter(u => BOT_RE.test(u) && u !== msg.botId);
  const out = [];
  for (const id of members) {
    const k = await db.get(`botKeys/${id}`);
    const url = k && httpsUrl(k.webhook, 300);
    if (!url || !k.th) continue;
    let host = ""; try { host = new URL(url).hostname; } catch (_) { continue; }
    if (/^(localhost|\[.*\])$|^\d+\.\d+\.\d+\.\d+$|\.local$|\.internal$/i.test(host)) continue;          // no IP literals / internal names
    const names = new Map();
    const payload = { event: "message", bot: id, chat, message: await view(db, id, key, msg, names) };
    const body = JSON.stringify(payload);
    out.push({ url, body, signature: crypto.createHmac("sha256", k.th).update(body).digest("hex") });
  }
  return out;
};
