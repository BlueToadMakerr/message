// Search inside one chat: message text plus files (photos, videos, audio, other files), over the messages that are loaded on this device.
// "Search older messages" pulls further pages in. Encrypted messages are searched after decryption, on this device only.
import { fmtBytes } from "./litter.js";
const ICON = { person: "\ud83d\udc64", pin: "\ud83d\udccc", image: "\ud83d\udcf7", video: "\ud83c\udfa5", audio: "\ud83c\udfb5", file: "\ud83d\udcc4", text: "\ud83d\udcac" };
export const kindOfMsg = m => m.type === "image" || m.type === "video" || m.type === "audio" ? m.type : m.type === "file" ? "file" : "text";
const slim = (key, m) => ({ key, k: kindOfMsg(m), ts: m.timestamp || 0, from: m.fromUid || "", text: String(m.text || "").slice(0, 400), name: String(m.name || ""), size: m.size || 0, fk: String(m.kind || (m.mime ? String(m.mime).split("/")[0] : "")).slice(0, 12) });
/** What a record is as MEDIA: photos / videos / audio messages, and also files that are really one (sent as a file because they were too big): those are both. */
const EXT = { image: /\.(png|jpe?g|gif|webp|avif|bmp|heic|heif|svg)$/i, video: /\.(mp4|m4v|mov|webm|mkv|avi|3gp|ogv)$/i, audio: /\.(mp3|m4a|wav|ogg|oga|opus|aac|flac|amr|weba)$/i };
export const mediaKind = r => {
  if (r.k === "image" || r.k === "video" || r.k === "audio") return r.k;
  if (r.k !== "file") return null;
  if (r.fk === "image" || r.fk === "video" || r.fk === "audio") return r.fk;
  for (const k of ["image", "video", "audio"]) if (EXT[k].test(r.name || "")) return k;
  return null;
};
/** Search over slim records. */
const KINDWORDS = { image: "photo picture image", video: "video clip movie", audio: "audio voice sound", file: "file document attachment" };       // typing "photo" finds photos even without a file name
export function searchRecords(recs, q, kind) {
  const needle = String(q || "").trim().toLowerCase(), out = [];
  for (const r of recs) {
    if (kind !== "all" && kind !== r.k) continue;
    if (needle ? !(r.text + " " + r.name + " " + (KINDWORDS[r.k] || "")).toLowerCase().includes(needle) : r.k === "text") continue;   // no words typed: only list files
    out.push(r);
  }
  return out.sort((a, b) => b.ts - a.ts);
}
/** Searching costs database reads, so: every message this device has shown is remembered (text only, not for encrypted chats, whose
 *  plain text is never written to disk) and searched from there for free. Older, never-seen history is fetched only when the result
 *  list is scrolled to its end (one page of PAGE messages at a time, never more than one request at once, no pictures). */
const PAGE = 250, SHARD = 2000;
export function initChatSearch({ $, msgData, nameOf, jumpTo, fetchOlder, oldestLoaded, atStart, firstKey = async () => undefined, thumbOf = async () => null, store, chatId, members = () => [], pins = () => [], resolvePin = async () => null, onPerson = () => {} }) {
  const dlg = $("searchDialog"), input = $("searchInput"), list = $("searchResults"), note = $("searchNote"), stopBtn = $("searchOlder");
  const pinRecs = new Map();     // pinned message key -> slim record (null = the message is gone)
  let kind = "all", idx = new Map(), oldest = null, done = false, busy = false, stop = false, armed = false, loaded = null, dirty = false, saveT = 0, armT = 0;
  const records = () => { const m = new Map(idx); for (const [k, v] of msgData) if (v && v.type !== "event") m.set(k, slim(k, v)); return [...m.values()]; };
  // "the whole chat was searched" is only said when the chat's very first message is among what was searched (asked from the database), never because a page happened to come back short
  let first;                                                   // undefined = not known yet, null = the chat has no messages
  const askFirst = () => firstKey().then(k => { const was = first; first = k; if (k && k !== was) later(); paintIf(); }, () => {});
  const complete = () => first === null || (first !== undefined && (idx.has(first) || msgData.has(first)));
  // ---- remembering (several shards: one database entry may not be huge)
  async function load() {
    if (!store) return;
    try {
      const meta = await store.get("sidx:" + chatId);
      if (!meta || !meta.n) return;
      const parts = await Promise.all(Array.from({ length: meta.n }, (_, i) => store.get("sidx:" + chatId + ":" + i)));
      for (const part of parts) if (Array.isArray(part)) part.forEach(r => idx.set(r.key, r));
      oldest = meta.oldest || null; done = !!meta.done; if (meta.first) first = meta.first;
    } catch (_) { /* start empty */ }
  }
  const ready = load().then(() => { loaded = true; paintIf(); });
  const paintIf = () => { if (!dlg.open) return; if (dlg.dataset.pane === "media") paintMedia(); else if (dlg.dataset.pane === "search") paint(); };
  function save() {
    if (!store || !dirty) return; dirty = false;
    const all = [...idx.values()].sort((a, b) => (a.key < b.key ? -1 : 1)), n = Math.ceil(all.length / SHARD);
    for (let i = 0; i < n; i++) store.set("sidx:" + chatId + ":" + i, all.slice(i * SHARD, (i + 1) * SHARD)).catch(() => {});
    store.set("sidx:" + chatId, { n, oldest, done, first }).catch(() => {});
  }
  const later = () => { dirty = true; clearTimeout(saveT); saveT = setTimeout(save, 3000); };
  /** every message the chat page shows goes through here */
  let repaintT = 0;
  const add = (key, m) => { if (!m || m.type === "event") return; idx.set(key, slim(key, m)); later(); if (dlg.open && dlg.dataset.pane === "media") { clearTimeout(repaintT); repaintT = setTimeout(() => dlg.open && dlg.dataset.pane === "media" && paintMedia(), 250); } };
  const drop = key => { if (idx.delete(key)) later(); };
  addEventListener("pagehide", save);

  const when = ts => ts ? new Date(ts).toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "";
  const row = (icon, title, sub, onClick) => {
    const b = document.createElement("button"); b.type = "button"; b.className = "cs-item";
    const ic = document.createElement("span"); ic.className = "cs-ic"; ic.textContent = icon;
    const body = document.createElement("span"); body.className = "cs-body";
    const t = document.createElement("span"); t.className = "cs-t"; t.textContent = title;
    const s = document.createElement("span"); s.className = "cs-s"; s.textContent = sub;
    body.append(t, s); b.append(ic, body); b.onclick = onClick; return b;
  };
  // photos and videos show a small picture (a video: its first frame), fetched only when the row scrolls into view, two at a time
  const thumbs = new Map(); let tq = 0; const waitQ = [];
  const pump = () => { while (tq < 2 && waitQ.length) { const f = waitQ.shift(); tq++; f().finally(() => { tq--; pump(); }); } };
  const mkTio = root => typeof IntersectionObserver === "function" ? new IntersectionObserver(es => es.forEach(e => {
    if (!e.isIntersecting) return; tio.unobserve(e.target); const el = e.target;
    waitQ.push(async () => {
      let t = thumbs.get(el._key); if (t === undefined) { try { t = await thumbOf(el._key, el._k); } catch (_) { t = null; } thumbs.set(el._key, t); }
      if (!t || !el.isConnected) return;
      let node;
      if (t.kind === "video") { node = document.createElement("video"); node.muted = true; node.preload = "metadata"; node.playsInline = true; node.src = t.src; node.addEventListener("loadedmetadata", () => { try { node.currentTime = 0.1; } catch (_) {} }, { once: true }); }
      else { node = new Image(); node.alt = ""; node.referrerPolicy = "no-referrer"; node.src = t.src; }
      node.className = "cs-thumb"; el.replaceWith(node);
    }); pump();
  }), { root, rootMargin: "100px" }) : null;
  const tio = mkTio(list), tioMedia = mkTio($("mediaList"));
  const withThumb = (b, r, obs = tio) => { const mk = mediaKind(r); if (obs && (mk === "image" || mk === "video")) { const ic = b.querySelector(".cs-ic"); ic._key = r.key; ic._k = mk; obs.observe(ic); } return b; };
  const recRow = r => withThumb(row(ICON[r.k], r.k === "text" ? r.text.slice(0, 140) : (r.name || r.text || { image: "Photo", video: "Video", audio: "Voice message" }[r.k] || "File"),
    [nameOf(r.from), when(r.ts), r.size ? fmtBytes(r.size) : ""].filter(Boolean).join(" \u00b7 "), () => { dlg.close(); jumpTo(r.key); }), r);
  async function resolveAll() {                       // pinned messages are fetched once each (at most 50), then searched like anything else
    await 0;                                          // never repaint from inside a paint
    let any = false;
    for (const p of pins().slice(0, 50)) if (!pinRecs.has(p.key)) { any = true; const m = msgData.get(p.key); pinRecs.set(p.key, m ? slim(p.key, m) : await resolvePin(p.key).catch(() => null)); }
    if (any) paintIf();
  }
  const paint = () => {
    const q = input.value.trim(), needle = q.toLowerCase(), all = kind === "all";
    list.replaceChildren();
    const msg = t => { const e = document.createElement("div"); e.className = "muted cs-empty"; e.textContent = t; list.append(e); };
    const head = t => { const e = document.createElement("div"); e.className = "cs-h"; e.textContent = t; list.append(e); };
    if (!q) { msg("Type to search people, pins, files and messages."); stopBtn.hidden = true; note.textContent = ""; return; }
    let shown = 0;
    // people
    if (all || kind === "people") {
      const ppl = members().filter(m => !q || m.name.toLowerCase().includes(needle));
      if (ppl.length) { if (all) head("People"); shown += ppl.length; for (const m of ppl.slice(0, all ? 5 : 100)) list.append(row(ICON.person, m.name, m.sub || "Tap to mention them", () => { dlg.close(); onPerson(m.uid, m.name); })); }
    }
    // pins
    if (all || kind === "pins") {
      resolveAll();
      const ps = pins().slice().sort((a, b) => b.ts - a.ts).map(p => ({ p, r: pinRecs.get(p.key) })).filter(x => x.r && (!q || (x.r.text + " " + x.r.name).toLowerCase().includes(needle)));
      if (ps.length) { if (all) head("Pins"); shown += ps.length; for (const { p, r } of ps.slice(0, all ? 5 : 100)) list.append(row(ICON.pin, r.k === "text" ? r.text.slice(0, 140) : (r.name || ICON[r.k]), "Pinned by " + nameOf(p.by) + " \u00b7 " + when(p.ts), () => { dlg.close(); jumpTo(p.key); })); }
      else if (kind === "pins") msg(pins().length ? (pinRecs.size < pins().length ? "Loading pins\u2026" : "No pin matches.") : "Nothing is pinned yet. Open a message's menu and choose Pin.");
    }
    // media and messages
    if (kind !== "people" && kind !== "pins") {
      const res = searchRecords(records(), q, all ? "all" : kind).filter(r => r.k === "text" || r.k === "file");    // photos, videos and audio live in the Media tab
      const media = res.filter(r => r.k !== "text"), texts = res.filter(r => r.k === "text");
      if (all) {
        if (media.length) { head("Files"); shown += media.length; media.slice(0, 6).forEach(r => list.append(recRow(r))); if (media.length > 6) msg(media.length - 6 + " more: open the Files tab."); }
        if (texts.length) { head("Messages"); shown += texts.length; texts.slice(0, 300).forEach(r => list.append(recRow(r))); }
      } else { shown += res.length; res.slice(0, 300).forEach(r => list.append(recRow(r))); }
      if (!shown) msg(complete() ? "Nothing found." : "Nothing found yet.");
      if (res.length > 300) msg("Showing the newest 300 results. Narrow the search to see more.");
      if (!complete()) { const e = document.createElement("div"); e.className = "cs-more muted"; e.id = "csMore"; e.textContent = busy ? "Searching older messages\u2026" : "Scroll down to search older messages"; list.append(e); watchMore(e); }
      note.textContent = complete() ? `Whole chat searched (${records().length} messages)` : `${records().length} messages searched so far`;
    } else { if (!shown && kind === "people") msg("No one matches."); note.textContent = ""; }
    stopBtn.hidden = !busy;
  };
  // ---- Media tab: every photo, video and audio this device knows of in the chat, newest first (older ones are fetched when the end is reached)
  const mlist = $("mediaList"), mnote = $("mediaNote"); let mkind = "all";
  function paintMedia() {
    mlist.replaceChildren();
    const res = records().filter(r => { const k = mediaKind(r); return k && (mkind === "all" || k === mkind); }).sort((a, b) => b.ts - a.ts);
    for (const r of res.slice(0, 600)) {
      const mk = mediaKind(r);
      const t = document.createElement("button"); t.type = "button"; t.className = "media-tile" + (mk === "audio" ? " audio" : ""); t.title = [r.name, nameOf(r.from), when(r.ts)].filter(Boolean).join(" \u00b7 ");
      const ic = document.createElement("span"); ic.className = "cs-ic"; ic.textContent = ICON[mk]; t.append(ic);
      if (mk === "video") { const pl = document.createElement("span"); pl.className = "play"; pl.textContent = "\u25b6"; t.append(pl); }
      if (mk === "audio") { const cap = document.createElement("span"); cap.className = "cap"; cap.textContent = r.name || "Voice message"; t.append(cap); }
      t.onclick = () => { dlg.close(); jumpTo(r.key); };
      mlist.append(withThumb(t, r, tioMedia));
    }
    if (!res.length) { const e = document.createElement("div"); e.className = "muted cs-empty"; e.textContent = complete() ? "No photos, videos or audio in this chat." : "None found yet."; mlist.append(e); }
    if (!complete()) { const e = document.createElement("div"); e.className = "cs-more muted"; e.id = "mMore"; e.textContent = busy ? "Looking through older messages\u2026" : "Scroll down to look further back"; mlist.append(e); watchMedia(e); }
    mnote.textContent = complete() ? `Whole chat checked (${res.length} item${res.length === 1 ? "" : "s"})` : `${res.length} found in ${records().length} messages so far`;
  }
  let mio = null;
  function watchMedia(el) { mio?.disconnect(); mio = new IntersectionObserver(es => { if (es.some(x => x.isIntersecting) && marmed && !busy && !complete()) more(); }, { root: mlist, threshold: 0.01 }); mio.observe(el); }
  let marmed = false; const marm = () => { marmed = true; armed = true; const e = $("mMore"); if (e) watchMedia(e); };
  mlist.addEventListener("scroll", marm, { passive: true }); mlist.addEventListener("wheel", marm, { passive: true }); mlist.addEventListener("touchmove", marm, { passive: true });
  $("mediaChips").addEventListener("click", e => { const c = e.target.closest(".chip"); if (!c) return; mkind = c.dataset.m; for (const x of $("mediaChips").children) x.classList.toggle("on", x === c); paintMedia(); });
  const openMedia = async () => { if (!dlg.open) dlg.showModal(); await ready; if (first === undefined) await askFirst(); paintMedia(); };
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
    armed = false; marmed = false; busy = true; stop = false; paintIf();
    try {
      const before = oldest && (!oldestLoaded() || oldest < oldestLoaded()) ? oldest : oldestLoaded();
      const page = await fetchOlder(before, PAGE);
      if (!page.length) { done = true; await askFirst(); }
      else { for (const [k, m] of page) if (m && m.type !== "event") idx.set(k, slim(k, m)); oldest = page[0][0]; later(); }
    } catch (_) { note.textContent = "Couldn't reach the server. Scroll again to retry."; }
    busy = false; dirty = true; save(); paintIf();          // a scan step is saved at once (leaving the page can cut a delayed save short)
  }
  let tracked = false;
  input.addEventListener("input", () => { if (!tracked && input.value.trim().length > 1) { tracked = true; import("./analytics.js").then(m => m.track("search_used", { tab: (document.querySelector("#searchChips .on") || {}).dataset?.k || "all" })).catch(() => {}); } paint(); clearTimeout(armT); if (input.value.trim()) armT = setTimeout(arm, 700); });   // stopped typing and still nothing to show: allow one page
  $("searchChips").addEventListener("click", e => { const c = e.target.closest(".chip"); if (!c) return; kind = c.dataset.k; for (const x of $("searchChips").children) x.classList.toggle("on", x === c); paint(); clearTimeout(armT); if (input.value.trim()) armT = setTimeout(arm, 700); });
  stopBtn.onclick = () => { stop = true; armed = false; };
  $("searchClose").onclick = () => dlg.close();
  const open = async () => { if (!dlg.open) dlg.showModal(); await ready; if (first === undefined) await askFirst(); paint(); setTimeout(() => input.focus(), 50); };
  return { add, drop, open, openMedia };
}
