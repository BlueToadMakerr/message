import { nativeGoogleSignIn } from "./native.js";
import "./update.js";                      // apps: "update available" bar
import { iosApp, iosState, onIosState, iosSetEnabled, iosStatus, iosShow } from "./ios-notify.js";
import { app, auth, db, VAPID_KEY } from "./firebase.js";
import {
  onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signInWithPopup, signInWithCredential, GoogleAuthProvider, sendPasswordResetEmail
} from "./sdk.js";
import {
  ref, push, set, get, update, remove, onChildAdded, onChildRemoved, onValue
} from "./sdk.js";
import { PRIVATE } from "./mode.js";
// Firebase Cloud Messaging is loaded only when it is used (and never in private-server mode, which has no Google services).
let fmP = null;
const fm = () => fmP ||= PRIVATE ? Promise.reject(new Error("no FCM")) : import("https://www.gstatic.com/firebasejs/11.0.1/firebase-messaging.js");
const isSupported = () => fm().then(m => m.isSupported()).catch(() => false);
const getMessaging = async a => (await fm()).getMessaging(a);
const getToken = async (...a) => (await fm()).getToken(...a);
const deleteToken = async (...a) => (await fm()).deleteToken(...a);
const onMessage = (m, cb) => { fm().then(x => x.onMessage(m, cb)).catch(() => {}); return () => {}; };
import {
  toast, avatarEl, icon, hydrateIcons, formatListTime, authErrorMessage, wireDialog, promptDialog, confirmDialog
} from "./ui.js";
import { getProfile, ensureProfile, profileExists } from "./users.js";
import { applyTheme } from "./theme.js";
import { QM, initShell, resetShell } from "./shell.js";
import { maybeShowTour } from "./onboarding.js";
import * as E2E from "./crypto.js";
import { devButton, showDev, envInfo, devCard, devGrid, devPill, devWho } from "./dev.js";
import { activeDbUrl } from "./dburl.js";
import { DEFAULT_DB_URL, customDbUrl, cleanDbUrl, setDbUrl } from "./dburl.js";
import { openPreview } from "./msgcrypto.js";
import { requireVerified, isVerified, refreshVerified, resendVerification, watchVerified } from "./verify.js";
import { resolveRecipient } from "./recipient.js";

window.__qmBooted = true;      // js/legacy.js: the app's scripts did start
hydrateIcons();

// ---------- elements ----------
const $ = id => document.getElementById(id);
const loadingEl = $("loading"), authEl = $("auth"), appEl = $("app");
const chatListEl = $("chatList"), topActions = $("topActions"), accountLink = $("accountLink");
const newChatBtn = $("newChatBtn"), toggleNotifBtn = $("toggleNotifBtn");
const emailInput = $("email"), passwordInput = $("password");

// ---------- service worker ----------
let swReady = null;
if ("serviceWorker" in navigator) {
  swReady = navigator.serviceWorker.register("firebase-messaging-sw.js").catch(err => {
    console.error("SW registration failed", err);
    return null;
  });
}

// ---------- Android app download (Android browsers only, never inside the app itself) ----------
// ---------- Download menu (web app / Android app / iPhone app / download page) ----------
import("./dl-menu.js").catch(() => {});

// ---------- auth ----------
// App: Google sign-in happens in the browser and comes back as an ID token (see app-login.html / js/app-login.js).
window.__qmGoogleSignIn = async (idToken, err) => {
  if (window.__qmGoogleLink) { const f = window.__qmGoogleLink; window.__qmGoogleLink = null; return f(idToken, err); }   // Account → "Link Google" in the app
  if (!idToken) { toast(err ? "Google sign-in didn't finish." : "Google sign-in was cancelled.", "error"); return; }
  try { await signInWithCredential(auth, GoogleAuthProvider.credential(idToken)); }
  catch (e) { const m = authErrorMessage(e); toast(m || "Couldn't sign in with Google.", "error"); }
};
$("googleBtn").onclick = async () => {
  if (nativeGoogleSignIn()) return;
  try { await signInWithPopup(auth, new GoogleAuthProvider()); }
  catch (err) { const m = authErrorMessage(err); if (m) toast(m, "error"); }
};

$("authForm").addEventListener("submit", async e => {
  e.preventDefault();
  const btn = $("loginBtn");
  btn.disabled = true;
  try { await signInWithEmailAndPassword(auth, emailInput.value.trim(), passwordInput.value); }
  catch (err) { const m = authErrorMessage(err); if (m) toast(m, "error"); }
  finally { btn.disabled = false; }
});

$("signupBtn").onclick = async () => {
  const btn = $("signupBtn");
  btn.disabled = true;
  try {
    const cred = await createUserWithEmailAndPassword(auth, emailInput.value.trim(), passwordInput.value);
    resendVerification().then(() => toast("We sent a verification link to your email.", "success", 5000)).catch(() => {});
  }
  catch (err) { const m = authErrorMessage(err); if (m) toast(m, "error"); }
  finally { btn.disabled = false; }
};

// "Advanced": use another Firebase database (stored on this device; the page reloads to connect to it)
{
  const inp = $("dbUrl"), msg = $("dbMsg");
  inp.value = customDbUrl() || DEFAULT_DB_URL;
  if (customDbUrl()) $("dbOpt").open = true;
  $("dbSave").onclick = () => {
    const c = cleanDbUrl(inp.value);
    if (!c) { msg.textContent = "That doesn't look like a Firebase database URL (https://….firebaseio.com or https://….firebasedatabase.app)."; return; }
    setDbUrl(c); msg.textContent = "Saved. Reloading…"; setTimeout(() => location.reload(), 300);
  };
  $("dbReset").onclick = () => { setDbUrl(""); msg.textContent = "Back to the default database. Reloading…"; setTimeout(() => location.reload(), 300); };
}
$("forgotBtn").onclick = async () => {
  let email = emailInput.value.trim();
  if (!email) {
    email = (await promptDialog({
      title: "Reset password", message: "We'll email you a reset link.",
      input: { type: "email", placeholder: "you@example.com" }, okText: "Send link"
    }) || "").trim();
  }
  if (!email) return;
  try {
    await sendPasswordResetEmail(auth, email);
    toast("If that account exists, a reset email is on its way.", "success");
  } catch (err) {
    const m = authErrorMessage(err); if (m) toast(m, "error");
  }
};

// ---------- chat list state ----------
const chats = new Map();      // chatId -> state
let globalUnsubs = [];
let currentUid = null;
let renderQueued = false, settleOverride = false;

function schedule() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderList(); });
}

function teardown() {
  listTimers.forEach(clearTimeout); listTimers = [];
  globalUnsubs.forEach(fn => { try { fn(); } catch { /* ignore */ } });
  globalUnsubs = [];
  chats.forEach(s => s.off.forEach(fn => { try { fn(); } catch { /* ignore */ } }));
  chats.clear();
  chatListEl.replaceChildren();
}

// "loading" → "slow" (a few seconds in) → "ready", or "error" when the list can't be fetched; the empty state only shows once the
// list really arrived and is empty.
let listState = "loading", listTimers = [], listErr = "";
function loadChats(uid) {
  const listRef = ref(db, `chatList/${uid}`);
  listTimers.forEach(clearTimeout); listTimers = [];
  listState = "loading"; listErr = "";
  const fail = err => { if (listState === "ready") return; listState = "error"; listErr = navigator.onLine === false || /offline/i.test(String(err && err.message)) ? "offline" : "failed"; schedule(); };
  listTimers.push(setTimeout(() => { if (listState === "loading") { listState = "slow"; schedule(); } }, 5000));
  listTimers.push(setTimeout(() => { if (listState === "loading" || listState === "slow") fail(new Error("timeout")); }, 20000));
  listTimers.push(setTimeout(() => { settleOverride = true; schedule(); }, 25000));
  // the listener first: the get() that follows is then answered from what the listener already downloaded (one download, not two)
  globalUnsubs.push(onChildAdded(listRef, snap => attachChat(uid, snap.key), fail));
  globalUnsubs.push(onChildRemoved(listRef, snap => detachChat(snap.key)));
  get(listRef).then(() => { listState = "ready"; schedule(); }, fail);
}

async function attachChat(uid, chatId) {
  if (chats.has(chatId)) return;
  const s = {
    id: chatId, participants: null, otherUids: [], otherNames: [], otherProfiles: [],
    customName: "", customPhoto: "", settled: false, last: null, lastSender: "", readKey: null, typing: [], off: []
  };
  chats.set(chatId, s);

  let participants = null;
  try {
    participants = (await get(ref(db, `privateChats/${chatId}/participants`))).val();
  } catch { /* treat as inaccessible */ }
  if (chats.get(chatId) !== s) return; // detached while loading

  if (!participants || !participants[uid]) {
    detachChat(chatId);
    remove(ref(db, `chatList/${uid}/${chatId}`)).catch(() => {});
    return;
  }
  s.participants = Object.keys(participants);
  s.otherUids = s.participants.filter(u => u !== uid);
  Promise.all(s.otherUids.map(getProfile)).then(ps => {
    s.otherProfiles = ps;
    s.otherNames = ps.map(p => p.displayName);
    schedule();
  });

  const listen = (path, cb) => s.off.push(onValue(ref(db, path), cb, () => {}));
  // name, photo and encryption flag are one listener on chatData (three listeners used to ask the server three times)
  listen(`privateChats/${chatId}/chatData`, snap => {
    const d = snap.val() || {};
    s.customPhoto = d.photo || ""; s.customName = d.name || "";
    const on = d.encrypted === true;
    if (on && !s.keysChecked && E2E.ready()) { s.keysChecked = true; E2E.ensureMemberKeys(chatId, s.participants || []).catch(() => {}); }
    s.encrypted = on; checkKey(s);
    schedule();
  });
  listen(`privateChats/${chatId}/keys`, snap => { s.keys = snap.val() || null; checkKey(s); });
  listen(`privateChats/${chatId}/lastMessage`, snap => {
    s.settled = true;
    if (!snap.exists()) {
      detachChat(chatId);
      remove(ref(db, `chatList/${uid}/${chatId}`)).catch(() => {});
      return;
    }
    const prev = s.last;
    s.last = snap.val();
    if (prev && prev.id !== s.last.id && s.last.fromUid && s.last.fromUid !== uid && document.visibilityState !== "visible") notifyIos(s, s.last);   // iPhone app, in the background
    if (s.last.enc) { s.lastText = "🔒 Encrypted message"; openPreview(chatId, s.last).then(t => { s.lastText = t; schedule(); }); }
    else s.lastText = s.last.text || "";
    if (s.last.fromUid) {
      if (s.last.fromUid === uid) { s.lastSender = "You"; schedule(); }
      else getProfile(s.last.fromUid).then(p => { s.lastSender = p.displayName; schedule(); });
    } else { s.lastSender = ""; }
    schedule();
  });
  listen(`privateChats/${chatId}/messageRead/${uid}`, snap => { s.readKey = snap.val(); schedule(); });
  listen(`privateChats/${chatId}/typing`, snap => {
    const v = snap.val() || {};
    s.typing = Object.keys(v).filter(k => k !== uid && v[k]);
    schedule();
  });
}

/** iPhone app: a message arrived while the app is in the background → local notification (see js/ios-notify.js). */
async function notifyIos(s, last) {
  if (!iosApp() || !iosState().enabled) return;
  const text = last.enc ? await openPreview(s.id, last).catch(() => "🔒 Encrypted message") : (last.text || "");
  const p = await getProfile(last.fromUid).catch(() => null);
  iosShow({ id: s.id + ":" + (last.id || last.timestamp), chatId: s.id, title: (p && p.displayName) || "New message", body: text || "New message" });
}

/** Does this device hold the key of an encrypted chat? Chats without one get a small "No key" tag in the list. */
async function checkKey(s) {
  const should = !!(s.encrypted || s.keys);
  let nokey = false;
  if (should && s.keys) { nokey = !s.keys[currentUid] || !E2E.ready() || !(await E2E.getChatKey(s.id).catch(() => null)); }
  else if (should && s.encrypted) nokey = true;
  if (nokey !== !!s.noKey) { s.noKey = nokey; schedule(); }
}
E2E.onIdentity(() => { for (const s of chats.values()) checkKey(s); });

function detachChat(chatId) {
  const s = chats.get(chatId);
  if (!s) return;
  s.off.forEach(fn => { try { fn(); } catch { /* ignore */ } });
  chats.delete(chatId);
  schedule();
}

let dupIndex = new Map();     // chat id -> 2, 3, … when several unnamed chats have exactly the same people
function chatTitle(s) {
  const base = s.customName.trim() || s.otherNames.join(", ") || "Chat";
  return !s.customName.trim() && dupIndex.has(s.id) ? `${base} (${dupIndex.get(s.id)})` : base;
}
function indexDuplicates() {
  const groups = new Map();
  for (const c of chats.values()) {
    if (!c.participants || c.customName.trim()) continue;
    const k = [...c.participants].sort().join("|");
    (groups.get(k) || groups.set(k, []).get(k)).push(c.id);
  }
  dupIndex = new Map();
  for (const ids of groups.values()) if (ids.length > 1) ids.sort().forEach((id, i) => { if (i) dupIndex.set(id, i + 1); });
}

function renderList() {
  indexDuplicates();
  const items = [...chats.values()]
    .filter(s => s.participants && s.last)
    .sort((a, b) => (b.last.timestamp || 0) - (a.last.timestamp || 0));

  chatListEl.replaceChildren();
  const unsettled = !settleOverride && [...chats.values()].some(c => !c.settled);
  if (!items.length && (listState === "loading" || listState === "slow" || (listState === "ready" && unsettled))) {
    const box = document.createElement("div");
    box.className = "empty list-loading";
    box.setAttribute("role", "status");
    box.innerHTML = `<div class="big"><span class="spinner"></span></div><strong>Loading your chats…</strong>${listState === "slow" ? "<p>This is taking longer than usual. Your connection may be slow.</p>" : ""}`;
    chatListEl.append(box);
    return;
  }
  if (!items.length && listState === "error") {
    const box = document.createElement("div");
    box.className = "empty";
    box.innerHTML = `<div class="big">${icon("chat", 30)}</div><strong>${listErr === "offline" ? "You're offline" : "Couldn't load your chats"}</strong><p>${listErr === "offline" ? "Connect to the internet and try again." : "There was a problem reaching the server. Check your connection and try again."}</p><button type="button" class="btn primary" id="retryChats">Try again</button>`;
    chatListEl.append(box);
    box.querySelector("#retryChats").onclick = () => { const u = currentUid; if (!u) return; teardown(); settleOverride = false; loadChats(u); };
    return;
  }
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.innerHTML = `<div class="big">${icon("chat", 30)}</div><strong>No chats yet</strong><p>Tap “New chat” and paste a friend's UID to say hello.</p>`;
    chatListEl.append(empty);
    return;
  }

  for (const s of items) {
    const unread = !!(s.last.fromUid && s.last.fromUid !== currentUid && s.last.id &&
      String(s.readKey) !== String(s.last.id));

    const a = document.createElement("a");
    a.className = "chat-item" + (unread ? " unread" : "");
    a.href = `message.html?chatId=${encodeURIComponent(s.id)}`;
    a.dataset.chat = s.id;
    if (QM.state.chatId === s.id) a.classList.add("active");
    a.addEventListener("click", e => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      e.preventDefault();
      QM.openChat(s.id);
    });

    const title = chatTitle(s);
    const useOther = !s.customName.trim() && s.otherProfiles.length === 1;
    a.append(avatarEl(title, s.customPhoto || (useOther ? s.otherProfiles[0].pfp : ""), "avatar"));

    const body = document.createElement("div");
    body.className = "body";

    const head = document.createElement("div");
    head.className = "head";
    const t = document.createElement("span");
    t.className = "chat-title";
    t.textContent = title;
    const time = document.createElement("span");
    time.className = "chat-time";
    time.textContent = formatListTime(s.last.timestamp);
    if (s.noKey) { const nk = document.createElement("span"); nk.className = "nokey"; nk.textContent = "🔑 No key"; nk.title = "This device doesn't have this chat's encryption key. It arrives when another member opens the chat, or restore your recovery code."; head.append(t, nk, time); }
    else head.append(t, time);

    const prev = document.createElement("div");
    prev.className = "chat-preview";
    const txt = document.createElement("span");
    txt.className = "txt";
    if (s.typing.length) {
      txt.classList.add("typing-text");
      txt.textContent = s.typing.length === 1 ? "typing…" : `${s.typing.length} people typing…`;
    } else {
      const text = s.lastText ?? (s.last.text || "");
      txt.textContent = (s.lastSender ? `${s.lastSender}: ` : "") + text;
    }
    prev.append(txt);
    if (unread) {
      const dot = document.createElement("span");
      dot.className = "unread-dot";
      dot.title = "Unread";
      prev.append(dot);
    }

    body.append(head, prev);
    a.append(body);
    chatListEl.append(a);
  }
  paintUploadBadges();
}

// A small spinner on every chat that has an attachment uploading (red "!" when one failed; open the chat to retry).
function paintUploadBadges() {
  let up = null;
  try { up = window.QM && QM.uploads && QM.uploads(); } catch (_) { up = null; }
  for (const a of chatListEl.querySelectorAll(".chat-item")) {
    const list = up && up.get(a.dataset.chat), old = a.querySelector(".chat-up");
    if (!list || !list.length) { old && old.remove(); continue; }
    const failed = list.every(j => j.state === "error");
    const n = list.length;
    const b = old || document.createElement("span");
    b.className = "chat-up" + (failed ? " err" : "");
    b.textContent = failed ? "Upload failed" : n > 1 ? `Uploading ${n}` : "Uploading";
    b.title = list.map(j => j.name).join("\n");
    if (!old) a.querySelector(".chat-preview")?.prepend(b);
  }
}
window.addEventListener("qm-uploads", paintUploadBadges);

// ---------- start a new chat ----------
const ncDialog = $("newChatDialog"), ncForm = $("newChatForm");
const ncInput = $("toUid"), ncPreview = $("ncPreview"), ncError = $("ncError"), ncGo = $("ncGo");
let ncTarget = null;
wireDialog(ncDialog);

function resetNewChat() {
  ncTarget = null;
  ncInput.value = "";
  ncInput.disabled = false;
  ncPreview.classList.add("hidden");
  ncError.classList.add("hidden");
  ncGo.textContent = "Continue";
  ncGo.disabled = false;
}

newChatBtn.onclick = () => { resetNewChat(); ncDialog.showModal(); ncInput.focus(); };
$("ncClose").onclick = $("ncCancel").onclick = () => ncDialog.close();
ncInput.addEventListener("input", () => {
  if (ncTarget) { ncTarget = null; ncPreview.classList.add("hidden"); ncGo.textContent = "Continue"; }
  ncError.classList.add("hidden");
});

ncForm.addEventListener("submit", async e => {
  e.preventDefault();
  const uid = auth.currentUser?.uid;
  if (!uid) return;

  if (!ncTarget) {
    const fail = msg => { ncError.textContent = msg; ncError.classList.remove("hidden"); };
    if (!ncInput.value.trim()) return fail("Enter a UID or an email address.");
    if (!requireVerified("start chats")) return;

    ncGo.disabled = true;
    try {
      let other;
      try { other = await resolveRecipient(ncInput.value); } catch (e) { fail(e.message); return; }
      if (other === uid) { fail("You can't chat with yourself."); return; }
      if (!(await profileExists(other))) { fail("No user found."); return; }
      const p = await getProfile(other);
      ncPreview.replaceChildren(avatarEl(p.displayName, p.pfp, "avatar"));
      const n = document.createElement("div");
      n.innerHTML = `<div class="name"></div><div class="hint">Start a conversation?</div>`;
      n.querySelector(".name").textContent = p.displayName;
      ncPreview.append(n);
      ncPreview.classList.remove("hidden");
      ncTarget = other;
      ncGo.textContent = "Start chat";
    } catch (err) {
      fail("Couldn't look that user up: " + (err.message || err));
    } finally { ncGo.disabled = false; }
    return;
  }

  // Reuse an existing 1:1 chat instead of creating duplicates
  // (more than one chat between the same two people is fine: that is also how group chats start. Ask which one is meant.)
  const existing = [...chats.values()].filter(s => s.participants && s.participants.length === 2 && s.participants.includes(ncTarget))
    .sort((a, b) => (b.last?.timestamp || 0) - (a.last?.timestamp || 0))[0];
  if (existing) {
    const again = await confirmDialog({
      title: "You already have a chat with them",
      message: "Open that chat, or start a separate new one? Two people can have as many chats as they like (for example one you'll later add friends to).",
      okText: "New chat", cancelText: "Open existing chat"
    });
    if (!again) { ncDialog.close?.(); QM.openChat(existing.id); return; }
  }

  ncGo.disabled = true;
  try {
    const newRef = push(ref(db, "privateChats"));
    const chatId = newRef.key;
    const chat = {
      participants: { [uid]: true, [ncTarget]: true },
      lastMessage: { fromUid: "", text: "(No messages yet)", timestamp: Date.now() }
    };
    // New chats start unencrypted (so notifications and previews work everywhere); encryption is a switch in the chat's options.
    await set(newRef, chat);
    await update(ref(db), {
      [`chatList/${uid}/${chatId}`]: true,
      [`chatList/${ncTarget}/${chatId}`]: true
    });
    ncDialog.close?.();
    QM.openChat(chatId);
  } catch (err) {
    ncGo.disabled = false;
    ncError.textContent = "Couldn't create the chat: " + (err.message || err);
    ncError.classList.remove("hidden");
  }
});

// ---------- notifications ----------
let messagingPromise = null;
function getMsg() {
  if (!messagingPromise) {
    messagingPromise = isSupported().then(ok => ok ? getMessaging(app) : null).catch(() => null);
  }
  return messagingPromise;
}

async function setupNotifications(uid) {
  const btn = toggleNotifBtn;
  // Android app: a WebView has no web push, so the app itself watches for messages/calls and shows the notifications.
  if (window.QMApp && window.QMApp.notifyEnabled) {
    btn.classList.remove("hidden");
    // "On" is only claimed when Android actually allows notifications; otherwise the bell turns red and opens the settings.
    const allowed = () => !window.QMApp.canNotify || window.QMApp.canNotify();
    const paint = () => {
      const on = window.QMApp.notifyEnabled(), blocked = on && !allowed();
      btn.innerHTML = icon(on && !blocked ? "bell" : "bellOff", 20);
      btn.title = blocked ? "Notification permissions are off" : on ? "Disable notifications" : "Enable notifications";
      btn.setAttribute("aria-label", btn.title);
      btn.classList.toggle("active", on && !blocked);
      btn.classList.toggle("notif-blocked", blocked);
      btn.disabled = false;
    };
    paint();
    setInterval(paint, 2000);
    document.addEventListener("visibilitychange", paint);
    btn.onclick = () => {
      const on = window.QMApp.notifyEnabled();
      if (on && !allowed()) {
        toast("Notification permissions are off. Opening Android settings…", "error", 4000);
        if (window.QMApp.openNotificationSettings) window.QMApp.openNotificationSettings();
        return;
      }
      window.QMApp.setNotify(!on);
      paint();
      toast(!on ? "Notifications enabled in the app." : "Notifications disabled in the app.", !on ? "success" : "info");
    };
    return;
  }
  // iPhone / iPad app: local notifications while the app runs in the background (the page can't get web push inside an app).
  if (iosApp()) {
    btn.classList.remove("hidden");
    const paint = () => {
      const st = iosState(), on = st.enabled && st.allowed, blocked = st.enabled && !st.allowed;
      btn.innerHTML = icon(on ? "bell" : "bellOff", 20);
      btn.title = blocked ? "Notifications are off in iPhone Settings" : on ? "Disable notifications" : "Enable notifications";
      btn.setAttribute("aria-label", btn.title);
      btn.classList.toggle("active", on); btn.classList.toggle("notif-blocked", blocked); btn.disabled = false;
    };
    onIosState(paint); paint(); iosStatus();
    btn.onclick = () => {
      const st = iosState();
      if (st.enabled && !st.allowed) { toast("Turn notifications on in iPhone Settings → QuickMessage → Notifications.", "error", 6000); return; }
      iosSetEnabled(!st.enabled);
      if (!st.enabled) toast("Notifications on. They work while QuickMessage is open in the background (it keeps itself awake, which uses some battery). If you close the app they stop.", "success", 9000);
    };
    return;
  }
  if (PRIVATE) { btn.classList.remove("hidden"); return setupLocalNotifications(btn); }
  const messaging = await getMsg();
  btn.classList.remove("hidden");

  const setState = (label, ico, active, disabled = false) => {
    btn.innerHTML = icon(ico, 20);
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.classList.toggle("active", active);
    btn.disabled = disabled;
  };

  if (!messaging || !("Notification" in window) || !("serviceWorker" in navigator)) {
    const iphone = /iP(hone|ad|od)/.test(navigator.userAgent) && !navigator.standalone;
    setState(iphone ? "On iPhone: Share → Add to Home Screen, then open QuickMessage from the Home Screen to enable notifications" : "Notifications aren't supported in this browser", "bellOff", false, true);
    return;
  }
  if (Notification.permission === "denied") {
    setState("Notifications are blocked in your browser settings", "bellOff", false, true);
    return;
  }

  const reg = await swReady;
  if (!reg) { setState("Notifications unavailable", "bellOff", false, true); return; }
  await navigator.serviceWorker.ready;

  let token = null;
  let subscribed = false;
  const flag = { get: () => { try { return localStorage.getItem("qm-push") === uid; } catch (_) { return false; } }, set: on => { try { on ? localStorage.setItem("qm-push", uid) : localStorage.removeItem("qm-push"); } catch (_) { /* ignore */ } } };
  const retry = async (fn, tries = 3, gap = 600) => { let last; for (let i = 0; i < tries; i++) { try { const v = await fn(); if (v) return v; last = new Error("empty"); } catch (e) { last = e; } await new Promise(r => setTimeout(r, gap * (i + 1))); } throw last; };
  const getTok = () => retry(() => getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: reg }));   // the service worker / network may need a moment
  const register = async () => {                                   // stores this device's token for the server; checked afterwards, so a slow answer isn't reported as a failure
    token = await getTok();
    await retry(async () => { await set(ref(db, `FCM/${uid}/${token}`), true); return true; }, 3, 800);
    subscribed = true; flag.set(true);
  };
  // Only fetch a token silently when permission was already granted (getToken may prompt otherwise).
  if (Notification.permission === "granted") {
    token = await getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: reg }).catch(() => null);
    if (token) {
      const snap = await get(ref(db, `FCM/${uid}/${token}`)).catch(() => undefined);
      if (snap === undefined) subscribed = flag.get();             // couldn't ask the database right now: believe what this device last did instead of showing "off"
      else subscribed = snap.exists();
      // The browser rotated the token (or it was cleaned up as dead) while notifications are meant to be on: sign this device up again by itself.
      if (!subscribed && flag.get()) await register().catch(() => {});
    } else if (flag.get()) subscribed = true;
  }
  setState(subscribed ? "Disable notifications" : "Enable notifications", subscribed ? "bell" : "bellOff", subscribed);

  btn.onclick = async () => {
    btn.disabled = true;
    try {
      if (subscribed) {
        flag.set(false);
        if (token) await remove(ref(db, `FCM/${uid}/${token}`));
        await deleteToken(messaging).catch(() => {});
        subscribed = false; token = null;
        toast("Notifications disabled on this device.");
      } else {
        if (Notification.permission === "default") {
          const perm = await Notification.requestPermission();
          if (perm !== "granted") { toast(perm === "denied" ? "Notifications are blocked in your browser settings." : "Notifications stay off. Press the bell again to turn them on.", "info", 5000); return; }
        }
        await register();
        toast("Notifications enabled on this device.", "success");
      }
    } catch (err) {
      toast(subscribed ? "Couldn't turn notifications off. Try again." : "Couldn't turn notifications on (" + ((err && err.message) || "network problem") + "). Check your connection and try again.", "error");
    } finally {
      setState(subscribed ? "Disable notifications" : "Enable notifications", subscribed ? "bell" : "bellOff", subscribed,
        Notification.permission === "denied");
    }
  };

  onMessage(messaging, payload => {
    const n = payload.notification || {};
    try { const cid = payload.data && payload.data.chatId; if (cid && QM && QM.state && QM.state.chatId === cid && document.visibilityState === "visible") return; } catch (_) { /* ignore */ }   // already looking at that chat
    toast(`${n.title || "New message"}${n.body ? ": " + n.body : ""}`);
  });
}

// ---------- encryption identity: recovery code / restore ----------
const recDlg = $("recoveryDialog"), resDlg = $("restoreDialog");
wireDialog(recDlg); wireDialog(resDlg);
function showRecovery(code, after) {
  $("recoveryCode").textContent = code;
  $("recoveryCopy").onclick = () => navigator.clipboard?.writeText(code).then(() => toast("Copied", "success", 1200)).catch(() => {});
  $("recoveryDone").onclick = () => { recDlg.close(); after && after(); };
  recDlg.showModal();
}
function showRestore(uid, replaced) {
  const err = $("restoreError");
  err.classList.add("hidden"); $("restoreInput").value = "";
  $("restoreText").textContent = replaced
    ? "Your encryption keys were reset on another device, so the key this device had doesn't work any more. Enter the NEW recovery code to unlock your encrypted chats here."
    : "This device doesn't have your encryption key yet. Enter the recovery code you saved when you first signed in.";
  $("restoreGo").onclick = async () => {
    try { await E2E.restore(uid, $("restoreInput").value); resDlg.close(); toast("Encrypted chats unlocked.", "success"); setTimeout(() => location.reload(), 600); }
    catch (e) { err.textContent = e.message === "badcode" ? "That code doesn't match." : "Couldn't restore: " + e.message; err.classList.remove("hidden"); }
  };
  // not now: carry on without the key. Unencrypted chats work as usual; the code can be entered later under Account → Encryption.
  $("restoreSkip").onclick = () => { E2E.setSkipped(uid, true); resDlg.close(); toast("Okay. Encrypted messages stay locked until you enter the code (Account → Encryption).", "info", 6000); };
  $("restoreFresh").onclick = async () => {
    resDlg.close();
    if (!(await confirmDialog({ title: "Reset your encryption keys?", message: E2E.RESET_WARNING, okText: "Reset keys", danger: true }))) { resDlg.showModal(); return; }
    try { await E2E.startFresh(uid); const c = await E2E.takeNewCode(uid); if (c) showRecovery(c, () => location.reload()); else location.reload(); }
    catch (e) { err.textContent = "Couldn't start fresh keys: " + e.message; err.classList.remove("hidden"); resDlg.showModal(); }
  };
  resDlg.showModal();
}
async function setupEncryption(user) {
  let st;
  try { st = await Promise.race([E2E.init(user.uid), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 10000))]); }
  catch (e) { console.warn("encryption init failed", e); return; }
  if ((st === "needs-restore" || st === "replaced") && (st === "replaced" || !E2E.skipped(user.uid))) showRestore(user.uid, st === "replaced");
  // (a brand-new key's recovery code is shown later, the first time encryption is switched on in a chat; Account → Encryption has it too)
}

// ---------- verify-your-email banner ----------
const vb = $("verifyBanner");
function paintVerifyBanner() {
  const u = auth.currentUser, show = !!u && !u.emailVerified;
  vb.hidden = !show;
  document.documentElement.classList.toggle("has-vb", show);
  document.documentElement.style.setProperty("--vb-h", show ? vb.offsetHeight + "px" : "0px");
  $("vbEmail").textContent = show && u.email ? "(sent to " + u.email + ")" : "";
}
setInterval(paintVerifyBanner, 1000);
addEventListener("resize", paintVerifyBanner);
$("vbResend").onclick = async () => { try { await resendVerification(); toast("Verification email sent.", "success"); } catch (e) { toast(e.code === "auth/too-many-requests" ? "Please wait a bit before asking again." : "Couldn't send the email.", "error"); } };
$("vbDone").onclick = async () => { if (await refreshVerified()) { paintVerifyBanner(); toast("Email verified. You're all set.", "success"); } else toast("Not verified yet — open the link in the email first.", "info", 4000); };

// ---------- auth state ----------
onAuthStateChanged(auth, async user => {
  teardown();
  loadingEl.classList.add("hidden");
  window.__qmReady = true;

  if (!user) {
    currentUid = null;
    resetShell();
    authEl.classList.remove("hidden");
    appEl.classList.add("hidden");
    topActions.classList.add("hidden");
    newChatBtn.classList.add("hidden");
    return;
  }

  currentUid = user.uid;
  authEl.classList.add("hidden");
  appEl.classList.remove("hidden");
  topActions.classList.remove("hidden");
  newChatBtn.classList.remove("hidden");

  renderList();

  try {
    const profile = await ensureProfile(user);
    accountLink.replaceChildren(avatarEl(profile.displayName, profile.pfp, "avatar sm"));
    if (profile.theme && profile.theme !== (localStorage.getItem("theme") || "system")) applyTheme(profile.theme);
  } catch (err) {
    console.error("Profile setup failed", err);
    accountLink.innerHTML = icon("users", 20);
  }

  if (auth.currentUser?.uid !== user.uid) return; // signed out/switched meanwhile
  paintVerifyBanner(); watchVerified(paintVerifyBanner);
  await setupEncryption(user);
  if (auth.currentUser?.uid !== user.uid) return;
  loadChats(user.uid);
  initShell(user.uid);
  accountLink.onclick = e => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); QM.openPane("account"); };
  setupNotifications(user.uid).catch(err => console.error("Notification setup failed", err));
  try { maybeShowTour(user, { openAccount: () => QM.openPane("account") }); } catch (err) { console.error("Welcome tour failed", err); }
});


// ---------- developer mode: raw view of what the chat list has loaded ----------
topActions.prepend(devButton("{ }", () => {
  const raw = async () => {
  const sw = navigator.serviceWorker ? await navigator.serviceWorker.getRegistrations().then(r => r.map(x => ({ scope: x.scope, active: x.active && x.active.state }))).catch(() => null) : null;
  return {
    uid: currentUid, database: activeDbUrl(), listState, listErr, e2e: { ready: E2E.ready(), fingerprint: E2E.myFingerprint() },
    shell: { state: QM.state },
    chats: [...chats.values()].map(c => ({ id: c.id, title: chatTitle(c), participants: c.participants, otherUids: c.otherUids, customName: c.customName, encrypted: c.encrypted, readKey: c.readKey, last: c.last, typing: c.typing, settled: c.settled })),
    serviceWorkers: sw, notificationPermission: window.Notification ? Notification.permission : "n/a", env: envInfo()
  };
};
  return showDev("Developer: loaded data", { raw, every: 0, visual: async () => {
    const env = envInfo(), me = await getProfile(currentUid).catch(() => null);
    const sw = navigator.serviceWorker ? await navigator.serviceWorker.getRegistrations().catch(() => []) : [];
    const list = [...chats.values()];
    const people = devCard("Chats", list.map(c => [chatTitle(c), (() => { const w = document.createElement("span"); w.append(devPill(c.encrypted ? "encrypted" : "plain", c.encrypted ? "info" : ""), " ", devPill(c.noKey ? "no key" : c.encrypted || c.keys ? "key ok" : "", c.noKey ? "warn" : "ok")); return w; })()]));
    return devGrid(
      devCard("", [["User id", currentUid], ["Database", activeDbUrl()], ["Chat list", devPill(String(listState), listState === "ready" ? "ok" : "warn")], ["Chats loaded", list.length]], { head: devWho((me && me.displayName) || "You", me && me.pfp, "signed in") }),
      devCard("Encryption", [["Identity", E2E.ready() ? devPill("unlocked", "ok") : devPill("locked", "warn")], ["Fingerprint", E2E.myFingerprint()], ["Chats without key", list.filter(c => c.noKey).length]]),
      people,
      devCard("Chat details", list.flatMap(c => [{ section: chatTitle(c) }, ["Members", c.participants ? c.participants.length : "?"], ["Last message", c.last ? new Date(c.last.timestamp).toLocaleString() : ""], ["Unread", c.last && c.last.fromUid && c.last.fromUid !== currentUid && String(c.readKey) !== String(c.last.id) ? devPill("yes", "info") : "no"], ["Key copies", c.keys ? Object.keys(c.keys).length : "0"], ["Live listeners", c.off ? c.off.length : ""]])),
      devCard("This device", [["App", env.app ? "Android app" : "browser"], ["Online", env.online ? devPill("yes", "ok") : devPill("no", "bad")], ["Service workers", sw.length], ["Notifications", window.Notification ? Notification.permission : "n/a"], ["Viewport", `${env.viewport.w}×${env.viewport.h}`], ["Page data loaded", env.loadedResources ? (env.loadedResources.transferredBytes / 1048576).toFixed(2) + " MB in " + env.loadedResources.requests + " requests" : ""]])
    );
  } });
}, { title: "Developer info" }));


// ---------- private-server mode: notifications made by this page itself (no push service). They appear while QuickMessage is open in a tab / window,
// also in the background; when every tab is closed nothing can reach the device (a private server has no way to wake a browser).
function setupLocalNotifications(btn) {
  const flagKey = "qm-pnotif-" + currentUid;
  const on = () => { try { return localStorage.getItem(flagKey) === "1" && Notification.permission === "granted"; } catch (_) { return false; } };
  const paint = () => {
    const denied = Notification.permission === "denied", active = on();
    btn.innerHTML = icon(active ? "bell" : "bellOff", 20);
    btn.title = denied ? "Notifications are blocked in your browser settings" : active ? "Turn off notifications (shown while QuickMessage is open)" : "Turn on notifications (shown while QuickMessage is open)";
    btn.setAttribute("aria-label", btn.title); btn.classList.toggle("active", active); btn.disabled = denied;
  };
  if (!("Notification" in window)) { btn.classList.add("hidden"); return; }
  btn.onclick = async () => {
    if (on()) { try { localStorage.removeItem(flagKey); } catch (_) { /* ignore */ } toast("Notifications off."); paint(); return; }
    const perm = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
    if (perm === "granted") { try { localStorage.setItem(flagKey, "1"); } catch (_) { /* ignore */ } toast("Notifications on. They show while QuickMessage is open in a tab or window.", "success", 5000); }
    paint();
  };
  paint();
  const started = Date.now();
  globalUnsubs.push(onChildAdded(ref(db, `live/${currentUid}/pings`), async snap => {
    const p = snap.val() || {};
    if (!on() || !p.ts || p.ts < started - 2000 || p.from === currentUid) return;
    if (document.visibilityState === "visible" && QM && QM.state && QM.state.chatId === snap.key) return;       // you are looking at that chat
    try {
      const [last, prof] = await Promise.all([get(ref(db, `privateChats/${snap.key}/lastMessage`)), getProfile(p.from)]);
      const m = last.val() || {};
      const body = m.enc ? "\ud83d\udd12 New message" : (m.text || "New message");
      const n = new Notification(prof.displayName || "New message", { body, tag: "chat_" + snap.key, icon: "icons/icon-192.png" });
      n.onclick = () => { window.focus(); try { QM.openChat(snap.key); } catch (_) { /* ignore */ } n.close(); };
    } catch (_) { /* ignore */ }
  }));
}
