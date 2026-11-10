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
/** Searching costs database reads, so: every message this device has shown is remembered (text only, not for encrypted chats, whose
 *  plain text is never written to disk) and searched from there for free. Older, never-seen history is fetched only when the result
 *  list is scrolled to its end (one page of PAGE messages at a time, never more than one request at once, no pictures). */
const PAGE = 250, SHARD = 2000;
export function initChatSearch({ $, msgData, nameOf, jumpTo, fetchOlder, oldestLoaded, atStart, store, chatId }) {
  const dlg = $("searchDialog"), input = $("searchInput"), list = $("searchResults"), note = $("searchNote"), stopBtn = $("searchOlder");
  let kind = "all", idx = new Map(), oldest = null, done = false, busy = false, stop = false, armed = false, loaded = null, dirty = false, saveT = 0, armT = 0;
  const records = () => { const m = new Map(idx); for (const [k, v] of msgData) if (v && v.type !== "event") m.set(k, slim(k, v)); return [...m.values()]; };
  const complete = () => done || atStart();
  // ---- remembering (several shards: one database entry may not be huge)
  async function load() {
    if (!store) return;
    try {
      const meta = await store.get("sidx:" + chatId);
      if (!meta || !meta.n) return;
      const parts = await Promise.all(Array.from({ length: meta.n }, (_, i) => store.get("sidx:" + chatId + ":" + i)));
      for (const part of parts) if (Array.isArray(part)) part.forEach(r => idx.set(r.key, r));
      oldest = meta.oldest || null; done = !!meta.done;
    } catch (_) { /* start empty */ }
  }
  const ready = load().then(() => { loaded = true; paintIf(); });
  const paintIf = () => { if (dlg.open) paint(); };
  function save() {
    if (!store || !dirty) return; dirty = false;
    const all = [...idx.values()].sort((a, b) => (a.key < b.key ? -1 : 1)), n = Math.ceil(all.length / SHARD);
    for (let i = 0; i < n; i++) store.set("sidx:" + chatId + ":" + i, all.slice(i * SHARD, (i + 1) * SHARD)).catch(() => {});
    store.set("sidx:" + chatId, { n, oldest, done }).catch(() => {});
  }
  const later = () => { dirty = true; clearTimeout(saveT); saveT = setTimeout(save, 3000); };
  /** every message the chat page shows goes through here */
  const add = (key, m) => { if (!m || m.type === "event") return; idx.set(key, slim(key, m)); later(); };
  const drop = key => { if (idx.delete(key)) later(); };
  addEventListener("pagehide", save);

  const paint = () => {
    const q = input.value.trim(), res = searchRecords(records(), q, kind);
    list.replaceChildren();
    const msg = t => { const e = document.createElement("div"); e.className = "muted cs-empty"; e.textContent = t; list.append(e); };
    if (!q && kind === "all") msg("Type to search messages, or pick Photos, Videos, Audio or Files to browse them.");
    else if (!res.length) msg(complete() ? "Nothing found." : "Nothing found yet.");
    for (const r of res.slice(0, 300)) {
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
    if (res.length > 300) msg("Showing the newest 300 results. Narrow the search to see more.");
    if ((q || kind !== "all") && !complete()) { const e = document.createElement("div"); e.className = "cs-more muted"; e.id = "csMore"; e.textContent = busy ? "Searching older messages\u2026" : "Scroll down to search older messages"; list.append(e); watchMore(e); }
    note.textContent = complete() ? `Whole chat searched (${records().length} messages)` : `${records().length} messages searched so far`;
    stopBtn.hidden = !busy;
  };
  // ---- the list is scrolled to its end (or the person stopped typing and nothing is shown): fetch one older page, then wait to be asked again
  let io = null;
  function watchMore(el) {
    io?.disconnect();
    io = new IntersectionObserver(es => { if (es.some(x => x.isIntersecting) && armed && !busy && !complete()) more(); }, { root: list, threshold: 0.01 });
    io.observe(el);
  }
  const arm = () => { armed = true; const e = $("csMore"); if (e) watchMore(e); };
  list.addEventListener("scroll", arm, { passive: true }); list.addEventListener("wheel", arm, { passive: true }); list.addEventListener("touchmove", arm, { passive: true });
  async function more() {
    armed = false; busy = true; stop = false; paint();
    try {
      const before = oldest && (!oldestLoaded() || oldest < oldestLoaded()) ? oldest : oldestLoaded();
      const page = await fetchOlder(before, PAGE);
      if (!page.length) done = true;
      else { for (const [k, m] of page) if (m && m.type !== "event") idx.set(k, slim(k, m)); oldest = page[0][0]; if (page.length < PAGE) done = true; later(); }   // a page that comes back short is the start of the chat
    } catch (_) { note.textContent = "Couldn't reach the server. Scroll again to retry."; }
    busy = false; dirty = true; save(); paint();          // a scan step is saved at once (leaving the page can cut a delayed save short)
  }
  input.addEventListener("input", () => { paint(); clearTimeout(armT); armT = setTimeout(arm, 700); });   // stopped typing and still nothing to show: allow one page
  $("searchChips").addEventListener("click", e => { const c = e.target.closest(".chip"); if (!c) return; kind = c.dataset.k; for (const x of $("searchChips").children) x.classList.toggle("on", x === c); paint(); clearTimeout(armT); armT = setTimeout(arm, 700); });
  stopBtn.onclick = () => { stop = true; armed = false; };
  $("searchClose").onclick = () => dlg.close();
  $("searchBtn").onclick = async () => { dlg.showModal(); await ready; paint(); setTimeout(() => input.focus(), 50); };
  return { add, drop };
}
