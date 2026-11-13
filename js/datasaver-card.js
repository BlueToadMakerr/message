// Account page: Data Saver, stored media and the saved copy of the site.
import { modeChoices, getMode, setMode, describe, onSaverChange } from "./datasaver.js";
import { LIMITS, getLimitMb, setLimitMb, cacheStats, cacheClear, storageInfo } from "./mediacache.js";
import { copyStatus, setSafeMode, saveWorkingCopy } from "./sitecopy.js";
import { SITE_VERSION } from "./version.js";
import { toast, confirmDialog } from "./ui.js";
import { offlineOn, setOfflineOn, ocStats, ocClear } from "./offline.js";
const $ = id => document.getElementById(id);
const mb = b => b >= 1073741824 ? (b / 1073741824).toFixed(1) + " GB" : b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(0, Math.round(b / 1024)) + " KB";
const opt = (v, t) => Object.assign(document.createElement("option"), { value: v, textContent: t });

// ---- Data Saver
const sel = $("saverMode");
if (sel) {
  const fill = () => {
    const ch = modeChoices(), cur = getMode();
    sel.replaceChildren(...ch.map(([v, t]) => opt(v, t)));
    sel.value = ch.some(([v]) => v === cur) ? cur : "off";
    $("saverNow").textContent = describe();
  };
  sel.onchange = () => { setMode(sel.value); fill(); };
  fill(); onSaverChange(fill);
  setInterval(fill, 6000);
}

// ---- Stored media
const lim = $("mediaLimit");
async function paintMedia() {
  const s = await cacheStats(), i = await storageInfo();
  $("mediaNow").textContent = `${s.count} item${s.count === 1 ? "" : "s"}, ${mb(s.bytes)} stored of ${mb(s.limit)}.` + (i.quota ? ` This device has given QuickMessage room for about ${mb(i.quota)} (${mb(i.usage)} used).` : "") + (i.persisted === true ? " The storage is marked as kept." : i.persisted === false ? " The browser may clear it when the device runs low on space." : "");
}
if (lim) {
  lim.replaceChildren(...LIMITS.map(n => opt(String(n), n >= 1000 ? n / 1000 + " GB" : n + " MB")));
  lim.value = String(getLimitMb());
  lim.onchange = async () => { setLimitMb(+lim.value); setTimeout(paintMedia, 600); };
  $("mediaClear").onclick = async () => {
    if (!await confirmDialog({ title: "Clear stored media?", message: "Pictures, videos and voice notes will be downloaded again the next time you open them.", okText: "Clear" })) return;
    await cacheClear(); await paintMedia(); toast("Stored media cleared.", "success");
  };
  paintMedia();
}

// ---- Saved copy
async function paintCopy() {
  const st = await copyStatus(), now = $("copyNow"), safe = $("copySafe"), save = $("copySave");
  if (!st) { now.textContent = "This browser can't keep a saved copy (it has no service worker)."; safe.hidden = save.hidden = true; return; }
  now.textContent = (st.has ? `Saved copy: version ${st.version || "?"}, ${new Date(st.at).toLocaleString()} (${st.count} files).` : "No copy saved yet — one is saved automatically after QuickMessage has run fine for about 40 seconds.") + (st.safe ? " You are using the saved copy right now." : "") + ` The live site is version ${SITE_VERSION}.`;
  safe.disabled = !st.has && !st.safe; safe.textContent = st.safe ? "Back to the live site" : "Use the saved copy";
  safe.onclick = async () => { safe.disabled = true; await setSafeMode(!st.safe); toast(st.safe ? "Going back to the live site…" : "Using the saved copy…", "info", 2500); setTimeout(() => (window.top || window).location.reload(), 600); };
  save.disabled = !!st.safe;
  save.onclick = async () => {
    save.disabled = true; const r = await saveWorkingCopy(SITE_VERSION);
    toast(r && r.ok ? `Saved ${r.count} files as the copy.` : "Couldn't save a copy (open the app's main page first).", r && r.ok ? "success" : "error"); paintCopy();
  };
}
if ($("copyCard")) { if (window.QMApp) $("copyCard").hidden = true; else paintCopy(); }  // the apps keep their own copy and have no service worker

// ---- Offline data
async function paintOffline() { const st = await ocStats(); $("offlineNow").textContent = offlineOn() ? `${st.count} saved item${st.count === 1 ? "" : "s"}, about ${mb(st.bytes)}.` : "Switched off: nothing is kept."; }
if ($("offlineCard")) {
  $("offlineOn").checked = offlineOn();
  $("offlineOn").onchange = async e => { setOfflineOn(e.target.checked); setTimeout(paintOffline, 300); };
  $("offlineClear").onclick = async () => { await ocClear(); toast("Offline data cleared.", "success"); setTimeout(paintOffline, 300); };
  paintOffline();
}

// ---- Android only: what push did on this phone lately (explains late or missing notifications) ----
(function pushDiagCard() {
  if (!window.QMApp || !QMApp.pushDiag) return;
  const anchor = document.getElementById("audioCard"); if (!anchor) return;
  const card = document.createElement("section"); card.className = "card dev-only"; card.id = "pushDiagCard";
  card.innerHTML = '<h2>Recent pushes on this phone</h2><p class="muted" style="font-size:.88rem">Each notification the phone was told about, how late it arrived and what happened. "priority high/normal" means Android lowered a push\'s priority, which makes it late. Useful when a notification is late or missing.</p><div id="pdList" class="pd-list"></div><div class="row" style="margin-top:.5rem"><button type="button" class="btn small" id="pdRefresh">Refresh</button></div>';
  anchor.after(card);
  const paint = () => {
    let rows = []; try { rows = JSON.parse(QMApp.pushDiag()) } catch (_) { /* none */ }
    const box = card.querySelector("#pdList"); box.replaceChildren();
    if (!rows.length) { const e = document.createElement("div"); e.className = "muted"; e.textContent = "Nothing yet. Pushes show here when they arrive."; box.append(e); return; }
    for (const r of rows.slice().reverse()) {
      const d = document.createElement("div"); d.className = "pd-row";
      d.textContent = new Date(r.t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" }) + " · " + r.type + (r.chat ? " " + r.chat : "") + " · " + r.what;
      box.append(d);
    }
  };
  card.querySelector("#pdRefresh").onclick = paint; paint();
})();
