// App shell (index.html): chat list on the left; the open chat/account page in an <iframe> on the right (desktop) or
// full-screen over the list (mobile); and ONE persistent call <iframe> that survives switching chats, with a
// Discord-style "in call" bar while the call is minimised. Embedded pages reach this through `parent.QM` (see embed.js).
import { track } from "./analytics.js";
import { watchIncomingCalls, hideIncoming } from "./incoming.js";
import { fmtDuration } from "./call-banner.js";
import { icon, avatarEl, localToast, confirmDialog, alertDialog } from "./ui.js";

window.__qmToast = localToast;       // embedded pages route their toasts here (see ui.js toast)
import { getProfile } from "./users.js";
import { watchDeclines } from "./declines.js";
import { iosUploads, iosUploadFailed } from "./ios-notify.js";     // iPhone app: defines window.__qmIosCall (pauses the background-keepalive during calls)
import { plugins as pluginHost } from "./plugins.js";    // Developer-mode plugins (sandboxed): see plugin-docs.html
import { watchSiteVersion, SITE_VERSION } from "./version.js";
import { watchSavedCopy, copyStatus, setSafeMode } from "./sitecopy.js";
import { fullRefresh, warmAppCache } from "./refresh.js";
warmAppCache();
import "./viewer.js";                 // registers window.__qmOpenImage: images from every frame open full-screen here

const $ = id => document.getElementById(id);
const split = matchMedia("(min-width: 900px)");
let uid = null, stopRings = null, stopDeclines = null, timer = null;
const st = { chatId: null, pane: null, call: { chatId: null, joined: false, visible: false, muted: false, canMic: true, startLocal: null, title: "" } };

const els = () => ({
  detail: $("detailFrame"), layer: $("callLayer"), callFrame: $("callFrame"), bar: $("callBar")
});

// Changing iframe.src adds an entry to the *page's* history, so the browser's Back button would navigate the iframe
// (leaving a blank white pane). location.replace() swaps the content without touching history.
// A history entry also remembers what every iframe showed at that moment, and traversing back to it navigates the iframes to
// that stale content (an ended call page would reload and silently rejoin!). So a frame is never navigated in place: it is
// swapped for a brand-new <iframe> with a unique name, which no older history entry knows about.
function navFrame(frame, url, retry = false) {
  const old = document.getElementById(frame.id) || frame;
  const fresh = document.createElement("iframe");
  for (const a of old.attributes) if (a.name !== "src" && a.name !== "name") fresh.setAttribute(a.name, a.value);
  fresh.name = "qmf" + Math.random().toString(36).slice(2, 9);
  const w = watch.get(old);
  if (w) { watch.delete(old); }
  fresh.src = url;
  old.replaceWith(fresh);
  if (w) watch.set(fresh, w);
  armWatch(fresh, url, retry);
  return fresh;
}

// ---- frame watchdog: a page that fails to load (network blip, host error page, crashed module) used to leave a white pane.
// Every embedded page calls QM.frameReady() once it has booted. If that doesn't happen in time we reload the frame (with a
// cache-busting param), and after a few tries show an explicit error with a Retry button instead of a blank pane.
const READY_MS = 15000, MAX_TRIES = 3;
const watch = new Map();                  // frame -> { url, tries, timer }
function clearWatch(frame) { const w = watch.get(frame); if (w) { clearTimeout(w.timer); watch.delete(frame); } showFrameError(frame, false); }
function armWatch(frame, url, retry) {
  const prev = watch.get(frame);
  if (prev) clearTimeout(prev.timer);
  if (!url || url === "about:blank") { watch.delete(frame); showFrameError(frame, false); return; }
  const base = url.replace(/([?&])_r=\d+/, "").replace(/[?&]$/, "");
  const tries = retry && prev && prev.base === base ? prev.tries : 0;
  const w = { url, base, tries, timer: setTimeout(() => stalled(frame), READY_MS) };
  watch.set(frame, w);
}
function stalled(frame) {
  const w = watch.get(frame);
  if (!w) return;
  if (w.tries >= MAX_TRIES) { showFrameError(frame, true, { kind: navigator.onLine === false ? "offline" : "stall" }); return; }
  w.tries++;
  const url = w.base + (w.base.includes("?") ? "&" : "?") + "_r=" + Date.now();
  const keep = w.tries;
  const nf = navFrame(frame, url, true);
  const nw = watch.get(nf); if (nw) nw.tries = keep;
}
function frameReady(frame) { if (frame && watch.has(frame)) clearWatch(frame); }
/** The error screen for a pane. info.kind: "stall" (didn't load in time), "offline", "script" (the page broke while starting), "fixing" (a full refresh is running). */
function showFrameError(frame, on, info = {}) {
  const host = frame && frame.parentElement;
  if (!host) return;
  let box = host.querySelector(":scope > .frame-err[data-for='" + frame.id + "']");
  if (!on) { box?.remove(); return; }
  if (box && box.dataset.kind === (info.kind || "stall")) return;
  box?.remove();
  const kind = info.kind || (navigator.onLine === false ? "offline" : "stall");
  box = document.createElement("div");
  box.className = "frame-err"; box.dataset.for = frame.id; box.dataset.kind = kind;
  const T = {
    offline: ["You're offline", "This page isn't saved on this device yet. It will load when you're back online."],
    script: ["This page hit a problem", "Something went wrong while it was starting. A full refresh fetches everything again and usually fixes it."],
    fixing: ["Refreshing QuickMessage\u2026", "This page hit a problem, so the app is fetching a fresh copy of everything."],
    stall: ["This page didn't load", "Check your connection. If it keeps failing, a full refresh fetches everything again."]
  }[kind];
  const inner = document.createElement("div"); inner.className = "fe-card";
  const h = document.createElement("strong"); h.textContent = T[0];
  const pp = document.createElement("p"); pp.textContent = T[1];
  inner.append(h, pp);
  if (info.detail) { const c = document.createElement("code"); c.className = "fe-detail"; c.textContent = info.detail; inner.append(c); }
  const row = document.createElement("div"); row.className = "fe-actions";
  const mk = (label, cls, fn) => { const b = document.createElement("button"); b.type = "button"; b.className = "btn " + cls; b.textContent = label; b.onclick = fn; row.append(b); return b; };
  if (kind !== "fixing") {
    mk("Full refresh", kind === "script" || kind === "stall" ? "primary" : "", e => { e.target.disabled = true; e.target.textContent = "Refreshing\u2026"; fullRefresh(); });
    mk("Try again", kind === "offline" ? "primary" : "", () => { box.remove(); const cf = document.getElementById(frame.id) || frame; const w = watch.get(cf); const base = w ? w.base : cf.dataset.src || cf.src; if (w) w.tries = 0; navFrame(cf, base, false); });
  }
  inner.append(row); box.append(inner); host.append(box);
  if (kind === "fixing") return;
  // Maybe a broken update: offer the last working copy of the site (not available in the apps, which keep their own copy)
  if (window.QMApp) return;
  copyStatus().then(st => {
    if (!st || !st.has || st.safe || !box.isConnected) return;
    mk("Use the last working copy", "", async e => { e.target.disabled = true; await setSafeMode(true); location.reload(); });
  }).catch(() => {});
}
/** A page broke while it started (js/bars.js): no waiting, no retries. The first time in 10 minutes the app refreshes itself completely; after that the error screen stays. */
function frameFatal(frame, msg) {
  if (!frame) return;
  track("app_fatal", { kind: "script", detail: msg, page: String(frame.src || frame.dataset.src || "").split("?")[0].split("/").pop() });
  const w = watch.get(frame); if (w) { clearTimeout(w.timer); w.tries = MAX_TRIES; }
  let last = 0; try { last = +(sessionStorage.getItem("qm-autofix") || 0); } catch (_) { /* ignore */ }
  if (navigator.onLine !== false && Date.now() - last > 600000) {
    try { sessionStorage.setItem("qm-autofix", String(Date.now())); } catch (_) { /* ignore */ }
    showFrameError(frame, true, { kind: "fixing" }); fullRefresh(); return;
  }
  showFrameError(frame, true, { kind: navigator.onLine === false ? "offline" : "script", detail: msg });
}
/** The Android app reports a pane whose page the network refused (instead of the browser's own error page showing inside it). */
function frameFailed(url, code) {
  track("page_load_failed", { code: String(code || "").slice(0, 40), page: String(url || "").split("?")[0].split("/").pop() });
  const base = String(url || "").replace(/([?&])_r=\d+/, "").replace(/[?&]$/, "");
  const strip = u => String(u || "").replace(/([?&])_r=\d+/, "").replace(/[?&]$/, "");
  for (const f of document.querySelectorAll("iframe")) {
    const w = watch.get(f);
    if (!(w && (w.base === base || w.url === url)) && strip(f.src) !== base) continue;
    if (w) { clearTimeout(w.timer); w.tries = MAX_TRIES; }
    showFrameError(f, true, { kind: /INTERNET_DISCONNECTED|NETWORK_CHANGED|NAME_NOT_RESOLVED/.test(code) || navigator.onLine === false ? "offline" : "stall", detail: code ? "net::" + code : "" });
  }
}
// A frame that ended up showing the app shell itself (e.g. a stray link to index.html) is sent back to what it should show.
function frameEscaped(frame) {
  if (!frame) return;
  const want = frame.id === "callFrame" ? (st.call.chatId ? callUrl(st.call.chatId) : "about:blank") : (frame.dataset.src || "about:blank");
  navFrame(document.getElementById(frame.id) || frame, want);
}
const nested = (() => { try { return window.parent !== window && !!window.parent.QM; } catch (_) { return false; } })();
if (nested) { try { window.stop(); const f = window.frameElement; setTimeout(() => window.parent.QM.frameEscaped(f), 0); } catch (_) { /* ignore */ } }

const callUrl = id => `call.html?chatId=${encodeURIComponent(id)}`;
function chatUrl(id) { return `message.html?chatId=${encodeURIComponent(id)}`; }

// ------------------------------------------------------------------ navigation
// ONE controller owns all history, for the browser's Back and Android's Back alike. Every history entry stores the whole
// *view* {chat, pane, call}; Back never "goes back inside a frame" (which could leak into other frames and blank them).
// Instead the shell restores the previous view. Frames never push history (embed.js turns their links into replace()).
let depth = 0;
const urlFor = v => v.pane === "account" ? "?pane=account" : v.pane === "chat" && v.chat ? "?chat=" + encodeURIComponent(v.chat) : location.pathname;
function viewFromUrl() {
  const q = new URLSearchParams(location.search), chat = q.get("chat"), pane = q.get("pane");
  if (pane === "account") return { chat: null, pane: "account", call: false };
  if (chat && /^[\w-]{1,64}$/.test(chat)) return { chat, pane: "chat", call: false };
  return { chat: null, pane: null, call: false };
}

// ------------------------------------------------------------------ uploads
// The chat page reports its running uploads here (QM.setUploads). While a chat has any, its page is kept (hidden) when you leave it, so the upload
// continues and the message is still sent. The chat list shows a small indicator, the browser asks before the tab is closed, and the apps show a notification.
const upl = new Map();                    // chatId -> [{ id, name, size, pct, state }]
const parked = new Map();                 // chatId -> hidden <iframe> that still has uploads
const chatOfSrc = src => { const m = /^message\.html\?chatId=([^&]+)/.exec(src || ""); try { return m ? decodeURIComponent(m[1]) : null; } catch (_) { return null; } };
function park(frame, chat) {
  clearWatch(frame);
  frame.id = "parked-" + chat; frame.hidden = true; frame.classList.add("parked"); delete frame.dataset.src;
  parked.set(chat, frame);
}
function parkFresh(old, chat, url) {
  const fresh = document.createElement("iframe");
  for (const a of old.attributes) if (!["src", "name", "id", "hidden", "class", "data-src"].includes(a.name)) fresh.setAttribute(a.name, a.value);
  fresh.id = "detailFrame"; fresh.name = "qmf" + Math.random().toString(36).slice(2, 9);
  if (url !== "about:blank") fresh.dataset.src = url;
  fresh.src = url;
  park(old, chat);
  old.after(fresh);
  armWatch(fresh, url, false);
}
const upTitle = chat => { const el = document.querySelector(`.chat-item[data-chat="${CSS.escape(chat)}"] .chat-title`); return el ? el.textContent : "a chat"; };
const activeUploads = () => { const out = []; for (const [chat, list] of upl) for (const j of list) if (j.state !== "error") out.push({ ...j, chat }); return out; };
let lastNative = "", failedSeen = new Set();
function uploadsChanged() {
  try { window.dispatchEvent(new CustomEvent("qm-uploads")); } catch (_) { /* ignore */ }
  const act = activeUploads();
  const known = act.filter(j => typeof j.pct === "number");
  const pct = known.length ? Math.round(known.reduce((a, j) => a + j.pct, 0) / known.length * 100) : -1;
  const text = act.slice(0, 3).map(j => j.name).join(", ") + (act.length > 3 ? " +" + (act.length - 3) : "");
  const key = act.length + "/" + pct + "/" + text;
  persistUploads(act.map(j => j));
  if (key !== lastNative) {
    lastNative = key;
    try { window.QMApp?.setUploads?.(act.length, pct, text); } catch (_) { /* ignore */ }
    try { iosUploads({ count: act.length, pct, text }); } catch (_) { /* ignore */ }
  }
  // a failure while you aren't looking at that chat is announced (the app shows a notification, the web a message)
  for (const [chat, list] of upl) for (const j of list) {
    const k = chat + ":" + j.id;
    if (j.state === "error" && !failedSeen.has(k)) {
      failedSeen.add(k);
      if (st.chatId !== chat || st.call.visible) {
        const msg = `${j.name} couldn't be uploaded in ${upTitle(chat)}. Open the chat to retry.`;
        localToast(msg, "error", 6000);
        try { window.QMApp?.uploadFailed?.(msg); } catch (_) { /* ignore */ }
        try { iosUploadFailed(msg); } catch (_) { /* ignore */ }
      }
    }
  }
}
// ---- uploads that belong to ANOTHER page of this app. In the Android app, closing the app from the recent apps list leaves the page that is
// uploading running quietly in the background (see MainActivity "headless"); the app you open next is a new page. Each page writes what it is
// uploading into localStorage (shared by both), so the new page can show those files as "Uploading…" with their progress, and can tell when
// an upload was cut off (the iPhone app has no way to keep going once it was force-quit): that page's entry stops being refreshed.
const IN_APP = !!(window.QMApp || window.__qmIosApp);
const INST = Math.random().toString(36).slice(2, 10), UP_KEY = "qm-up:", UP_FRESH = 90000;
function persistUploads(act) {
  if (!IN_APP) return;
  try {
    if (act.length) localStorage.setItem(UP_KEY + INST, JSON.stringify({ t: Date.now(), list: act.map(j => ({ chat: j.chat, id: String(j.id), name: String(j.name || "File").slice(0, 80), size: j.size || 0, pct: typeof j.pct === "number" ? j.pct : null })) }));
    else localStorage.removeItem(UP_KEY + INST);
  } catch (_) { /* storage blocked */ }
}
/** What other pages are uploading right now: [{ key, chat, id, name, size, pct }] (only entries that were refreshed lately). */
function foreignUploads(chat) {
  const out = [];
  if (!IN_APP) return out;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(UP_KEY) || k === UP_KEY + INST) continue;
      let v = null; try { v = JSON.parse(localStorage.getItem(k)); } catch (_) { /* ignore */ }
      if (!v || !Array.isArray(v.list) || Date.now() - v.t > UP_FRESH) continue;
      for (const j of v.list) if (j && typeof j.chat === "string" && (!chat || j.chat === chat)) out.push({ ...j, key: k });
    }
  } catch (_) { /* ignore */ }
  return out;
}
/** An entry nobody refreshes any more belongs to a page that is gone (the app was force-quit): that upload did not finish. Tell the user once. */
function sweepUploads() {
  if (!IN_APP || nested) return;
  const dead = [];
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(UP_KEY) && k !== UP_KEY + INST) keys.push(k); }
    for (const k of keys) {
      let v = null; try { v = JSON.parse(localStorage.getItem(k)); } catch (_) { /* ignore */ }
      if (v && Array.isArray(v.list) && Date.now() - v.t <= UP_FRESH) continue;
      if (v && Array.isArray(v.list)) for (const j of v.list) if (j && j.name) dead.push(String(j.name));
      localStorage.removeItem(k);
    }
  } catch (_) { /* ignore */ }
  if (dead.length) localToast(`${dead.slice(0, 3).join(", ")}${dead.length > 3 ? " +" + (dead.length - 3) : ""} wasn't finished uploading because the app was closed. Open the chat and send it again.`, "error", 9000);
  const sig = JSON.stringify(foreignUploads().map(j => [j.key, j.id, Math.floor((j.pct || 0) * 100)]));
  if (sig !== lastForeign) { lastForeign = sig; try { window.dispatchEvent(new CustomEvent("qm-uploads")); } catch (_) { /* ignore */ } }
}
let lastForeign = "[]";
if (IN_APP && !nested) {
  setTimeout(sweepUploads, 2500); setInterval(sweepUploads, 3000);
  setInterval(() => { const a = activeUploads(); if (a.length) persistUploads(a); }, 5000);        // keeps the entry "fresh" while a long upload makes no visible progress
  addEventListener("pagehide", e => { if (!e.persisted) { try { localStorage.removeItem(UP_KEY + INST); } catch (_) { /* ignore */ } } });
}
const allUploads = () => {
  const m = new Map(upl);
  for (const j of foreignUploads()) m.set(j.chat, [...(m.get(j.chat) || []), { id: "bg-" + j.key + j.id, name: j.name, size: j.size, pct: j.pct, state: "sending" }]);
  return m;
};
function setUploads(chatId, list) {
  if (!chatId || !/^[\w-]{1,64}$/.test(chatId)) return;
  list = Array.isArray(list) ? list.slice(0, 50) : [];
  if (list.length) upl.set(chatId, list); else upl.delete(chatId);
  if (!list.length && parked.has(chatId)) { const f = parked.get(chatId); parked.delete(chatId); clearWatch(f); f.remove(); }
  uploadsChanged();
}
// Closing / reloading the tab: the browser asks; if you stay, a list of what is still uploading appears.
addEventListener("beforeunload", e => {
  if (nested || !activeUploads().length) return;
  e.preventDefault(); e.returnValue = "";
  setTimeout(showUploadsPopup, 300);       // only runs when the page stays open
});
function showUploadsPopup() {
  const act = activeUploads();
  if (!act.length) return;
  const box = document.createElement("div");
  box.className = "up-list";
  for (const j of act) {
    const row = document.createElement("div"); row.className = "up-row";
    const a = document.createElement("strong"); a.textContent = j.name;
    const b = document.createElement("span"); b.textContent = `${upTitle(j.chat)} · ${j.state === "waiting" ? "waiting for connection" : typeof j.pct === "number" ? Math.floor(j.pct * 100) + "%" : "uploading…"}`;
    row.append(a, b); box.append(row);
  }
  alertDialog({ title: "Uploads still in progress", message: "These files are still uploading. If you close this page they won't be sent.", node: box, okText: "Keep waiting" });
}

/** Make the screen match [view]. Only touches a frame when what it should show actually changes. */
function render(view) {
  const { detail } = els();
  const want = view.pane === "account" ? "account.html" : view.pane === "chat" && view.chat && /^[\w-]{1,64}$/.test(view.chat) ? chatUrl(view.chat) : null;
  st.chatId = want && view.pane === "chat" ? view.chat : null;
  st.pane = want ? view.pane : null;
  pluginHost.setContext({ chatId: st.chatId });
  const cur = detail.dataset.src || "";
  if (want !== cur && (want || cur)) {
    // A chat that is still uploading is not closed: its page is parked (hidden) so the upload and the final send carry on, and it comes back as it was.
    const curChat = chatOfSrc(cur), keep = !!curChat && upl.has(curChat) && !parked.has(curChat);
    const back = want && st.chatId ? parked.get(st.chatId) : null;
    if (back) {
      parked.delete(st.chatId);
      if (keep) park(detail, curChat); else { clearWatch(detail); detail.remove(); }
      back.id = "detailFrame"; back.hidden = false; back.classList.remove("parked"); back.dataset.src = want;
    } else if (want) {
      if (keep) parkFresh(detail, curChat, want); else { detail.dataset.src = want; navFrame(detail, want); }
    } else if (keep) parkFresh(detail, curChat, "about:blank");
    else { delete detail.dataset.src; navFrame(detail, "about:blank"); }
  }
  document.body.classList.toggle("has-detail", !!want);
  document.querySelectorAll(".chat-item").forEach(a => a.classList.toggle("active", a.dataset.chat === st.chatId));
  if (view.call && !st.call.visible && st.call.chatId) showCall();
  else if (!view.call && st.call.visible) hideCall();
}

/** Record [view] in history (push, or replace the current entry) and show it. */
function commit(view, replace = false) {
  const state = { qm: 1, d: replace ? depth : depth + 1, v: view };
  if (replace) history.replaceState(state, "", urlFor(view));
  else { depth++; history.pushState(state, "", urlFor(view)); }
  render(view);
}
const cur = () => ({ chat: st.pane === "chat" ? st.chatId : null, pane: st.pane, call: !!st.call.visible });

// ------------------------------------------------------------------ message protection
// A full-screen call notification can open the app over the lock screen. While the phone is still locked ("protected"), the
// call is the ONLY thing reachable: no other chats, no list, no account. Leaving the call closes the app, and every attempt
// to go "back" asks Android to unlock the device instead.
const prot = { on: false, since: 0 };
const protectedNow = () => prot.on && !!st.call.chatId;
function askUnlock() { try { window.QMApp?.requestUnlock?.(); } catch (_) { /* ignore */ } }
function pollProtect() {
  let on = false;
  try { on = !!window.QMApp?.isProtected?.(); } catch (_) { on = false; }
  if (on === prot.on) return;
  prot.on = on;
  if (on) { prot.since = Date.now(); if (st.call.joined && !st.call.visible) showCall(); }
  document.documentElement.classList.toggle("protected", on);
  for (const f of document.querySelectorAll("iframe")) { try { f.contentWindow.postMessage({ qm: "protect", on }, location.origin); } catch (_) { /* ignore */ } }
}
setInterval(pollProtect, 700);

window.addEventListener("popstate", e => {
  if (protectedNow()) {                       // Back/forward while locked: stay on the call, ask for the unlock
    history.pushState({ qm: 1, d: depth, v: { ...cur(), call: true } }, "", location.href);
    askUnlock();
    return;
  }
  const s = e.state;
  if (s && s.qm && s.v) { depth = s.d || 0; render(s.v); }
  else { depth = 0; render(viewFromUrl()); }
});

function openChat(chatId) {
  if (!chatId) return;
  if (protectedNow() && chatId !== st.call.chatId) { askUnlock(); return; }
  commit({ chat: chatId, pane: "chat", call: false }, st.pane !== null);
}
function openPane(name) { if (protectedNow()) { askUnlock(); return; } commit({ chat: null, pane: name, call: false }, st.pane !== null); }
function closeDetail() {
  if (protectedNow()) { askUnlock(); return; }
  if (history.state && history.state.v && history.state.v.pane && depth > 0 && !split.matches) history.back();
  else commit({ chat: null, pane: null, call: false }, true);
}
/** One "Back" for every source (browser button, Android button, on-screen arrows). Returns false when there is nothing to close. */
function androidBack() {
  if (protectedNow()) { askUnlock(); return true; }
  if (st.call.visible) { minimizeCall(); return true; }
  if (st.pane && !split.matches) { closeDetail(); return true; }
  return false;
}

// ------------------------------------------------------------------ call layer
function callWin() { try { return els().callFrame.contentWindow.__qmCall || null; } catch (_) { return null; } }

function showCall() {
  const { layer } = els();
  layer.hidden = false;
  layer.classList.remove("min");
  st.call.visible = true;
  renderBar();
}

async function openCall(chatId) {
  if (!chatId) return;
  const { callFrame } = els();
  if (st.call.joined && st.call.chatId !== chatId) {
    if (!(await confirmDialog({ title: "Already in a call", message: "You're already in a call. Leave it and join this one?", okText: "Leave and join" }))) return;
    await leaveCall(true);
  }
  // Only a different call (or none yet) loads the frame: opening the call you're already in never reloads it.
  if (callFrame.dataset.chat !== chatId) {
    callFrame.dataset.chat = chatId;
    st.call = { chatId, joined: false, visible: false, muted: false, canMic: true, startLocal: null, title: "" };
    navFrame(callFrame, callUrl(chatId));
  }
  hideIncoming();
  if (st.call.visible) return;
  commit({ chat: st.pane === "chat" ? st.chatId : null, pane: st.pane, call: true }, false);
}

function closeCallFrame() {
  const { layer, callFrame } = els();
  delete callFrame.dataset.chat;
  navFrame(callFrame, "about:blank");
  layer.hidden = true;
  layer.classList.remove("min");
  st.call = { chatId: null, joined: false, visible: false, muted: false, canMic: true, startLocal: null, title: "" };
  renderBar();
}

function hideCall() {
  const { layer } = els();
  if (!st.call.joined) { closeCallFrame(); return; }
  layer.classList.add("min");
  st.call.visible = false;
  renderBar();
}

/** Back arrow inside the call page: keep the call running and show the previous view. */
function minimizeCall() {
  if (protectedNow()) { askUnlock(); return; }
  if (history.state && history.state.v && history.state.v.call && depth > 0) history.back();
  else if (st.call.visible) commit({ ...cur(), call: false }, true);
}

/** The call page has hung up (after it left the room): back to that chat. */
function callEnded(chatId) {
  if (protectedNow()) {                       // hung up while locked: close the app instead of showing anything
    closeCallFrame();
    try { window.QMApp?.endProtectedCall?.(); } catch (_) { /* ignore */ }
    return;
  }
  closeCallFrame();
  const onCallEntry = !!(history.state && history.state.v && history.state.v.call);
  commit(chatId ? { chat: chatId, pane: "chat", call: false } : { chat: null, pane: null, call: false }, onCallEntry || st.pane !== null);
}

async function leaveCall(silent = false) {
  const w = callWin();
  if (w) { try { await w.leave(); } catch (_) { /* ignore */ } }
  if (silent) closeCallFrame();
}

function setCallState(patch) {
  Object.assign(st.call, patch);
  renderBar();
}

// ------------------------------------------------------------------ "in call" bar
function renderBar() {
  const { bar } = els();
  tellApp();
  try { pluginHost.setContext({ call: { ...st.call } }); } catch (_) { /* ignore */ }
  try { window.__qmIosCall && window.__qmIosCall(!!st.call.joined); } catch (_) { /* not the iPhone app */ }
  const show = st.call.joined && !st.call.visible;
  bar.hidden = !show;
  document.documentElement.classList.toggle("has-bar", show);
  document.documentElement.style.setProperty("--bar-h", show ? "calc(44px + var(--sat, 0px))" : "0px");
  clearInterval(timer);
  if (!show) return;
  bar.querySelector(".cbar-title").textContent = st.call.title || "In call";
  paintFaces(st.call.uids || []);
  const cam = bar.querySelector(".cbar-cam"), scr = bar.querySelector(".cbar-screen");
  cam.innerHTML = icon(st.call.camOn ? "camera" : "cameraOff", 18);
  cam.classList.toggle("off", !st.call.camOn);
  cam.disabled = !st.call.canCam;
  cam.title = st.call.camOn ? "Turn camera off" : "Turn camera on";
  scr.innerHTML = icon(st.call.screenOn ? "monitorOff" : "monitor", 18);
  scr.classList.toggle("on", !!st.call.screenOn);
  scr.disabled = !st.call.canScreen;
  scr.hidden = !st.call.canScreen;
  scr.title = st.call.screenOn ? "Stop sharing" : "Share your screen";
  const mic = bar.querySelector(".cbar-mic");
  mic.innerHTML = icon(st.call.muted ? "micOff" : "mic", 18);
  mic.classList.toggle("off", st.call.muted);
  mic.disabled = !st.call.canMic;
  mic.title = st.call.muted ? "Unmute" : "Mute";
  const tick = () => { bar.querySelector(".cbar-time").textContent = st.call.startLocal ? fmtDuration(Date.now() - st.call.startLocal) : ""; };
  tick();
  timer = setInterval(tick, 1000);
}

let facesKey = "";
async function paintFaces(uids) {
  const key = uids.join(",");
  if (key === facesKey) return;
  facesKey = key;
  const host = els().bar.querySelector(".cbar-faces");
  const profiles = await Promise.all(uids.filter(u => u !== uid).concat(uids.includes(uid) ? [uid] : []).slice(0, 4).map(getProfile));
  if (key !== facesKey) return;
  host.replaceChildren(...profiles.map(p => avatarEl(p.displayName, p.pfp, "avatar xs")));
}

function wire() {
  const { bar } = els();
  bar.innerHTML = `<span class="cbar-faces"></span><button type="button" class="cbar-main"><strong class="cbar-title"></strong><span class="cbar-time"></span></button>
    <button type="button" class="cbar-btn cbar-mic" aria-label="Mute"></button>
    <button type="button" class="cbar-btn cbar-cam" aria-label="Camera"></button>
    <button type="button" class="cbar-btn cbar-screen" aria-label="Share screen"></button>
    <button type="button" class="cbar-btn cbar-return">Return to call</button>
    <button type="button" class="cbar-btn cbar-leave" aria-label="Leave call"></button>`;
  bar.querySelector(".cbar-leave").innerHTML = icon("phoneOff", 18);
  const back = () => openCall(st.call.chatId);
  bar.querySelector(".cbar-main").onclick = back;
  bar.querySelector(".cbar-return").onclick = back;
  bar.querySelector(".cbar-mic").onclick = () => callWin()?.toggleMute();
  bar.querySelector(".cbar-cam").onclick = () => callWin()?.toggleCam();
  bar.querySelector(".cbar-screen").onclick = () => callWin()?.toggleScreen();
  bar.querySelector(".cbar-leave").onclick = () => leaveCall();

  const syncSplit = () => document.body.classList.toggle("split", split.matches);
  split.addEventListener("change", syncSplit);
  syncSplit();

  // Notification clicks while the app is already open: switch inside the shell instead of reloading it.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", e => {
      if (!e.data || e.data.qm !== "open") return;
      try {
        const u = new URL(e.data.link, location.href);
        const id = u.searchParams.get("chatId") || u.searchParams.get("chat");
        if (!id) return;
        openChat(id);
        if (u.pathname.endsWith("call.html") || u.searchParams.has("session")) openCall(id);
      } catch (_) { /* ignore */ }
    });
  }
}

// ------------------------------------------------------------------ public API
export const QM = (window.QM = {
  declined: (chatId, by) => { try { els().callFrame.contentWindow.__qmDeclined?.(chatId, by); } catch (_) { /* ignore */ } },
  plugins: pluginHost,
  setUploads, uploads: allUploads, foreignUploads, activeUploads, showUploadsPopup,
  openChat, openPane, closeDetail, androidBack, openCall, minimizeCall, callEnded, setCallState, frameReady, frameEscaped, frameFatal, frameFailed,
  isSplit: () => split.matches,
  toggleMute: () => callWin()?.toggleMute(), toggleDeafen: () => callWin()?.toggleDeafen(), toggleScreen: () => callWin()?.toggleScreen(), hangup: () => leaveCall(),
  protect: { active: () => prot.on, since: () => st.call.joinedAt || st.call.startLocal || prot.since, unlock: askUnlock },
  debugWatch: () => [...watch.values()].map(w => w.url + ":" + w.tries),
  get state() { return st; }
});

// If the call page disappears while we think we're in a call (it navigated away, crashed, was unloaded), put it back; the
// call page joins by itself on load, so this is a seamless reconnect instead of a silent drop.
let misses = 0, recoveries = [], joinedSeen = 0;
setInterval(() => {
  if (!st.call.joined) { misses = 0; joinedSeen = 0; return; }
  if (!joinedSeen) joinedSeen = Date.now();
  if (Date.now() - joinedSeen < 10000) return;      // a fresh (re)join is still loading: never "recover" it mid-load
  const { callFrame } = els();
  let healthy = false;
  try { healthy = !!(callFrame.contentWindow.__qmCall && callFrame.contentWindow.location.pathname.endsWith("call.html")); } catch (_) { healthy = false; }
  if (healthy) { misses = 0; return; }
  if (++misses < 3) return;
  misses = 0;
  const now = Date.now();
  recoveries = recoveries.filter(t => now - t < 120000);
  if (recoveries.length >= 3) { showFrameError(callFrame, true); return; }   // stop looping; the user can press Try again
  recoveries.push(now);
  localToast("Call connection lost — reconnecting…", "info", 3500);
  st.call.joined = false;
  navFrame(callFrame, callUrl(st.call.chatId));
}, 3000);

// tell the app whether a call is up (keeps camera/mic alive in the background, allows picture-in-picture)
let lastAppCall = "";
function tellApp() {
  try {
    if (!window.QMApp || !window.QMApp.setInCall) return;
    const key = st.call.joined + "/" + st.call.visible;
    if (st.call.joined && !st.call.joinedAt) st.call.joinedAt = Date.now();
    if (key !== lastAppCall) { lastAppCall = key; window.QMApp.setInCall(!!st.call.joined, !!st.call.visible); }
    if (st.call.joined) window.QMApp.setCallWho?.(String(st.call.who || ""));
    if (st.call.joined) window.QMApp.setCallInfo?.(String(st.call.title || ""), !!st.call.muted, !!st.call.screenOn, !!st.call.canScreen, String(st.call.photo || ""), Number(st.call.startLocal || 0));
  } catch (_) { /* ignore */ }
}

// ---- any frame that unexpectedly shows about:blank (history traversal, a crashed page, a stray navigation) is put back.
// The chat/account pane just reloads. The call frame is restored too (its page rejoins by itself), but only when it really
// is blank: a call that is alive is never touched.
setInterval(() => {
  const { detail, callFrame } = els();
  const blank = f => { try { const h = f.contentWindow.location.href; return h === "about:blank" || h === ""; } catch (_) { return false; } };
  const want = detail.dataset.src;
  if (want && blank(detail) && !watch.has(detail)) { console.warn("[shell] detail frame went blank; reloading"); navFrame(detail, want); }
  if (st.call.chatId && callFrame.dataset.chat && blank(callFrame) && !watch.has(callFrame)) {
    console.warn("[shell] call frame went blank; restoring");
    st.call.joined = false; navFrame(callFrame, callUrl(st.call.chatId));
  }
}, 1500);

let wired = false;
export function initShell(userId) {
  if (nested) return;
  uid = userId;
  getProfile(userId).then(p => pluginHost.setContext({ uid: userId, name: p.displayName || "" })).catch(() => {});
  if (!wired) { wired = true; wire(); watchSiteVersion(); if (!window.QMApp) watchSavedCopy(SITE_VERSION); }
  { const v = viewFromUrl(); depth = 0; history.replaceState({ qm: 1, d: 0, v }, "", location.href); render(v); }
  const q = new URLSearchParams(location.search);
  // A call link / notification carries a one-shot timestamp. It must be fresh AND come from a real navigation, so
  // reloading, restoring a tab or pressing Back can never start (or restart) a call by itself.
  const token = Number(q.get("call"));
  if (q.has("call")) {
    q.delete("call");
    const next = location.pathname + (q.toString() ? "?" + q : "");
    history.replaceState({ qm: 1, d: 0, v: viewFromUrl() }, "", next);
    let navType = "navigate";
    try { navType = performance.getEntriesByType("navigation")[0]?.type || "navigate"; } catch (_) { /* ignore */ }
    if (st.chatId && token > 1 && Date.now() - token < 20000 && navType === "navigate") openCall(st.chatId);
  }
  stopDeclines?.(); stopDeclines = watchDeclines(uid);
  stopRings?.();
  stopRings = watchIncomingCalls({
    uid,
    onAnswer: chatId => { try { window.QMApp && window.QMApp.bringToFront && window.QMApp.bringToFront(); } catch (_) {} setTimeout(() => { openChat(chatId); openCall(chatId); }, 250); },
    inCall: chatId => st.call.chatId === chatId
  });
}

export function resetShell() {
  uid = null;
  stopRings?.(); stopRings = null;
  stopDeclines?.(); stopDeclines = null;
  for (const f of parked.values()) { clearWatch(f); f.remove(); }
  parked.clear(); upl.clear(); uploadsChanged();
  if (wired) { closeCallFrame(); commit({ chat: null, pane: null, call: false }, true); }
}

// Images pasted from the Android keyboard arrive in the top window; hand them to the chat that has the cursor (it may be nested
// inside the call page).
window.__qmPasteImage = (mime, b64, name) => {
  const found = [];
  const walk = w => {
    try { if (w !== window && typeof w.__qmPasteImage === "function") found.push(w); } catch (_) { /* cross-origin */ }
    try { for (let i = 0; i < w.frames.length; i++) walk(w.frames[i]); } catch (_) { /* ignore */ }
  };
  walk(window);
  const focused = found.find(w => { try { return w.document.activeElement?.id === "msgInput"; } catch (_) { return false; } });
  const target = focused || found.find(w => { try { return w.frameElement && !w.frameElement.closest("[hidden]"); } catch (_) { return false; } }) || found[0];
  try { target?.__qmPasteImage(mime, b64, name); } catch (_) { /* ignore */ }
};
