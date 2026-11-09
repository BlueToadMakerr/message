// Search inside one chat: message text plus files (photos, videos, audio, other files), over the messages that are loaded on this device.
// "Search older messages" pulls further pages in. Encrypted messages are searched after decryption, on this device only.
import { fmtBytes } from "./litter.js";
const ICON = { image: "\ud83d\udcf7", video: "\ud83c\udfa5", audio: "\ud83c\udfb5", file: "\ud83d\udcc4", text: "\ud83d\udcac" };
export const kindOfMsg = m => m.type === "image" || m.type === "video" || m.type === "audio" ? m.type : m.type === "file" ? "file" : "text";
const slim = (key, m) => ({ key, k: kindOfMsg(m), ts: m.timestamp || 0, from: m.fromUid || "", text: String(m.text || "").slice(0, 400), name: String(m.name || ""), size: m.size || 0 });
/** Search over slim records. */
export function searchRecords(recs, q, kind) {
  const needle = String(q || "").trim().toLowerCase(), out = [];
  for (const r of recs) {
    if (kind !== "all" && kind !== r.k) continue;
    if (needle ? !(r.text + " " + r.name).toLowerCase().includes(needle) : r.k === "text") continue;   // no words typed: only list files
    out.push(r);
  }
  return out.sort((a, b) => b.ts - a.ts);
}
/** Searching costs database reads, so: what's already on screen is free; older history is fetched only when asked for, in steps of
 *  STEP messages, text only (no pictures), once per chat: the result is remembered on this device (not for encrypted chats, whose
 *  plain text is never written to disk) so later searches read nothing. */
const STEP = 500, PAGE = 250;
export function initChatSearch({ $, msgData, nameOf, jumpTo, fetchOlder, oldestLoaded, atStart, store, chatId }) {
  const dlg = $("searchDialog"), input = $("searchInput"), list = $("searchResults"), note = $("searchNote"), older = $("searchOlder");
  let kind = "all", idx = new Map(), oldest = null, done = false, busy = false, stop = false, loadedStore = false;
  const records = () => { const m = new Map(idx); for (const [k, v] of msgData) if (v && v.type !== "event") m.set(k, slim(k, v)); return [...m.values()]; };
  const complete = () => done || atStart();
  const save = () => { if (store) store.set("sidx:" + chatId, { recs: [...idx.values()], oldest, done }).catch(() => {}); };
  const paint = () => {
    const q = input.value.trim(), res = searchRecords(records(), q, kind);
    list.replaceChildren();
    const msg = t => { const e = document.createElement("div"); e.className = "muted cs-empty"; e.textContent = t; list.append(e); };
    if (!q && kind === "all") msg("Type to search messages, or pick Photos, Videos, Audio or Files to browse them.");
    else if (!res.length) msg("Nothing found" + (complete() ? "." : " in the part of the chat searched so far. Tap \u201cSearch further back\u201d to look in older messages."));
    for (const r of res.slice(0, 200)) {
      const b = document.createElement("button"); b.type = "button"; b.className = "cs-item";
      const ic = document.createElement("span"); ic.className = "cs-ic"; ic.textContent = ICON[r.k];
      const body = document.createElement("span"); body.className = "cs-body";
      const t = document.createElement("span"); t.className = "cs-t";
      t.textContent = r.k === "text" ? r.text.slice(0, 140) : (r.name || r.text || { image: "Photo", video: "Video", audio: "Voice message" }[r.k] || "File");
      const s = document.createElement("span"); s.className = "cs-s";
      s.textContent = [nameOf(r.from), r.ts ? new Date(r.ts).toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "", r.size ? fmtBytes(r.size) : ""].filter(Boolean).join(" \u00b7 ");
      body.append(t, s); b.append(ic, body);
      b.onclick = () => { dlg.close(); jumpTo(r.key); };
      list.append(b);
    }
    if (res.length > 200) msg("Showing the newest 200 results. Narrow the search to see more.");
    const n = records().length;
    note.textContent = complete() ? `Whole chat searched (${n} messages)` : `Searched ${n} messages${busy ? "\u2026" : ""}`;
    older.hidden = complete() && !busy;
    older.textContent = busy ? "Stop" : "Search further back (" + STEP + " more)";
  };
  async function scan() {
    busy = true; stop = false; paint();
    try {
      let got = 0;
      while (!stop && !complete() && got < STEP) {
        const before = oldest && (!oldestLoaded() || oldest < oldestLoaded()) ? oldest : oldestLoaded();
        const page = await fetchOlder(before, PAGE);
        if (!page.length) { done = true; break; }
        for (const [k, m] of page) if (m && m.type !== "event") { idx.set(k, slim(k, m)); got++; }
        oldest = page[0][0]; paint();
      }
    } catch (_) { note.textContent = "Couldn't reach the server. Try again."; }
    busy = false; save(); paint();
  }
  input.addEventListener("input", paint);
  $("searchChips").addEventListener("click", e => { const c = e.target.closest(".chip"); if (!c) return; kind = c.dataset.k; for (const x of $("searchChips").children) x.classList.toggle("on", x === c); paint(); });
  older.onclick = () => { if (busy) stop = true; else scan(); };
  $("searchClose").onclick = () => { stop = true; dlg.close(); };
  dlg.addEventListener("close", () => { stop = true; });
  $("searchBtn").onclick = async () => {
    dlg.showModal(); paint(); setTimeout(() => input.focus(), 50);
    if (!loadedStore && store) { loadedStore = true; try { const v = await store.get("sidx:" + chatId); if (v && v.recs) { v.recs.forEach(r => idx.set(r.key, r)); oldest = v.oldest || null; done = !!v.done; paint(); } } catch (_) { /* none */ } }
  };
}
