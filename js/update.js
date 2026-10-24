// "An update is available". The site publishes downloads/android.json and downloads/ios.json (the FTP deploy workflow writes them next to the
// new APK / IPA). The apps compare their own version with it:
//   Android: downloads the APK inside the app and installs it over the old one (Android asks once to allow installing from QuickMessage).
//   iPhone:  iOS can't install an app by itself; the button opens the new .ipa in Safari, and you install it with your sideloading tool.
import { confirmDialog, toast } from "./ui.js";

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
  q.downloadUpdate(u.url);
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
  setTimeout(() => checkForUpdate().catch(() => {}), 6000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkForUpdate().catch(() => {}); });
}
