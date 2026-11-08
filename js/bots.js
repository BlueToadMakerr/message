// Bot accounts: create / manage / add to a chat. The bot API itself lives in functions/bots.js (Firebase) and server/qm_server.py (private server).
import { db } from "./firebase.js";
import { ref, get, set, update, remove } from "./sdk.js";
import { PRIVATE, privateBase } from "./mode.js";
import { activeDbUrl } from "./dburl.js";

const A = "abcdefghijklmnopqrstuvwxyz0123456789";
export const BOT_RE = /^bot_[a-z0-9]{12}$/;
export const isBotUid = u => typeof u === "string" && u.startsWith("bot_");

function randomChars(n, alphabet) {
  const out = [], lim = 256 - (256 % alphabet.length);
  while (out.length < n) for (const x of crypto.getRandomValues(new Uint8Array(32))) if (x < lim && out.length < n) out.push(alphabet[x % alphabet.length]);
  return out.join("");
}
export const newBotId = () => "bot_" + randomChars(12, A);
export function newToken(id) {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return `qmbot.${id}.` + btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export async function sha256Hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, "0")).join("");
}
/** Where bots connect. Private server: its HTTP address. Firebase: the database itself (bots write requests to botInbox, the worker answers). */
export function apiBase() {
  if (PRIVATE) return ((privateBase() || location.origin).replace(/\/+$/, "")) + "/api/bot";
  return activeDbUrl();
}
const cleanName = s => String(s || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 100);
const cleanUrl = (u, n) => { u = String(u || "").trim(); if (!u) return ""; if (!/^https:\/\/\S+$/i.test(u) || u.length > n) throw new Error("That must be an https:// address."); return u; };

/** Makes a bot and returns { id, token } (the token is shown once; only its hash is stored). */
export async function createBot(me, name, pfp) {
  name = cleanName(name); if (!name) throw new Error("Give the bot a name.");
  pfp = cleanUrl(pfp, 2000);
  const id = newBotId(), token = newToken(id);
  await set(ref(db, `bots/${id}`), { owner: me, created: Date.now(), name, ...(pfp ? { pfp } : {}) });     // first: the rules for the rest look at the owner
  await set(ref(db, `botList/${me}/${id}`), true);
  await set(ref(db, `accsettings/${id}/settings`), { displayName: name, ...(pfp ? { pfp } : {}) });
  await set(ref(db, `botKeys/${id}`), { th: await sha256Hex(token), token });         // the rules compare the token in a bot's request with this one
  return { id, token };
}
export async function listBots(me) {
  const ids = Object.keys((await get(ref(db, `botList/${me}`))).val() || {});
  const out = await Promise.all(ids.map(async id => {
    const [b, k] = await Promise.all([get(ref(db, `bots/${id}`)), get(ref(db, `botKeys/${id}`)).catch(() => null)]);
    return b.exists() ? { id, ...b.val(), webhook: (k && k.val() && k.val().webhook) || "", token: (k && k.val() && k.val().token) || "" } : null;
  }));
  return out.filter(Boolean).sort((a, b) => (a.created || 0) - (b.created || 0));
}
export async function saveBot(id, { name, pfp, webhook }) {
  name = cleanName(name); if (!name) throw new Error("Give the bot a name.");
  pfp = cleanUrl(pfp, 2000); webhook = cleanUrl(webhook, 300);
  await update(ref(db), { [`bots/${id}/name`]: name, [`bots/${id}/pfp`]: pfp || null, [`accsettings/${id}/settings/displayName`]: name, [`accsettings/${id}/settings/pfp`]: pfp || null, [`botKeys/${id}/webhook`]: webhook || null });
}
export async function regenerateToken(id) {
  const token = newToken(id);
  await update(ref(db, `botKeys/${id}`), { th: await sha256Hex(token), token });
  return token;
}
export async function deleteBot(me, id) {
  await remove(ref(db, `botKeys/${id}`)); await remove(ref(db, `accsettings/${id}`));
  await remove(ref(db, `botList/${me}/${id}`)); await remove(ref(db, `bots/${id}`));
}
/** Adds one of your bots to the chat. The rules only let the bot's owner do this. */
export async function addBotToChat(chatPath, chatId, id) {
  await update(ref(db, `${chatPath}/participants`), { [id]: true });
  await set(ref(db, `chatList/${id}/${chatId}`), true);
}
