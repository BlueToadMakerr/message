import { app, auth, db, VAPID_KEY } from "./firebase.js";
import {
  onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signInWithPopup, GoogleAuthProvider, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";
import {
  ref, push, set, get, update, remove, onChildAdded, onChildRemoved, onValue
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-database.js";
import {
  getMessaging, getToken, deleteToken, onMessage, isSupported
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-messaging.js";
import {
  toast, avatarEl, icon, hydrateIcons, formatListTime, authErrorMessage, wireDialog, promptDialog
} from "./ui.js";
import { getProfile, ensureProfile, profileExists } from "./users.js";
import { applyTheme } from "./theme.js";

hydrateIcons();

// ---------- elements ----------
const $ = id => document.getElementById(id);
const loadingEl = $("loading"), authEl = $("auth"), appEl = $("app");
const chatListEl = $("chatList"), topActions = $("topActions"), accountLink = $("accountLink");
const newChatBtn = $("newChatBtn"), installBtn = $("installBtn"), toggleNotifBtn = $("toggleNotifBtn");
const emailInput = $("email"), passwordInput = $("password");

// ---------- service worker ----------
let swReady = null;
if ("serviceWorker" in navigator) {
  swReady = navigator.serviceWorker.register("firebase-messaging-sw.js").catch(err => {
    console.error("SW registration failed", err);
    return null;
  });
}

// ---------- PWA install ----------
let deferredPrompt = null;
window.addEventListener("beforeinstallprompt", e => {
  e.preventDefault();
  deferredPrompt = e;
  installBtn.classList.remove("hidden");
});
installBtn.addEventListener("click", async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  installBtn.classList.add("hidden");
});
window.addEventListener("appinstalled", () => installBtn.classList.add("hidden"));

// ---------- auth ----------
$("googleBtn").onclick = async () => {
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
  try { await createUserWithEmailAndPassword(auth, emailInput.value.trim(), passwordInput.value); }
  catch (err) { const m = authErrorMessage(err); if (m) toast(m, "error"); }
  finally { btn.disabled = false; }
};

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
let renderQueued = false;

function schedule() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderList(); });
}

function teardown() {
  globalUnsubs.forEach(fn => { try { fn(); } catch { /* ignore */ } });
  globalUnsubs = [];
  chats.forEach(s => s.off.forEach(fn => { try { fn(); } catch { /* ignore */ } }));
  chats.clear();
  chatListEl.replaceChildren();
}

function loadChats(uid) {
  const listRef = ref(db, `chatList/${uid}`);
  globalUnsubs.push(onChildAdded(listRef, snap => attachChat(uid, snap.key)));
  globalUnsubs.push(onChildRemoved(listRef, snap => detachChat(snap.key)));
}

async function attachChat(uid, chatId) {
  if (chats.has(chatId)) return;
  const s = {
    id: chatId, participants: null, otherUids: [], otherNames: [], otherProfiles: [],
    customName: "", last: null, lastSender: "", readKey: null, typing: [], off: []
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
  listen(`privateChats/${chatId}/chatData/name`, snap => { s.customName = snap.val() || ""; schedule(); });
  listen(`privateChats/${chatId}/lastMessage`, snap => {
    if (!snap.exists()) {
      detachChat(chatId);
      remove(ref(db, `chatList/${uid}/${chatId}`)).catch(() => {});
      return;
    }
    s.last = snap.val();
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

function detachChat(chatId) {
  const s = chats.get(chatId);
  if (!s) return;
  s.off.forEach(fn => { try { fn(); } catch { /* ignore */ } });
  chats.delete(chatId);
  schedule();
}

function chatTitle(s) {
  return s.customName.trim() || s.otherNames.join(", ") || "Chat";
}

function renderList() {
  const items = [...chats.values()]
    .filter(s => s.participants && s.last)
    .sort((a, b) => (b.last.timestamp || 0) - (a.last.timestamp || 0));

  chatListEl.replaceChildren();
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

    const title = chatTitle(s);
    const useOther = !s.customName.trim() && s.otherProfiles.length === 1;
    a.append(avatarEl(title, useOther ? s.otherProfiles[0].pfp : "", "avatar"));

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
    head.append(t, time);

    const prev = document.createElement("div");
    prev.className = "chat-preview";
    const txt = document.createElement("span");
    txt.className = "txt";
    if (s.typing.length) {
      txt.classList.add("typing-text");
      txt.textContent = s.typing.length === 1 ? "typing…" : `${s.typing.length} people typing…`;
    } else {
      const text = s.last.text || "";
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
}

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
    const other = ncInput.value.trim();
    const fail = msg => { ncError.textContent = msg; ncError.classList.remove("hidden"); };
    if (!other) return fail("Enter a UID.");
    if (other === uid) return fail("You can't chat with yourself.");
    if (!/^[\w-]{6,128}$/.test(other)) return fail("That doesn't look like a valid UID.");

    ncGo.disabled = true;
    try {
      if (!(await profileExists(other))) { fail("No user found with that UID."); return; }
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
  const existing = [...chats.values()].find(s =>
    s.participants && s.participants.length === 2 && s.participants.includes(ncTarget));
  if (existing) {
    location.href = `message.html?chatId=${encodeURIComponent(existing.id)}`;
    return;
  }

  ncGo.disabled = true;
  try {
    const newRef = push(ref(db, "privateChats"));
    const chatId = newRef.key;
    await set(newRef, {
      participants: { [uid]: true, [ncTarget]: true },
      lastMessage: { fromUid: "", text: "(No messages yet)", timestamp: Date.now() }
    });
    await update(ref(db), {
      [`chatList/${uid}/${chatId}`]: true,
      [`chatList/${ncTarget}/${chatId}`]: true
    });
    location.href = `message.html?chatId=${encodeURIComponent(chatId)}`;
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
  const messaging = await getMsg();
  const btn = toggleNotifBtn;
  btn.classList.remove("hidden");

  const setState = (label, ico, active, disabled = false) => {
    btn.innerHTML = icon(ico, 20);
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.classList.toggle("active", active);
    btn.disabled = disabled;
  };

  if (!messaging || !("Notification" in window) || !("serviceWorker" in navigator)) {
    setState("Notifications aren't supported in this browser", "bellOff", false, true);
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
  // Only fetch a token silently when permission was already granted (getToken may prompt otherwise).
  if (Notification.permission === "granted") {
    token = await getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: reg }).catch(() => null);
    if (token) subscribed = (await get(ref(db, `FCM/${uid}/${token}`)).catch(() => null))?.exists() || false;
  }
  setState(subscribed ? "Disable notifications" : "Enable notifications", subscribed ? "bell" : "bellOff", subscribed);

  btn.onclick = async () => {
    btn.disabled = true;
    try {
      if (subscribed) {
        if (token) await remove(ref(db, `FCM/${uid}/${token}`));
        await deleteToken(messaging).catch(() => {});
        subscribed = false; token = null;
        toast("Notifications disabled on this device.");
      } else {
        if (Notification.permission === "default") {
          const perm = await Notification.requestPermission();
          if (perm !== "granted") throw new Error("Notification permission wasn't granted.");
        }
        token = await getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
        if (!token) throw new Error("No notification token received.");
        await set(ref(db, `FCM/${uid}/${token}`), true);
        subscribed = true;
        toast("Notifications enabled on this device.", "success");
      }
    } catch (err) {
      toast(err.message || "Couldn't change notification settings.", "error");
    } finally {
      setState(subscribed ? "Disable notifications" : "Enable notifications", subscribed ? "bell" : "bellOff", subscribed,
        Notification.permission === "denied");
    }
  };

  onMessage(messaging, payload => {
    const n = payload.notification || {};
    toast(`${n.title || "New message"}${n.body ? ": " + n.body : ""}`);
  });
}

// ---------- auth state ----------
onAuthStateChanged(auth, async user => {
  teardown();
  loadingEl.classList.add("hidden");

  if (!user) {
    currentUid = null;
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
  loadChats(user.uid);
  setupNotifications(user.uid).catch(err => console.error("Notification setup failed", err));
});
