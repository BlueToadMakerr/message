// Site version. Bump SITE_VERSION here and in version.json (the file the check reads) on every release.
// API_VERSION is the plugin API (docs: plugin-docs.html): it only changes when a plugin could stop working.
export const SITE_VERSION = "1.74.1";
export const API_VERSION = 1;
import { saverOn, onSaverChange } from "./datasaver.js";

/** "1.2.3" shaped? */
export const validVer = v => typeof v === "string" && /^\d{1,4}\.\d{1,5}\.\d{1,6}$/.test(v);
/** <0 when a is older than b, 0 when equal, >0 when newer. */
export function cmpVer(a, b) {
  const x = String(a).split(".").map(Number), y = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; }
  return 0;
}

let last = null;
/** The result of the most recent check (or null): { ok, newer, latest, at }. */
export const lastCheck = () => last;

/** Asks the site for version.json. Never throws: { ok:false } when it can't be reached (offline copy, no connection). */
export async function checkSiteVersion() {
  try {
    const r = await fetch("version.json?t=" + Date.now(), { cache: "no-store" });
    const j = await r.json();
    if (!r.ok || !validVer(j.version)) throw new Error("bad answer");
    last = { ok: true, newer: cmpVer(j.version, SITE_VERSION) > 0, latest: j.version, at: Date.now() };
  } catch (_) { last = { ok: false, newer: false, latest: "", at: Date.now() }; }
  return last;
}

function showBar(latest) {
  if (document.getElementById("qmVerBar")) return;
  const bar = document.createElement("div"); bar.id = "qmVerBar"; bar.setAttribute("role", "status");
  bar.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);bottom:max(12px,env(safe-area-inset-bottom));z-index:100001;display:flex;gap:.6rem;align-items:center;padding:.5rem .8rem;border-radius:999px;background:#1f232d;color:#fff;box-shadow:0 6px 20px #0006;font-size:.85rem;max-width:94vw";
  const t = document.createElement("span"); t.textContent = "Version " + latest + " is available.";
  const b = document.createElement("button"); b.textContent = "Reload"; b.style.cssText = "border:0;border-radius:999px;padding:.3rem .8rem;background:var(--accent,#4f46e5);color:#fff;font:inherit;font-weight:600;cursor:pointer";
  b.onclick = () => location.reload();
  const x = document.createElement("button"); x.textContent = "×"; x.setAttribute("aria-label", "Dismiss"); x.style.cssText = "border:0;background:transparent;color:inherit;font-size:1.1rem;cursor:pointer";
  x.onclick = () => bar.remove();
  bar.append(t, b, x); document.body.append(bar);
}

/** Checks when the app opens and every 30 minutes (not while Data Saver is on); a newer version shows a Reload bar. */
export function watchSiteVersion() {
  const run = async () => { if (saverOn() || navigator.onLine === false) return; const r = await checkSiteVersion(); if (r.ok && r.newer) showBar(r.latest); };
  setTimeout(run, 4000); setInterval(run, 30 * 60 * 1000);
  onSaverChange(on => { if (!on) run(); });
}
