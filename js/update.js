// "An update is available". The site publishes downloads/android.json and downloads/ios.json (the FTP deploy workflow writes them next to the
// new APK / IPA). The apps compare their own version with it:
//   Android: downloads the APK inside the app and installs it over the old one (Android asks once to allow installing from QuickMessage).
//   iPhone:  iOS can't install an app by itself; the button opens the new .ipa in Safari, and you install it with your sideloading tool.
import { confirmDialog, toast } from "./ui.js";
import { saverOn, onSaverChange } from "./datasaver.js";

const android = () => (window.QMApp && window.QMApp.appVersion && window.QMApp.downloadUpdate) ? window.QMApp : null;
const ios = () => (window.__qmIosApp && window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.qmUpdate) ? window.webkit.messageHandlers.qmUpdate : null;
export const updatesSupported = () => !!(android() || ios());
const abs = rel => new URL(rel, document.baseURI).href;

export function installedVersion() {
  try { if (android()) { const v = JSON.parse(window.QMApp.appVersion()); return { code: +v.code || 0, name: v.name || "" }; } } catch (_) { /* ignore */ }
  if (window.__qmIosApp) return { code: +window.__qmIosApp.build || 0, name: window.__qmIosApp.version || "" };
  return null;
}

/** @returns {Promise<null | {code, name, url, notes}>} the newer version, or null */
export async function findUpdate() {
  const me = installedVersion(); if (!me || !me.code) return null;
  const file = android() ? "downloads/android.json" : ios() ? "downloads/ios.json" : null; if (!file) return null;
  try {
    const r = await fetch(abs(file) + "?t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) return null;
    const j = await r.json();
    const code = +(j.versionCode || j.build || 0);
    if (code > me.code && j.url) return { code, name: j.versionName || j.version || String(code), url: abs(j.url), notes: j.notes || "" };
  } catch (_) { /* offline, or no update published yet */ }
  return null;
}

let bar = null;
function showBar(u) {
  if (bar) bar.remove();
  bar = document.createElement("div"); bar.className = "update-bar"; bar.setAttribute("role", "status");
  const t = document.createElement("div"); t.className = "ub-text"; const a = document.createElement("strong"); a.textContent = "Update available"; const b = document.createElement("span"); b.textContent = `Version ${u.name} is ready.`; t.append(a, b);
  const go = document.createElement("button"); go.type = "button"; go.className = "btn small primary"; go.textContent = android() ? "Update now" : "Download";
  const later = document.createElement("button"); later.type = "button"; later.className = "btn small"; later.textContent = "Later";
  later.onclick = () => { try { localStorage.setItem("qm-update-later", String(u.code)); } catch (_) { /* ignore */ } bar.remove(); bar = null; };
  go.onclick = () => startUpdate(u, t, go, later);
  bar.append(t, go, later); document.body.append(bar);
}

async function startUpdate(u, textEl, goBtn, laterBtn) {
  if (ios()) {
    const ok = await confirmDialog({ title: "Download the update", message: "iPhone apps can't install themselves. This opens the new QuickMessage file in Safari. Install it the same way you installed this one (Sideloadly, AltStore, …), then open the app.", okText: "Open download" });
    if (ok) window.webkit.messageHandlers.qmUpdate.postMessage({ op: "open", url: u.url });
    return;
  }
  const q = android();
  if (q.canInstallUpdates && !q.canInstallUpdates()) {
    const ok = await confirmDialog({ title: "Allow updates", message: "Android needs your permission once: in the next screen switch on “Allow from this source” for QuickMessage, then come back and press Update now again.", okText: "Open settings" });
    if (ok) q.openInstallSettings();
    return;
  }
  goBtn.disabled = true; laterBtn.hidden = true;
  const say = (head, sub) => { textEl.replaceChildren(); const a = document.createElement("strong"); a.textContent = head; const b = document.createElement("span"); b.textContent = sub || ""; textEl.append(a, b); };
  say("Downloading…", "0%");
  window.__qmUpdate = s => {
    if (s.state === "downloading") say("Downloading…", s.pct + "%");
    else if (s.state === "installing") say("Installing…", "Android may ask you to confirm.");
    else if (s.state === "confirm") say("Confirm the update", "Tap Update in the Android window.");
    else if (s.state === "failed") { say("Update failed", s.message || "Try again later."); goBtn.disabled = false; goBtn.textContent = "Try again"; laterBtn.hidden = false; }
  };
  if (q.updateBegin) { webDownload(q, u.url, say); return; }
  q.downloadUpdate(u.url);
}

/** Downloads the APK with the page's own fetch() (so the host's browser check and cookies are satisfied) and hands it to the app piece by piece. */
async function webDownload(q, url, say) {
  const fail = m => window.__qmUpdate({ state: "failed", message: m });
  try {
    if (!q.updateBegin()) return fail("Another update is already running.");
    const r = await fetch(url, { cache: "no-store", credentials: "include" });
    if (!r.ok) { q.updateAbort(); return fail("The server answered " + r.status + ". Reload the app and try again."); }
    if (/text\/html/i.test(r.headers.get("content-type") || "")) { q.updateAbort(); return fail("The host showed its browser-check page instead of the file. Reload the app once and try again."); }
    const total = Number(r.headers.get("content-length")) || 0, rd = r.body.getReader();
    let done = 0, pending = [], size = 0, last = -1;
    const flush = () => {
      if (!size) return true;
      const all = new Uint8Array(size); let o = 0; for (const p of pending) { all.set(p, o); o += p.length; } pending = []; size = 0;
      for (let s = 0; s < all.length; s += 192 * 1024) {                      // pieces of at most 192 KB across the bridge
        const part = all.subarray(s, s + 192 * 1024); let bin = "";
        for (let i = 0; i < part.length; i += 0x8000) bin += String.fromCharCode.apply(null, part.subarray(i, i + 0x8000));
        if (!q.updateChunk(btoa(bin))) return false;
      }
      return true;
    };
    for (;;) {
      const { value, done: end } = await rd.read(); if (end) break;
      pending.push(value); size += value.length; done += value.length;
      if (size >= 192 * 1024 && !flush()) return fail("Couldn't save the download on this phone.");
      if (total) { const p = Math.floor(done * 100 / total); if (p !== last) { last = p; say("Downloading…", p + "%"); } }
    }
    if (!flush()) return fail("Couldn't save the download on this phone.");
    q.updateEnd();
  } catch (e) { try { q.updateAbort(); } catch (_) { /* ignore */ } fail("Download failed: " + (e && e.message || e)); }
}

/** Looks for an update; shows the banner when there is one (unless you pressed "Later" for exactly this version, and it isn't a manual check). */
export async function checkForUpdate({ manual = false } = {}) {
  if (!updatesSupported()) return null;
  const u = await findUpdate();
  if (!u) { if (manual) toast("QuickMessage is up to date.", "success"); return null; }
  let later = ""; try { later = localStorage.getItem("qm-update-later") || ""; } catch (_) { /* ignore */ }
  if (manual || later !== String(u.code)) showBar(u);
  return u;
}

if (window.top === window && updatesSupported()) {
  // Automatic checks only run when Data Saver is off (the "Check for app updates" button on the Account page always works)
  const auto = () => { if (!saverOn()) checkForUpdate().catch(() => {}); };
  setTimeout(auto, 6000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") auto(); });
  onSaverChange(on => { if (!on) auto(); });
}
