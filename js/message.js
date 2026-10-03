import { auth, db } from "./firebase.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";
import {
  ref, push, set, get, update, remove, onValue, onDisconnect,
  onChildAdded, onChildChanged, onChildRemoved,
  query, orderByChild, limitToLast, startAt, endBefore
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-database.js";
import {
  toast, confirmDialog, promptDialog, avatarEl, icon, hydrateIcons, linkify, safeMediaUrl,
  copyText, formatMsgTime, wireDialog
} from "./ui.js";
import { getProfile, peekProfile, ensureProfile, profileExists, invalidateProfile } from "./users.js";

hydrateIcons();

const $ = id => document.getElementById(id);
const chatId = new URLSearchParams(location.search).get("chatId");
if (!chatId || !/^[\w-]{1,64}$/.test(chatId)) {
  location.replace("index.html");
  throw new Error("Missing or invalid chatId");
}

const PAGE = 30;
const OLDER_PAGE = 40;
const MAX_VIDEO_BYTES = 8 * 1024 * 1024; // base64 inflates ~33%; RTDB rejects very large writes
const TYPING_IDLE_MS = 4000;

const messagesDiv = $("messages"), typingRow = $("typingRow"), typingLabel = $("typingLabel");
const historyStatus = $("historyStatus"), jumpBtn = $("jumpBtn");
const composer = $("composer"), msgInput = $("msgInput"), sendBtn = $("sendBtn");
const menuEl = $("msgMenu");

const chatPath = `privateChats/${chatId}`;
const messagesRef = ref(db, `${chatPath}/messages`);
const lastRef = ref(db, `${chatPath}/lastMessage`);

// ---------- state ----------
let me = null;
let participants = [];
let customName = "";
let isGroup = false;
let baseSub = "";
let typingUids = [];
let typingNames = [];
let typingToken = 0;
let readReceipts = {};
const msgData = new Map();       // key -> message value
let latestKey = null;            // key of newest rendered message
let lastMarked = null;
let ready = false;
let stick = true;                // was the user at the bottom?
let oldestTs = null, oldestKey = null, loadingOlder = false, reachedStart = false;

// ---------- helpers ----------
const isNearBottom = () => messagesDiv.scrollHeight - messagesDiv.scrollTop - messagesDiv.clientHeight < 80;
const scrollToBottom = () => { messagesDiv.scrollTop = messagesDiv.scrollHeight; stick = true; jumpBtn.classList.add("hidden"); };
const isText = m => !m.type || m.type === "text";
const previewOf = m => m.type === "image" ? "📷 Photo" : m.type === "video" ? "🎥 Video" : (m.text ?? m.content ?? "");

// ---------- header ----------
function renderSub() {
  const sub = $("chatSub");
  if (typingNames.length) {
    sub.textContent = typingNames.length === 1 ? "typing…" : `${typingNames.join(", ")} typing…`;
    sub.classList.add("typing");
  } else {
    sub.textContent = baseSub;
    sub.classList.remove("typing");
  }
}

async function updateHeader() {
  const others = participants.filter(u => u !== me);
  const profiles = await Promise.all(others.map(getProfile));
  const title = customName.trim() || profiles.map(p => p.displayName).join(", ") || "Chat";
  $("chatTitle").textContent = title;
  document.title = `${title} · QuickMessage`;
  const useOther = !customName.trim() && profiles.length === 1;
  $("headAvatar").replaceChildren(avatarEl(title, useOther ? profiles[0].pfp : "", "avatar sm"));
  isGroup = participants.length > 2;
  messagesDiv.classList.toggle("group", isGroup);
  baseSub = isGroup ? `${participants.length} members` : "";
  renderSub();
}

// ---------- message rendering ----------
function fillMessage(el, key, msg) {
  const bubble = el.querySelector(".bubble");
  bubble.replaceChildren();
  bubble.classList.remove("media-bubble");

  if (msg.type === "image" || msg.type === "video") {
    const kind = msg.type;
    const src = safeMediaUrl(msg.content || msg.text, kind);
    if (!src) {
      bubble.textContent = kind === "image" ? "Unsupported image" : "Unsupported video";
    } else if (kind === "image") {
      const img = new Image();
      img.className = "media";
      img.alt = "Image";
      img.loading = "lazy";
      img.referrerPolicy = "no-referrer";
      img.addEventListener("load", () => { if (stick) scrollToBottom(); });
      img.addEventListener("click", () => { $("lightboxImg").src = src; $("lightbox").showModal(); });
      img.src = src;
      bubble.append(img);
      bubble.classList.add("media-bubble");
    } else {
      const v = document.createElement("video");
      v.className = "media";
      v.controls = true;
      v.preload = "metadata";
      v.playsInline = true;
      v.addEventListener("loadedmetadata", () => { if (stick) scrollToBottom(); });
      v.src = src;
      bubble.append(v);
      bubble.classList.add("media-bubble");
    }
  } else {
    bubble.append(linkify(msg.text ?? msg.content ?? ""));
  }

  el.querySelector(".time").textContent = formatMsgTime(msg.timestamp);
  el.querySelector(".edited").classList.toggle("hidden", !msg.editedAt);
}

function buildMessage(key, msg) {
  const own = msg.fromUid === me;
  const el = document.createElement("div");
  el.className = `msg ${own ? "own" : "other"}`;
  el.id = "msg-" + key;
  el.dataset.key = key;

  const col = document.createElement("div");
  col.className = "msg-col";

  if (!own) {
    const av = avatarEl("", "", "msg-avatar");
    el.append(av);
    const name = document.createElement("div");
    name.className = "msg-name";
    col.append(name);
    const apply = p => { name.textContent = p.displayName; av.replaceWith(avatarEl(p.displayName, p.pfp, "msg-avatar")); };
    const cached = peekProfile(msg.fromUid);
    if (cached) apply(cached); else getProfile(msg.fromUid).then(apply);
  }

  const row = document.createElement("div");
  row.className = "bubble-row";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (own) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "icon-btn msg-menu";
    btn.setAttribute("aria-label", "Message actions");
    btn.innerHTML = icon("more", 16);
    btn.addEventListener("click", e => { e.stopPropagation(); showMenu(key, btn); });
    row.append(bubble, btn);
  } else {
    row.append(bubble);
  }

  const foot = document.createElement("div");
  foot.className = "msg-foot";
  foot.innerHTML = `<span class="time"></span><span class="edited hidden">· edited</span><span class="readBy"></span>`;

  col.append(row, foot);
  el.append(col);
  fillMessage(el, key, msg);
  return el;
}

function appendLive(key, msg) {
  if (document.getElementById("msg-" + key)) return null;
  msgData.set(key, msg);
  const el = buildMessage(key, msg);
  messagesDiv.insertBefore(el, typingRow);
  latestKey = key;
  return el;
}

function onAdded(snap) {
  const msg = snap.val();
  if (!msg || document.getElementById("msg-" + snap.key)) return;
  const wasNear = isNearBottom();
  appendLive(snap.key, msg);
  renderReceipts();
  if (!ready) return;
  if (msg.fromUid === me || wasNear) scrollToBottom();
  else jumpBtn.classList.remove("hidden");
  maybeMarkRead();
}

function onChanged(snap) {
  const msg = snap.val();
  if (!msg) return;
  msgData.set(snap.key, msg);
  const el = document.getElementById("msg-" + snap.key);
  if (el) fillMessage(el, snap.key, msg); else onAdded(snap);
}

function onRemoved(snap) {
  msgData.delete(snap.key);
  document.getElementById("msg-" + snap.key)?.remove();
  if (latestKey === snap.key) {
    const msgs = messagesDiv.querySelectorAll(".msg");
    latestKey = msgs.length ? msgs[msgs.length - 1].dataset.key : null;
  }
}

async function loadOlder() {
  if (loadingOlder || reachedStart || oldestTs == null) return;
  loadingOlder = true;
  historyStatus.textContent = "Loading older messages…";
  try {
    const snap = await get(query(messagesRef, orderByChild("timestamp"), endBefore(oldestTs, oldestKey), limitToLast(OLDER_PAGE)));
    const list = [];
    snap.forEach(s => { list.push(s); });
    if (!list.length) {
      reachedStart = true;
      historyStatus.textContent = "Beginning of the conversation";
    } else {
      const prevHeight = messagesDiv.scrollHeight;
      const anchor = messagesDiv.querySelector(".msg") || typingRow;
      for (const s of list) {
        if (document.getElementById("msg-" + s.key)) continue;
        const m = s.val();
        msgData.set(s.key, m);
        messagesDiv.insertBefore(buildMessage(s.key, m), anchor);
      }
      oldestTs = list[0].val().timestamp;
      oldestKey = list[0].key;
      messagesDiv.scrollTop += messagesDiv.scrollHeight - prevHeight;
      if (list.length < OLDER_PAGE) { reachedStart = true; historyStatus.textContent = "Beginning of the conversation"; }
      else historyStatus.textContent = "";
    }
  } catch (err) {
    console.error("Failed to load history", err);
    historyStatus.textContent = "Couldn't load older messages";
  }
  loadingOlder = false;
}

messagesDiv.addEventListener("scroll", () => {
  stick = isNearBottom();
  if (stick) jumpBtn.classList.add("hidden");
  if (messagesDiv.scrollTop < 40) loadOlder();
  closeMenu();
}, { passive: true });
jumpBtn.addEventListener("click", scrollToBottom);

// ---------- read receipts ----------
function maybeMarkRead() {
  if (!ready || !latestKey || document.hidden) return;
  if (String(lastMarked) === String(latestKey)) return;
  lastMarked = latestKey;
  set(ref(db, `${chatPath}/messageRead/${me}`), latestKey).catch(() => {});
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) maybeMarkRead(); });
window.addEventListener("focus", maybeMarkRead);

function renderReceipts() {
  messagesDiv.querySelectorAll(".readBy").forEach(el => { el.textContent = ""; });
  const byKey = {};
  for (const [uid, key] of Object.entries(readReceipts)) {
    if (uid === me || !participants.includes(uid)) continue;
    (byKey[String(key)] ||= []).push(uid);
  }
  for (const [key, uids] of Object.entries(byKey)) {
    const el = document.getElementById("msg-" + key);
    if (!el || !el.classList.contains("own")) continue;
    const names = uids.map(u => peekProfile(u)?.displayName || "Someone");
    el.querySelector(".readBy").textContent = isGroup ? "Seen by " + names.join(", ") : "Seen";
  }
}

// ---------- typing indicator ----------
let isTyping = false;
let typingTimer = null;
const myTypingRef = () => ref(db, `${chatPath}/typing/${me}`);

function setTyping(on) {
  if (!me || on === isTyping) return;
  isTyping = on;
  if (on) {
    set(myTypingRef(), true).catch(() => {});
    onDisconnect(myTypingRef()).remove().catch(() => {});
  } else {
    remove(myTypingRef()).catch(() => {});
  }
}

function bumpTyping() {
  clearTimeout(typingTimer);
  if (!msgInput.value.trim()) { setTyping(false); return; }
  setTyping(true);
  typingTimer = setTimeout(() => setTyping(false), TYPING_IDLE_MS);
}

async function renderTyping() {
  const token = ++typingToken;
  if (!typingUids.length) {
    typingRow.classList.add("hidden");
    typingNames = [];
    renderSub();
    return;
  }
  const ps = await Promise.all(typingUids.map(getProfile));
  if (token !== typingToken) return; // newer update superseded this one
  typingNames = ps.map(p => p.displayName);
  typingLabel.textContent =
    typingNames.length === 1 ? `${typingNames[0]} is typing…` :
    typingNames.length === 2 ? `${typingNames[0]} and ${typingNames[1]} are typing…` :
    "Several people are typing…";
  const wasNear = isNearBottom();
  typingRow.classList.remove("hidden");
  renderSub();
  if (wasNear) scrollToBottom();
}

msgInput.addEventListener("input", () => { autosize(); bumpTyping(); });
msgInput.addEventListener("blur", () => { clearTimeout(typingTimer); setTyping(false); });
document.addEventListener("visibilitychange", () => { if (document.hidden) { clearTimeout(typingTimer); setTyping(false); } });
window.addEventListener("pagehide", () => { if (isTyping) remove(myTypingRef()).catch(() => {}); });

// ---------- composer ----------
function autosize() {
  msgInput.style.height = "auto";
  msgInput.style.height = Math.min(msgInput.scrollHeight, 140) + "px";
}

msgInput.addEventListener("keydown", e => {
  // Enter sends on desktop; on touch devices Enter inserts a newline.
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && matchMedia("(pointer: fine)").matches) {
    e.preventDefault();
    composer.requestSubmit();
  }
});
sendBtn.addEventListener("mousedown", e => e.preventDefault()); // keep keyboard open on mobile

composer.addEventListener("submit", async e => {
  e.preventDefault();
  const text = msgInput.value.trim();
  if (!text) return;
  msgInput.value = "";
  autosize();
  clearTimeout(typingTimer);
  setTyping(false);
  try {
    await sendMessage({ text });
  } catch (err) {
    console.error(err);
    msgInput.value = text;
    autosize();
    toast("Message failed to send. Check your connection.", "error");
  }
  msgInput.focus();
});

async function sendMessage({ type = "text", text = "", content = "" }) {
  const msgRef = push(messagesRef);
  const timestamp = Date.now();
  const payload = type === "text" ? { fromUid: me, text, timestamp } : { fromUid: me, type, content, timestamp };
  await update(ref(db), {
    [`${chatPath}/messages/${msgRef.key}`]: payload,
    [`${chatPath}/lastMessage`]: { fromUid: me, text: previewOf(payload), timestamp, id: msgRef.key }
  });
  notifyServer();
}

async function notifyServer() {
  try {
    const idToken = await auth.currentUser.getIdToken();
    await fetch("notify.php", { method: "POST", body: new URLSearchParams({ chatId, idToken }) });
  } catch (err) {
    console.warn("Notification request failed", err);
  }
}

// ---------- message actions ----------
function closeMenu() {
  if (menuEl.classList.contains("hidden")) return;
  menuEl.classList.add("hidden");
  messagesDiv.querySelectorAll(".msg-menu.open").forEach(b => b.classList.remove("open"));
}

function showMenu(key, btn) {
  const wasOpen = btn.classList.contains("open");
  closeMenu();
  if (wasOpen) return;
  const msg = msgData.get(key);
  if (!msg) return;
  btn.classList.add("open");
  menuEl.replaceChildren();
  const add = (label, ico, fn, danger = false) => {
    const b = document.createElement("button");
    b.type = "button";
    if (danger) b.className = "danger";
    b.innerHTML = icon(ico, 16);
    b.append(document.createTextNode(label));
    b.addEventListener("click", () => { closeMenu(); fn(); });
    menuEl.append(b);
  };
  if (isText(msg)) {
    add("Copy", "copy", () => copyText(msg.text ?? msg.content ?? ""));
    add("Edit", "more", () => editMessage(key));
  }
  add("Delete", "close", () => deleteMessage(key), true);

  menuEl.classList.remove("hidden");
  const r = btn.getBoundingClientRect();
  const m = menuEl.getBoundingClientRect();
  const left = Math.min(Math.max(8, r.right - m.width), innerWidth - m.width - 8);
  let top = r.bottom + 4;
  if (top + m.height > innerHeight - 8) top = Math.max(8, r.top - m.height - 4);
  menuEl.style.left = left + "px";
  menuEl.style.top = top + "px";
}

document.addEventListener("pointerdown", e => {
  if (!menuEl.contains(e.target) && !e.target.closest(".msg-menu")) closeMenu();
});
document.addEventListener("keydown", e => { if (e.key === "Escape") closeMenu(); });
window.addEventListener("resize", closeMenu);

async function isLastMessage(key, msg) {
  const last = (await get(lastRef)).val();
  if (!last) return null;
  if (last.id === key) return last;
  // Legacy messages have no id in lastMessage; fall back to matching sender + text.
  if (!last.id && last.fromUid === me && last.text === previewOf(msg)) return last;
  return null;
}

async function editMessage(key) {
  const msg = msgData.get(key);
  if (!msg || !isText(msg)) return;
  const val = await promptDialog({
    title: "Edit message", okText: "Save",
    input: { value: msg.text ?? "", multiline: true, maxLength: 4000 }
  });
  if (val === null) return;
  const text = val.trim();
  if (!text || text === msg.text) return;
  try {
    // Keep the original timestamp so the message doesn't jump in the ordering.
    await update(ref(db, `${chatPath}/messages/${key}`), { text, editedAt: Date.now() });
    if (await isLastMessage(key, msg)) await update(lastRef, { text, id: key });
  } catch (err) {
    console.error(err);
    toast("Couldn't edit that message.", "error");
  }
}

async function deleteMessage(key) {
  const msg = msgData.get(key);
  const ok = await confirmDialog({
    title: "Delete message?", message: "This removes it for everyone in the chat.",
    okText: "Delete", danger: true
  });
  if (!ok) return;
  try {
    const wasLast = msg ? await isLastMessage(key, msg) : null;
    await remove(ref(db, `${chatPath}/messages/${key}`));
    if (wasLast) {
      // Point the chat-list preview at the previous message instead of the deleted one.
      let prev = null;
      (await get(query(messagesRef, orderByChild("timestamp"), limitToLast(1)))).forEach(s => { prev = { key: s.key, ...s.val() }; });
      await set(lastRef, prev
        ? { fromUid: prev.fromUid, text: previewOf(prev), timestamp: prev.timestamp, id: prev.key, notifSent: true }
        : { fromUid: "", text: "(No messages yet)", timestamp: wasLast.timestamp || Date.now() });
    }
  } catch (err) {
    console.error(err);
    toast("Couldn't delete that message.", "error");
  }
}

// ---------- media ----------
const attachDialog = $("attachDialog");
wireDialog(attachDialog);
wireDialog($("optionsDialog"));
$("lightbox").addEventListener("click", () => $("lightbox").close());

$("attachBtn").onclick = () => { $("mediaUrl").value = ""; attachDialog.showModal(); };
$("attachClose").onclick = () => attachDialog.close();
$("pickFileBtn").onclick = () => $("fileInput").click();
$("pickCameraBtn").onclick = () => $("cameraInput").click();
for (const id of ["fileInput", "cameraInput"]) {
  $(id).addEventListener("change", e => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    attachDialog.close();
    sendFile(file);
  });
}

$("sendLinkBtn").onclick = async () => {
  const url = $("mediaUrl").value.trim();
  if (!/^https?:\/\/\S+$/i.test(url)) return toast("Enter a full http(s) link.", "error");
  const type = /\.(mp4|webm|mov|m4v|ogv|ogg)(\?|#|$)/i.test(url) ? "video" : "image";
  attachDialog.close();
  try { await sendMessage({ type, content: url }); }
  catch { toast("Couldn't send that link.", "error"); }
};

const readAsDataURL = file => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(new Error("Couldn't read that file."));
  r.readAsDataURL(file);
});

async function prepareImage(file) {
  const LIMIT = 2.8 * 1024 * 1024; // characters in the data URL
  if (file.type === "image/gif" || file.type === "image/svg+xml") {
    if (file.size > 2 * 1024 * 1024) throw new Error("That file is over 2 MB.");
    return readAsDataURL(file);
  }
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch {
    if (file.size > 2 * 1024 * 1024) throw new Error("That image is over 2 MB.");
    return readAsDataURL(file);
  }
  try {
    for (const [dim, q] of [[1280, 0.82], [1024, 0.7], [800, 0.6]]) {
      const scale = Math.min(1, dim / Math.max(bmp.width, bmp.height));
      const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(bmp, 0, 0, w, h);
      const url = canvas.toDataURL("image/jpeg", q);
      if (url.length <= LIMIT) return url;
    }
  } finally { bmp.close?.(); }
  throw new Error("That image is too large even after resizing.");
}

async function sendFile(file) {
  try {
    if (file.type.startsWith("image/")) {
      toast("Sending photo…", "info", 1500);
      await sendMessage({ type: "image", content: await prepareImage(file) });
    } else if (file.type.startsWith("video/")) {
      if (file.size > MAX_VIDEO_BYTES) { toast("Videos must be under 8 MB. Send a link for bigger ones.", "error"); return; }
      toast("Sending video…", "info", 2500);
      await sendMessage({ type: "video", content: await readAsDataURL(file) });
    } else {
      toast("Only photos and videos can be sent.", "error");
    }
  } catch (err) {
    console.error(err);
    toast(err.message || "Couldn't send that file.", "error");
  }
}

// Paste an image straight from the clipboard (with a confirmation preview).
msgInput.addEventListener("paste", async e => {
  const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith("image/"));
  if (!item) return;
  e.preventDefault();
  const file = item.getAsFile();
  if (!file) return;
  const objUrl = URL.createObjectURL(file);
  const preview = new Image();
  preview.src = objUrl;
  preview.alt = "Pasted image";
  preview.style.cssText = "max-width:100%;max-height:240px;border-radius:12px;align-self:center";
  const ok = await confirmDialog({ title: "Send this image?", node: preview, okText: "Send" });
  URL.revokeObjectURL(objUrl);
  if (ok) sendFile(file);
});

// ---------- chat options ----------
const optionsDialog = $("optionsDialog");
let participantsRenderToken = 0;

$("chatOptionsBtn").onclick = () => {
  $("chatNameInput").value = customName;
  renderParticipants();
  optionsDialog.showModal();
};
$("optionsClose").onclick = () => optionsDialog.close();

$("saveChatNameBtn").onclick = async () => {
  try {
    await set(ref(db, `${chatPath}/chatData/name`), $("chatNameInput").value.trim());
    toast("Chat name saved.", "success");
  } catch (err) {
    console.error(err);
    toast("Couldn't save the chat name.", "error");
  }
};

async function renderParticipants() {
  const token = ++participantsRenderToken;
  const profiles = await Promise.all(participants.map(getProfile));
  if (token !== participantsRenderToken) return;
  const list = $("participantsList");
  list.replaceChildren();
  profiles.forEach(p => {
    const row = document.createElement("div");
    row.className = "participant-row";
    row.append(avatarEl(p.displayName, p.pfp, "avatar sm"));
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = p.displayName;
    if (p.uid === me) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = "You";
      name.append(tag);
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn small" + (p.uid === me ? " danger" : "");
    btn.textContent = p.uid === me ? "Leave" : "Remove";
    btn.onclick = () => removeParticipant(p.uid);
    row.append(name, btn);
    list.append(row);
  });
}

async function removeParticipant(uid) {
  const self = uid === me;
  const name = peekProfile(uid)?.displayName || "this user";
  const ok = await confirmDialog({
    title: self ? "Leave this chat?" : `Remove ${name}?`,
    message: self ? "You won't see this conversation anymore." : "They will no longer see this conversation.",
    okText: self ? "Leave" : "Remove", danger: true
  });
  if (!ok) return;

  try {
    const snap = await get(ref(db, `${chatPath}/participants`));
    const current = snap.val() || {};
    if (self && Object.keys(current).length === 1) {
      await remove(ref(db, chatPath));
      remove(ref(db, `chatList/${me}/${chatId}`)).catch(() => {});
      toast("Chat deleted because you were the only member.");
      setTimeout(() => location.replace("index.html"), 600);
      return;
    }
    await update(ref(db), {
      [`${chatPath}/participants/${uid}`]: null,
      [`${chatPath}/messageRead/${uid}`]: null,
      [`${chatPath}/typing/${uid}`]: null
    });
    if (self) {
      remove(ref(db, `chatList/${me}/${chatId}`)).catch(() => {});
      toast("You left the chat.");
      setTimeout(() => location.replace("index.html"), 600);
    } else {
      toast(`${name} was removed.`);
    }
  } catch (err) {
    console.error(err);
    toast("That didn't work. You may not have permission.", "error");
  }
}

$("addUserBtn").onclick = async () => {
  const input = $("addUserUid");
  const newUid = input.value.trim();
  if (!newUid) return toast("Enter a UID.", "error");
  if (!/^[\w-]{6,128}$/.test(newUid)) return toast("That doesn't look like a valid UID.", "error");
  if (participants.includes(newUid)) return toast("They're already in this chat.", "error");

  try {
    if (!(await profileExists(newUid))) return toast("No user found with that UID.", "error");
    const p = await getProfile(newUid);
    const node = document.createElement("div");
    node.className = "profile-preview";
    const label = document.createElement("div");
    label.className = "name";
    label.textContent = p.displayName;
    node.append(avatarEl(p.displayName, p.pfp, "avatar"), label);
    const ok = await confirmDialog({ title: "Add to this chat?", node, okText: "Add" });
    if (!ok) return;
    await update(ref(db, `${chatPath}/participants`), { [newUid]: true });
    await set(ref(db, `chatList/${newUid}/${chatId}`), true);
    input.value = "";
    toast(`${p.displayName} was added.`, "success");
  } catch (err) {
    console.error(err);
    toast("Couldn't add that user.", "error");
  }
};

// ---------- boot ----------
function leaveChat(message) {
  toast(message, "error");
  setTimeout(() => location.replace("index.html"), 900);
}

onAuthStateChanged(auth, async user => {
  if (!user) { location.replace("index.html"); return; }
  if (me) return; // already initialised
  me = user.uid;
  ensureProfile(user).catch(() => {});

  // Membership + header (also detects being removed from the chat)
  onValue(ref(db, `${chatPath}/participants`), snap => {
    const v = snap.val();
    if (!v || !v[me]) { leaveChat("You're no longer in this chat."); return; }
    participants = Object.keys(v);
    updateHeader();
    renderReceipts();
    if (optionsDialog.open) renderParticipants();
  }, () => leaveChat("You don't have access to this chat."));

  onValue(ref(db, `${chatPath}/chatData/name`), snap => {
    customName = snap.val() || "";
    updateHeader();
  }, () => {});

  onValue(ref(db, `${chatPath}/messageRead`), snap => {
    readReceipts = snap.val() || {};
    // make sure names are cached before drawing "Seen by …"
    Promise.all(Object.keys(readReceipts).map(getProfile)).then(renderReceipts);
  }, () => {});

  onValue(ref(db, `${chatPath}/typing`), snap => {
    const v = snap.val() || {};
    typingUids = Object.keys(v).filter(u => u !== me && v[u]);
    renderTyping();
  }, () => {});

  // Initial page of history, then a live window starting at its oldest message.
  try {
    const initSnap = await get(query(messagesRef, orderByChild("timestamp"), limitToLast(PAGE)));
    const initial = [];
    initSnap.forEach(s => { initial.push(s); });

    if (initial.length < PAGE) {
      reachedStart = true;
      historyStatus.textContent = initial.length ? "Beginning of the conversation" : "No messages yet — say hi 👋";
    }
    if (initial.length) {
      oldestTs = initial[0].val().timestamp;
      oldestKey = initial[0].key;
    }
    initial.forEach(s => appendLive(s.key, s.val()));
    renderReceipts();
    scrollToBottom();
    ready = true;
    maybeMarkRead();

    const live = query(messagesRef, orderByChild("timestamp"), startAt(oldestTs ?? 0));
    onChildAdded(live, onAdded);
    onChildChanged(live, onChanged);
    onChildRemoved(live, onRemoved);
  } catch (err) {
    console.error("Failed to load messages", err);
    historyStatus.textContent = "Couldn't load messages. Check your connection and reload.";
  }
});


/* ---------- calling ---------- */
callBtn.onclick = event => {
  event.preventDefault();
  location.href = `call.html?chatId=${encodeURIComponent(chatId)}`;
};
