// Shared page chrome, loaded by every page:
//   - theme: follows the device (in the app: Android's own setting) and changes instantly in the page and all its frames
//   - app niceties: no text highlighting, native safe-area insets, picture-in-picture state
//   - offline banner and a "still loading" hint for slow connections
//   - top window only: browser theme-color / Android bar colours follow the app background
const root = document.documentElement;
const isCallPage = /call\.html$/.test(location.pathname);
const inApp = !!window.QMApp;
if (inApp) root.classList.add("in-app");

// ---- theme
const storedTheme = () => { try { return localStorage.getItem("theme") || "system"; } catch (_) { return "system"; } };
function effectiveTheme() {
  const t = storedTheme();
  if (t === "system" && window.QMApp && window.QMApp.isDark) { try { return window.QMApp.isDark() ? "dark" : "light"; } catch (_) { /* fall through */ } }
  return t;
}
function syncTheme() { if (!isCallPage && root.dataset.theme !== effectiveTheme()) root.dataset.theme = effectiveTheme(); }
window.__qmApplyTheme = syncTheme;
syncTheme();
addEventListener("storage", e => { if (e.key === "theme") syncTheme(); });
try { new BroadcastChannel("qm-theme").onmessage = syncTheme; } catch (_) { /* old browser */ }
setInterval(syncTheme, 700);       // Android switching light/dark while the app is open

// ---- app: no highlighting
if (inApp) {
  const css = document.createElement("style");
  css.textContent = "html.in-app, html.in-app * { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent; }" +
    "html.in-app input, html.in-app textarea, html.in-app [contenteditable='true'] { -webkit-user-select: text; user-select: text; }" +
    "html.in-app { padding-left: var(--page-l, 0px); padding-right: var(--page-r, 0px); }";
  document.head.append(css);
}

// ---- app: native insets (frames don't inherit the top window's variables). Only a window whose edge really is the screen's
// edge pads for it: the top window (list), the chat pane when nothing sits above it, the call page. A frame below the green
// call bar / offline banner, and the chat panel inside the call page, add no margin of their own.
const isTop = window.top === window;
const pv = n => { try { return window.parent.document.documentElement.style.getPropertyValue(n); } catch (_) { return ""; } };
let parentIsTop = false; try { parentIsTop = !isTop && window.parent === window.top; } catch (_) { /* ignore */ }
const deepFrame = !isTop && !parentIsTop;            // e.g. message.html?panel=1 inside the call page
let wasPip = false;
if (window.QMApp && window.QMApp.insets) {
  const sync = () => {
    try {
      const i = JSON.parse(window.QMApp.insets()), st = root.style, px = n => n + "px";
      const off = (root.classList.contains("is-offline") || root.classList.contains("has-vb")) && isTop, bar = root.classList.contains("has-bar");
      let t = i.t, b = i.b, l = 0, r = 0, pl = 0, pr = 0;
      if (isTop) {
        l = i.l; r = i.r; pl = isCallPage ? 0 : i.l; pr = isCallPage ? 0 : i.r;
        st.setProperty("--sat-raw", px(i.t));
        st.setProperty("--frame-sat", px(off || bar ? 0 : i.t));
        st.setProperty("--call-sat", px(off ? 0 : i.t));
        t = off ? 0 : i.t;
      } else if (deepFrame) { t = 0; b = 0; }
      else if (isCallPage) { const c = pv("--call-sat"); t = c ? parseFloat(c) : i.t; l = i.l; r = i.r; }
      else { const f = pv("--frame-sat"); t = f ? parseFloat(f) : i.t; }
      st.setProperty("--sat", px(t)); st.setProperty("--sab", px(b));
      st.setProperty("--sal", px(l)); st.setProperty("--sar", px(r));
      st.setProperty("--page-l", px(pl)); st.setProperty("--page-r", px(pr));
      const pip = !!window.QMApp.inPip();
      root.classList.toggle("qm-pip", pip);
      // pip-tile is set a moment BEFORE Android reports being in PiP: only clear it once PiP has really been left again
      if (pip) wasPip = true;
      else if (wasPip) { wasPip = false; root.classList.remove("pip-tile"); document.querySelectorAll(".tile.pip-target").forEach(t => t.classList.remove("pip-target")); }
    } catch (_) { /* ignore */ }
  };
  sync(); setInterval(sync, 500); addEventListener("resize", sync);
}

// ---- offline banner (top window) and slow-loading hint (every page)
function pill(id, cls) {
  let el = document.getElementById(id);
  if (!el) { el = document.createElement("div"); el.id = id; el.className = cls; el.setAttribute("role", "status"); el.hidden = true; (document.body || root).append(el); }
  return el;
}
{
  const css = document.createElement("style");
  css.textContent = "#qmOffline{position:fixed;z-index:99998;left:0;right:0;top:0;padding:calc(var(--sat-raw,env(safe-area-inset-top,0px)) + 6px) 12px 6px;background:#d92d3f;color:#fff;font:600 13px system-ui,sans-serif;text-align:center}" +
    "#qmSlow{position:fixed;z-index:99997;left:50%;bottom:calc(var(--sab,0px) + 14px);transform:translateX(-50%);padding:7px 14px;border-radius:999px;background:rgba(20,22,28,.88);color:#fff;font:600 13px system-ui,sans-serif;max-width:90vw;text-align:center;pointer-events:none}";
  (document.head || root).append(css);
}
// Banners that sit at the top of the app (offline, "verify your email", "new version", "safe mode") are stacked one under the other, each
// below the previous, and the page is pushed down by their total height (--vb-h) so nothing slides underneath them.
function stackBanners() {
  if (window.top !== window) return;
  const off = document.getElementById("qmOffline"), offH = off && !off.hidden ? off.offsetHeight : 0;
  const bs = [...document.querySelectorAll(".verify-banner")].filter(b => !b.hidden);
  let acc = offH;
  bs.forEach((b, i) => { b.style.top = acc + "px"; b.classList.toggle("vb-first", i === 0); acc += b.offsetHeight; });
  root.style.setProperty("--off-h", offH + "px"); root.style.setProperty("--vb-h", (acc - offH) + "px");
  root.classList.toggle("has-vb", bs.length > 0); root.classList.toggle("is-offline", offH > 0);
}
window.__qmStack = stackBanners;
const SLOW_MS = 2500, t0 = Date.now();
let hadFail = false;
setInterval(() => {
  if (window.top === window) { const o = pill("qmOffline", ""); const off = navigator.onLine === false; o.hidden = !off; if (off) o.textContent = "You're offline. Waiting for a connection…";
    stackBanners(); }
  const s = pill("qmSlow", ""); const waiting = !window.__qmReady && Date.now() - t0 > SLOW_MS;
  s.hidden = !waiting;
  if (waiting) s.textContent = navigator.onLine === false ? "No connection. This page will load when you're back online…" : "Still loading… your connection looks slow";
}, 400);

// Keeps the browser's top bar (theme-color) and the Android app's status/navigation bars the same colour as the app's background.
// Runs only in the top window; the full-screen call layer counts as "the background" while it is up.
if (window.top === window) {
  let last = "";
  const hex = c => {
    const m = /rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/.exec(c || "");
    return m ? "#" + [m[1], m[2], m[3]].map(n => (+n).toString(16).padStart(2, "0")).join("") : null;
  };
  const apply = () => {
    let color = null;
    try {
      const layer = document.getElementById("callLayer");
      const callUp = layer && !layer.hidden && !layer.classList.contains("min");
      const el = callUp ? layer : document.body;
      color = hex(getComputedStyle(el).backgroundColor);
      if (callUp && (!color || color === "#000000")) color = hex(getComputedStyle(document.body).backgroundColor);
      if (callUp) { const f = document.getElementById("callFrame"); const cb = f && f.contentDocument && hex(getComputedStyle(f.contentDocument.body).backgroundColor); if (cb) color = cb; }
    } catch (_) { /* cross-frame access can fail while loading */ }
    if (!color || color === last) return;
    last = color;
    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) { meta = document.createElement("meta"); meta.name = "theme-color"; document.head.append(meta); }
    meta.content = color;
    const n = parseInt(color.slice(1), 16), lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    try { window.QMApp && window.QMApp.setBars && window.QMApp.setBars(color, lum > 0.55); } catch (_) { /* not in the app */ }
  };
  document.addEventListener("DOMContentLoaded", apply);
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", apply);
  new MutationObserver(apply).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  setInterval(apply, 700);
  apply();
}

// ---- own drop-downs / colour picker instead of the phone's white native ones (touch devices and the apps)
import("./customui.js").catch(() => {});


// ---- a page that breaks while it starts (a script that throws, a module that can't load) is treated as unrecoverable AT ONCE:
// no waiting for the 15 s watchdog and no retry loop. Inside the app the shell shows its error screen (or, the first time in 10 minutes,
// does a full refresh by itself); a page opened on its own gets the same screen here.
{
  let done = false;
  const sameOrigin = f => !f || String(f).startsWith(location.origin);
  const fatal = msg => {
    if (done || window.__qmReady) return; done = true;
    try { const qm = window.parent !== window && window.parent.QM; if (qm && window.frameElement && qm.frameFatal) { qm.frameFatal(window.frameElement, String(msg).slice(0, 160)); return; } } catch (_) { /* fall through */ }
    if (window.parent !== window) return;
    standaloneError(msg);
  };
  // A module that can't load is reported against the page's own script, even when one of the files IT imports is the real culprit
  // (missing on the host, or the host answering with a web page). Walk the imports to name the file that is actually bad.
  async function culprit(src) {
    const seen = new Set(), q = [src]; let n = 0;
    while (q.length && n++ < 60) {
      const u = q.shift(); if (seen.has(u)) continue; seen.add(u);
      let r, txt = "";
      try { r = await fetch(u, { cache: "no-store" }); txt = r.ok ? await r.text() : ""; } catch (_) { return u.replace(location.origin, "") + " (can't be reached)"; }
      if (!r.ok) return u.replace(location.origin, "") + " (HTTP " + r.status + ")";
      if (/^\s*</.test(txt)) return u.replace(location.origin, "") + " (the host sent a web page instead of the script)";
      for (const m of txt.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) q.push(new URL(m[1], u).href);
    }
    return "";
  }
  addEventListener("error", e => {
    const t = e.target;
    if (t && t !== window && t.tagName === "SCRIPT") {
      if (sameOrigin(t.src)) { const base = "A script didn't load: " + String(t.src).replace(location.origin, ""); Promise.race([culprit(t.src), new Promise(r => setTimeout(() => r(""), 2500))]).catch(() => "").then(c => fatal(c && !base.includes(c.split(" ")[0]) ? base + " \u2192 bad file: " + c : (c ? base + " \u2192 " + c.replace(/^\S+ /, "") : base))); }
      return;
    }
    if (t === window && sameOrigin(e.filename) && e.filename && !/ResizeObserver/.test(e.message || "")) fatal((e.message || "Script error") + (e.filename ? " (" + String(e.filename).replace(location.origin, "") + ":" + e.lineno + ")" : ""));
  }, true);
  addEventListener("unhandledrejection", e => {
    const m = String((e.reason && (e.reason.message || e.reason)) || "");
    if (/dynamically imported module|Importing a module script failed|module script/i.test(m)) fatal(m);
  });
}
function standaloneError(msg) {
  const last = +(sessionStorage.getItem("qm-autofix") || 0), offline = navigator.onLine === false;
  const full = () => import("./refresh.js").then(m => m.fullRefresh()).catch(() => { try { caches.keys().then(ks => Promise.all(ks.filter(k => !k.startsWith("qm-")).map(k => caches.delete(k)))).finally(() => location.reload()); } catch (_) { location.reload(); } });
  if (!offline && Date.now() - last > 600000) { try { sessionStorage.setItem("qm-autofix", String(Date.now())); } catch (_) { /* ignore */ } full(); return; }
  const o = document.createElement("div");
  o.style.cssText = "position:fixed;inset:0;z-index:100000;display:grid;place-items:center;padding:24px;text-align:center;background:var(--bg,#f4f5f9);color:var(--text,#161a23);font:16px/1.5 system-ui,sans-serif";
  o.innerHTML = '<div style="max-width:420px"><h2 style="margin:.2rem 0"></h2><p style="opacity:.75"></p><code style="display:block;font-size:12px;opacity:.6;word-break:break-all;margin:.6rem 0"></code><button class="a" style="height:44px;padding:0 20px;border:0;border-radius:12px;background:#4f46e5;color:#fff;font:600 1rem system-ui;cursor:pointer;margin:4px">Full refresh</button><button class="b" style="height:44px;padding:0 20px;border:1px solid #8886;border-radius:12px;background:none;color:inherit;font:600 1rem system-ui;cursor:pointer;margin:4px">Try again</button></div>';
  o.querySelector("h2").textContent = offline ? "You're offline" : "QuickMessage hit a problem";
  o.querySelector("p").textContent = offline ? "This page isn't saved on this device yet. It will load when you're back online." : "Something went wrong while the page was starting. A full refresh fetches everything again and usually fixes it.";
  o.querySelector("code").textContent = String(msg).slice(0, 200);
  o.querySelector(".a").onclick = e => { e.target.disabled = true; e.target.textContent = "Refreshing\u2026"; full(); };
  o.querySelector(".b").onclick = () => location.reload();
  (document.body || document.documentElement).append(o);
}

// usage statistics (account based, see analytics.js): screens + errors on every page
import("./analytics.js").catch(() => {});
