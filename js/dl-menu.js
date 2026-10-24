// The "Download" button in the top bar: a menu with the ways to get QuickMessage on this device.
//   Install as a web app · Android app (on Android) · iPhone app (on iPhone/iPad) · More… (the download page, shown inside the app)
// Not shown inside the Android / iPhone apps themselves (they update themselves, see js/update.js).
import { confirmDialog } from "./ui.js";

const btn = document.getElementById("downloadBtn");
const ua = navigator.userAgent;
const inApp = !!window.QMApp || !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.qmGoogle);
const isAndroid = /Android/i.test(ua);
const isIOS = /iP(hone|ad|od)/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const abs = rel => new URL(rel, document.baseURI).href;

let deferred = null;                                                   // Chrome / Edge / Android: the browser's own "install" prompt
addEventListener("beforeinstallprompt", e => { e.preventDefault(); deferred = e; });
addEventListener("appinstalled", () => { deferred = null; });

const info = {};
async function loadInfo(kind) {                                       // downloads/android.json / ios.json, written by the FTP deploy workflow
  if (info[kind] !== undefined) return info[kind];
  try { const r = await fetch(abs(`downloads/${kind}.json`) + "?t=" + Date.now(), { cache: "no-store" }); info[kind] = r.ok ? await r.json() : null; } catch (_) { info[kind] = null; }
  return info[kind];
}

async function installWebApp() {
  if (deferred) { deferred.prompt(); try { await deferred.userChoice; } catch (_) { /* ignore */ } deferred = null; return; }
  const how = isIOS ? "In Safari tap the Share button, then “Add to Home Screen”. (Notifications on iPhone only work from the Home Screen icon.)"
    : isAndroid ? "Open your browser's menu (⋮) and choose “Install app” or “Add to Home screen”."
    : "Open your browser's menu and choose “Install QuickMessage” (in Chrome and Edge there is also an install icon in the address bar).";
  await confirmDialog({ title: "Install as a web app", message: how, okText: "Got it", hideCancel: true });
}

async function morePage() {
  const box = document.createElement("div"); box.className = "dl-frame-box";
  const f = document.createElement("iframe"); f.src = abs("downloads/index.html"); f.title = "Downloads"; f.className = "dl-frame"; box.append(f);
  await confirmDialog({ title: "Downloads", node: box, okText: "Close", hideCancel: true });
}

async function getFile(kind, fallback) {
  const j = await loadInfo(kind);
  return { url: abs((j && j.url) || fallback), name: j && (j.versionName || j.version) };
}

let menu = null;
const closeMenu = () => { if (menu) { menu.remove(); menu = null; btn.setAttribute("aria-expanded", "false"); document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", key, true); } };
const outside = e => { if (menu && !menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) closeMenu(); };
const key = e => { if (e.key === "Escape") { closeMenu(); btn.focus(); } };

async function openMenu() {
  closeMenu();
  menu = document.createElement("div"); menu.className = "qm-menu dl-menu"; menu.setAttribute("role", "menu");
  const item = (title, sub, run) => {
    const b = document.createElement("button"); b.type = "button"; b.className = "qm-menu-item dl-item"; b.setAttribute("role", "menuitem");
    const t = document.createElement("span"); t.className = "qm-menu-text"; const s1 = document.createElement("strong"); s1.textContent = title; t.append(s1);
    if (sub) { const s2 = document.createElement("small"); s2.textContent = sub; t.append(s2); }
    b.append(t); b.onclick = () => { closeMenu(); run(); }; menu.append(b); return b;
  };
  if (!standalone()) item("Install as a web app", isIOS ? "Add to your Home Screen" : "Works offline-ish, gets its own window", installWebApp);
  if (isAndroid) {
    const a = item("Android app", "Loading…", async () => { const f = await getFile("android", "downloads/quickmessage.apk"); location.href = f.url; });
    loadInfo("android").then(j => { a.querySelector("small").textContent = j ? `Version ${j.versionName} · allow “install unknown apps” when asked` : "Allow “install unknown apps” when asked"; });
  }
  if (isIOS) {
    const a = item("iPhone app", "Loading…", async () => {
      const ok = await confirmDialog({ title: "iPhone app", message: "This downloads an unsigned app file (.ipa). iPhones only install it through a sideloading tool such as Sideloadly or AltStore.", okText: "Download" });
      if (ok) { const f = await getFile("ios", "downloads/QuickMessage-unsigned.ipa"); location.href = f.url; }
    });
    loadInfo("ios").then(j => { a.querySelector("small").textContent = j ? `Version ${j.versionName} · needs a sideloading tool` : "Needs a sideloading tool"; });
  }
  item("More…", "All downloads (Android, iPhone, simulator)", morePage);
  document.body.append(menu);
  btn.setAttribute("aria-expanded", "true");
  const r = btn.getBoundingClientRect();
  menu.style.minWidth = Math.min(280, innerWidth - 16) + "px";
  menu.style.top = r.bottom + 6 + "px";
  menu.style.left = Math.max(8, Math.min(r.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8)) + "px";
  setTimeout(() => { document.addEventListener("pointerdown", outside, true); document.addEventListener("keydown", key, true); }, 0);
  menu.querySelector("button")?.focus({ preventScroll: true });
}

if (btn && !inApp) {
  btn.classList.remove("hidden");
  btn.addEventListener("click", () => { if (menu) closeMenu(); else openMenu(); });
}
