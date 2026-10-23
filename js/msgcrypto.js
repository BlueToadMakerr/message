// Turns plain chat messages into their encrypted database form and back (see crypto.js).
import { encText, decText, isCipher, isChatLost } from "./crypto.js";

/** plain payload (what the UI works with) → what is stored. Only call for chats with encryption on. */
export async function sealPayload(chatId, p) {
  const out = { fromUid: p.fromUid, timestamp: p.timestamp, enc: true };
  if (p.type === "file") {
    out.type = "file";
    out.text = await encText(chatId, JSON.stringify({ name: p.name, url: p.url, size: p.size, mime: p.mime, kind: p.kind, ...(p.wave ? { wave: p.wave, duration: p.duration } : {}) }));
    if (typeof p.expiresAt === "number") out.expiresAt = p.expiresAt;       // not secret; the cleanup logic needs it
  } else if (p.type === "image" || p.type === "video" || p.type === "audio") {
    out.type = p.type;
    out.content = await encText(chatId, p.content);
    if (p.type === "audio" && p.wave) out.wave = await encText(chatId, `${p.duration || 0}|${p.wave}`);
  } else {
    out.text = await encText(chatId, p.text ?? "");
  }
  if (p.replyTo) out.replyTo = { key: p.replyTo.key, uid: p.replyTo.uid, text: await encText(chatId, p.replyTo.text || "") };
  return out;
}

export async function sealPreview(chatId, text) { return encText(chatId, String(text).slice(0, 300)); }

/** stored message → plain message. Never throws: a message that can't be opened comes back flagged `_locked`. */
export async function openMessage(chatId, m) {
  if (!m || !m.enc) return m;
  try {
    if (m.replyTo && isCipher(m.replyTo.text)) m = { ...m, replyTo: { ...m.replyTo, text: await decText(chatId, m.replyTo.text) } };
    if (m.type === "file") {
      const meta = JSON.parse(await decText(chatId, m.text));
      return { ...m, ...meta, text: meta.name, _enc: true };
    }
    if (m.type === "image" || m.type === "video" || m.type === "audio") {
      const o = { ...m, content: await decText(chatId, m.content ?? m.text), _enc: true };
      if (m.type === "audio" && isCipher(m.wave)) { try { const [d, w] = (await decText(chatId, m.wave)).split("|"); o.wave = w; o.duration = +d || 0; } catch (_) { delete o.wave; } }
      return o;
    }
    if (m.type === "event") return m;
    return { ...m, text: await decText(chatId, m.text), _enc: true };
  } catch (e) {
    // "lost": nobody in the chat has the key any more (or the chat was re-keyed), so this message can never be opened. "waiting": a key exists, this device just doesn't have it yet.
    const lost = isChatLost(chatId) || !(e && e.noKey);
    return { fromUid: m.fromUid, timestamp: m.timestamp, editedAt: m.editedAt, type: "text", text: lost ? "🔒 This message is lost (its encryption key no longer exists)" : "🔒 Waiting for the encryption key…", _locked: true, _lost: lost, _enc: true };
  }
}

/** lastMessage text for the chat list. */
export async function openPreview(chatId, last) {
  if (!last || !last.enc) return last ? last.text : "";
  try { return await decText(chatId, last.text); } catch (_) { return "🔒 Encrypted message"; }
}
export { isCipher };
