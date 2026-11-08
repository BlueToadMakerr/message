// The saved copy of the site (kept by firebase-messaging-sw.js). After a whole session started fine, everything it loaded is saved as the
// "last working copy". If a site update is broken, that copy can be used instead ("safe mode") until the site is fixed.
import { loadedUrls } from "./refresh.js";
import { saverOn } from "./datasaver.js";

async function worker() {
  if (!("serviceWorker" in navigator)) return null;
  try { const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((_, no) => setTimeout(no, 4000))]); return reg.active || navigator.serviceWorker.controller; } catch (_) { return null; }
}
async function call(op, extra = {}) {
  const w = await worker(); if (!w) return null;
  return new Promise(res => {
    const mc = new MessageChannel(), t = setTimeout(() => res(null), 30000);
    mc.port1.onmessage = e => { clearTimeout(t); res(e.data); };
    try { w.postMessage({ op, ...extra }, [mc.port2]); } catch (_) { clearTimeout(t); res(null); }
  });
}
/** { ok, safe, has, version, at, count } or null when this browser has no service worker. */
export const copyStatus = () => call("status");
export const setSafeMode = on => call("safe", { on: !!on });
export const forgetCopy = () => call("forget");
export function saveWorkingCopy(version) {
  const urls = new Set(); loadedUrls(window.top || window, urls);
  for (const s of ["index.html", "message.html", "account.html", "call.html", "style.css", "call.css", "offline.html"]) urls.add(new URL(s, location.href).href);
  return call("promote", { version, urls: [...urls], noFetch: saverOn() });
}

/** App shell: after a calm 40 s without a failed page, save this session as the last working copy (again when the version changes or after 3 days); in safe mode show a banner. */
export function watchSavedCopy(version) {
  setTimeout(async () => {
    const st = await copyStatus(); if (!st) return;
    if (st.safe) { banner(); return; }
    if (document.querySelector(".frame-err") || !navigator.serviceWorker.controller) return;
    if (st.has && st.version === version && Date.now() - st.at < 3 * 864e5) return;
    saveWorkingCopy(version).catch(() => {});
  }, 40000);
  copyStatus().then(st => { if (st && st.safe) banner(); });
}
function banner() {
  if (document.getElementById("safeBar")) return;
  const b = document.createElement("div"); b.className = "verify-banner"; b.id = "safeBar"; b.setAttribute("role", "status");
  const t = document.createElement("span"); t.className = "vb-text"; t.textContent = "Safe mode: you are using the last working copy of QuickMessage, not the newest site.";
  const go = document.createElement("button"); go.type = "button"; go.className = "btn small primary"; go.textContent = "Use the live site";
  go.onclick = async () => { await setSafeMode(false); location.reload(); };
  b.append(t, go); document.body.prepend(b);
}
