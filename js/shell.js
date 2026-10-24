// App shell (index.html): chat list on the left; the open chat/account page in an <iframe> on the right (desktop) or
// full-screen over the list (mobile); and ONE persistent call <iframe> that survives switching chats, with a
// Discord-style "in call" bar while the call is minimised. Embedded pages reach this through `parent.QM` (see embed.js).
import { watchIncomingCalls, hideIncoming } from "./incoming.js";
import { fmtDuration } from "./call-banner.js";
import { icon, avatarEl, localToast, confirmDialog } from "./ui.js";

window.__qmToast = localToast;       // embedded pages route their toasts here (see ui.js toast)
import { getProfile } from "./users.js";
import { watchDeclines } from "./declines.js";
import "./ios-notify.js";     // iPhone app: defines window.__qmIosCall (pauses the background-keepalive during calls)
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
  if (w.tries >= MAX_TRIES) { showFrameError(frame, true); return; }
  w.tries++;
  const url = w.base + (w.base.includes("?") ? "&" : "?") + "_r=" + Date.now();
  const keep = w.tries;
  const nf = navFrame(frame, url, true);
  const nw = watch.get(nf); if (nw) nw.tries = keep;
}
function frameReady(frame) { if (frame && watch.has(frame)) clearWatch(frame); }
function showFrameError(frame, on) {
  const host = frame && frame.parentElement;
  if (!host) return;
  let box = host.querySelector(":scope > .frame-err[data-for='" + frame.id + "']");
  if (!on) { box?.remove(); return; }
  if (box) return;
  box = document.createElement("div");
  box.className = "frame-err"; box.dataset.for = frame.id;
  box.innerHTML = `<div><strong>This page didn't load.</strong><p>Check your connection and try again.</p><button type="button" class="btn primary">Try again</button></div>`;
  box.querySelector("button").onclick = () => { box.remove(); const cf = document.getElementById(frame.id) || frame; const w = watch.get(cf); const base = w ? w.base : cf.dataset.src || cf.src; if (w) w.tries = 0; navFrame(cf, base, false); };
  host.append(box);
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

/** Make the screen match [view]. Only touches a frame when what it should show actually changes. */
function render(view) {
  const { detail } = els();
  const want = view.pane === "account" ? "account.html" : view.pane === "chat" && view.chat && /^[\w-]{1,64}$/.test(view.chat) ? chatUrl(view.chat) : null;
  st.chatId = want && view.pane === "chat" ? view.chat : null;
  st.pane = want ? view.pane : null;
  const cur = detail.dataset.src || "";
  if (want && cur !== want) { detail.dataset.src = want; navFrame(detail, want); }
  if (!want && cur) { delete detail.dataset.src; navFrame(detail, "about:blank"); }
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
  openChat, openPane, closeDetail, androidBack, openCall, minimizeCall, callEnded, setCallState, frameReady, frameEscaped,
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
  if (!wired) { wired = true; wire(); }
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
