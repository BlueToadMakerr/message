// Site version. Bump SITE_VERSION here and in version.json (the file the check reads) on every release.
// API_VERSION is the plugin API (docs: plugin-docs.html): it only changes when a plugin could stop working.
export const SITE_VERSION = "1.59.0";
export const API_VERSION = 1;
import { saverOn, onSaverChange } from "./datasaver.js";
import { fullRefresh } from "./refresh.js";
const KEY = "qm-latest";

/** Compare dotted versions ("1.10.0" > "1.9.2"). Returns -1, 0 or 1. Missing parts count as 0. */
export function cmpVer(a, b) {
  const pa = String(a || "0").split(".").map(n => parseInt(n, 10) || 0), pb = String(b || "0").split(".").map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}
export const validVer = v => typeof v === "string" && /^\d+(\.\d+){0,3}$/.test(v);

export function lastCheck() { try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch (_) { return null; } }

/** Reads version.json from the site. Resolves {ok, latest, newer, info, at}; ok=false when it couldn't be reached (offline copy, no network). */
export async function checkSiteVersion() {
  const at = Date.now();
  try {
    const r = await fetch("version.json?_=" + at, { cache: "no-store" });
    const info = await r.json();
    if (!r.ok || !validVer(info.version)) throw new Error("bad version.json");
    const res = { ok: true, latest: info.version, newer: cmpVer(info.version, SITE_VERSION) > 0, info, at };
    try { localStorage.setItem(KEY, JSON.stringify(res)); } catch (_) { /* ignore */ }
    return res;
  } catch (e) { return { ok: false, latest: null, newer: false, error: String(e && e.message || e), at }; }
}

/** Shell: checks now and every 30 minutes; shows a bar when a newer version exists. */
export function watchSiteVersion() {
  let bar = null;
  const show = res => {
    if (!res.newer) { bar?.remove(); bar = null; window.__qmStack && window.__qmStack(); return; }
    let dismissed = ""; try { dismissed = sessionStorage.getItem("qm-ver-dismissed") || ""; } catch (_) { /* ignore */ }
    if (bar || dismissed === res.latest) return;
    bar = document.createElement("div");
    bar.className = "verify-banner"; bar.setAttribute("role", "status"); bar.id = "versionBar";
    const t = document.createElement("span"); t.className = "vb-text"; t.textContent = `A new version of QuickMessage is available (${res.latest}; you have ${SITE_VERSION}).`;
    const go = document.createElement("button"); go.type = "button"; go.className = "btn small primary"; go.textContent = "Reload";
    go.onclick = () => { go.disabled = true; go.textContent = "Refreshing\u2026"; fullRefresh(); };          // a full refresh, not just a page reload
    const x = document.createElement("button"); x.type = "button"; x.className = "btn small"; x.textContent = "Later";
    x.onclick = () => { try { sessionStorage.setItem("qm-ver-dismissed", res.latest); } catch (_) { /* ignore */ } bar?.remove(); bar = null; window.__qmStack && window.__qmStack(); };
    bar.append(t, go, x); bar.hidden = false;
    document.body.prepend(bar); window.__qmStack && window.__qmStack();
  };
  const run = () => checkSiteVersion().then(show);
  // Data Saver: no automatic version checks (they start again when it is switched off)
  const auto = () => { if (!saverOn()) run(); };
  auto(); setInterval(auto, 30 * 60 * 1000); onSaverChange(on => { if (!on) run(); });
}
