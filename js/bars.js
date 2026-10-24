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
const SLOW_MS = 2500, t0 = Date.now();
let hadFail = false;
setInterval(() => {
  if (window.top === window) { const o = pill("qmOffline", ""); const off = navigator.onLine === false; o.hidden = !off; if (off) o.textContent = "You're offline. Waiting for a connection…";
    root.classList.toggle("is-offline", off); root.style.setProperty("--off-h", off ? o.offsetHeight + "px" : "0px"); }
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
