// Search inside one chat: message text plus files (photos, videos, audio, other files), over the messages that are loaded on this device.
// "Search older messages" pulls further pages in. Encrypted messages are searched after decryption, on this device only.
import { fmtBytes } from "./litter.js";
const ICON = { image: "\ud83d\udcf7", video: "\ud83c\udfa5", audio: "\ud83c\udfb5", file: "\ud83d\udcc4", text: "\ud83d\udcac" };
export const kindOfMsg = m => m.type === "image" || m.type === "video" || m.type === "audio" ? m.type : m.type === "file" ? (m.kind === "image" || m.kind === "video" || m.kind === "audio" ? "file" : "file") : "text";
export function searchMessages(msgData, q, kind) {
  const needle = String(q || "").trim().toLowerCase(), out = [];
  for (const [key, m] of msgData) {
    if (!m || m.type === "event") continue;
    const k = kindOfMsg(m);
    if (kind !== "all" && kind !== k) continue;
    const hay = (String(m.text || "") + " " + String(m.name || "") + " " + String(m.mime || "")).toLowerCase();
    if (needle && !hay.includes(needle)) continue;
    if (!needle && k === "text") continue;               // no words typed: only list files
    out.push({ key, m, k });
  }
  return out.sort((a, b) => (b.m.timestamp || 0) - (a.m.timestamp || 0));
}
export function initChatSearch({ $, msgData, nameOf, jumpTo, loadOlderAll, atStart }) {
  const dlg = $("searchDialog"), input = $("searchInput"), list = $("searchResults"), note = $("searchNote"), older = $("searchOlder");
  let kind = "all";
  const paint = () => {
    const q = input.value.trim(), res = searchMessages(msgData, q, kind);
    list.replaceChildren();
    if (!q && kind === "all") { const e = document.createElement("div"); e.className = "muted cs-empty"; e.textContent = "Type to search messages, or pick Photos, Videos, Audio or Files to browse them."; list.append(e); }
    else if (!res.length) { const e = document.createElement("div"); e.className = "muted cs-empty"; e.textContent = "Nothing found" + (atStart() ? "." : " in the messages loaded so far. Try \u201cSearch older messages\u201d."); list.append(e); }
    for (const { key, m, k } of res.slice(0, 200)) {
      const b = document.createElement("button"); b.type = "button"; b.className = "cs-item";
      const ic = document.createElement("span"); ic.className = "cs-ic"; ic.textContent = ICON[k];
      const body = document.createElement("span"); body.className = "cs-body";
      const t = document.createElement("span"); t.className = "cs-t";
      t.textContent = k === "text" ? String(m.text || "").slice(0, 140) : (m.name || m.text || { image: "Photo", video: "Video", audio: "Voice message" }[k] || "File");
      const s = document.createElement("span"); s.className = "cs-s";
      s.textContent = [nameOf(m.fromUid), m.timestamp ? new Date(m.timestamp).toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "", m.size ? fmtBytes(m.size) : ""].filter(Boolean).join(" \u00b7 ");
      body.append(t, s); b.append(ic, body);
      b.onclick = () => { dlg.close(); jumpTo(key); };
      list.append(b);
    }
    if (res.length > 200) { const e = document.createElement("div"); e.className = "muted cs-empty"; e.textContent = "Showing the newest 200 results. Narrow the search to see more."; list.append(e); }
    note.textContent = atStart() ? "Whole chat searched" : "Searched the loaded messages";
    older.hidden = atStart();
  };
  input.addEventListener("input", paint);
  $("searchChips").addEventListener("click", e => { const c = e.target.closest(".chip"); if (!c) return; kind = c.dataset.k; for (const x of $("searchChips").children) x.classList.toggle("on", x === c); paint(); });
  older.onclick = async () => { older.disabled = true; older.textContent = "Loading\u2026"; try { await loadOlderAll(); } finally { older.disabled = false; older.textContent = "Search older messages"; paint(); } };
  $("searchClose").onclick = () => dlg.close();
  $("searchBtn").onclick = () => { dlg.showModal(); paint(); setTimeout(() => input.focus(), 50); };
}
