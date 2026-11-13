import { auth, db } from "./firebase.js";
import { wirePhotoUpload } from "./photo.js";
import { initChatSearch } from "./catsearch.js";
import { onAuthStateChanged } from "./sdk.js";
import {
  ref, push, set, get, update, remove, onValue, onDisconnect, serverTimestamp,
  onChildAdded, onChildChanged, onChildRemoved,
  query, orderByChild, orderByKey, limitToLast, limitToFirst, equalTo, startAt, endBefore
} from "./sdk.js";
import {
  toast, confirmDialog, promptDialog, avatarEl, icon, hydrateIcons, linkify, safeMediaUrl,
  copyText, formatMsgTime, wireDialog, alertDialog
} from "./ui.js";
import { initCallBanner } from "./call-banner.js";
import { PRIVATE } from "./mode.js";
import { cacheGet, cachePut, cacheDrop, cachePrune } from "./mediacache.js";
import { saverOn, gateNode, onSaverChange } from "./datasaver.js";
import { ocGet, ocSet, savedPage, SavedSnap, offlineOn, begin as beginSync, getSWR, onValueSWR } from "./offline.js";
import { QM, enterShell, trackSplit, toHome, markReady } from "./embed.js";
import { isLitterUrl, fmtBytes, kindOf, relayMax } from "./litter.js";
import { uploadToHosts, fmtTtl, fmtLimit } from "./hosts.js";
import { logEvent } from "./catlog.js";
import { getProfile, peekProfile, ensureProfile, profileExists, invalidateProfile } from "./users.js";
import { mentionsOf, decorate, attachMentionBox, attachSwipeReply } from "./mentions.js";
import * as E2E from "./crypto.js";
import { sealPayload, sealPreview, openMessage } from "./msgcrypto.js";
import { attachPreviews, urlsIn, inspectUrl, fetchPreviewNow } from "./linkpreview.js";
import { openImage } from "./viewer.js";
import { track, bucket, sizeBucket } from "./analytics.js";
import { openCode, isTextFile, langOf, textOfData, colorLine, MAX_TEXT_BYTES } from "./codeview.js";
import { downloadMedia } from "./download.js";
import { audioPlayer, videoPlayer, waveFromFile } from "./player.js";
import { devOn, devButton, showDev, envInfo, devCard, devGrid, devPill, devWho } from "./dev.js";
import { resolveRecipient } from "./recipient.js";
import { ensureFriend, publicCodeOf } from "./friend.js";
import { isBotUid, listBots, addBotToChat } from "./bots.js";
import { requireVerified, isVerified, watchVerified } from "./verify.js";

hydrateIcons();

const $ = id => document.getElementById(id);
const chatId = new URLSearchParams(location.search).get("chatId");
const AT = new URLSearchParams(location.search).get("at");          // opened on one message of the history (from search): only that area is loaded
let windowed = false, newestKey = null, loadingNewer = false, searchIdx = null, sawEnc = false;
const idxAdd = (k, m) => { if (m && (m._enc || m.enc || rawOf.has(m))) sawEnc = true; searchIdx?.add(k, m); };
if (!chatId || !/^[\w-]{1,64}$/.test(chatId)) {
  location.replace("index.html");
  throw new Error("Missing or invalid chatId");
}
if (enterShell(`chat=${encodeURIComponent(chatId)}`)) throw new Error("Redirecting into the app shell");
trackSplit();
if (QM) document.querySelector('.topbar > a[aria-label="Back to chats"]')?.addEventListener("click", e => { e.preventDefault(); QM.closeDetail(); });

const PAGE = 30;
const OLDER_PAGE = 40;
const MAX_VIDEO_BYTES = 8 * 1024 * 1024;
const MAX_AUDIO_BYTES = MAX_VIDEO_BYTES;     // same inline limit as video; bigger files go to Litterbox // base64 inflates ~33%; RTDB rejects very large writes
const TYPING_IDLE_MS = 4000;

const messagesDiv = $("messages"), typingRow = $("typingRow"), typingLabel = $("typingLabel");
const historyStatus = $("historyStatus"), jumpBtn = $("jumpBtn");
const composer = $("composer"), msgInput = $("msgInput"), sendBtn = $("sendBtn");
const menuEl = $("msgMenu");

const chatPath = `privateChats/${chatId}`;
initCallBanner({ chatId, callBtn: document.getElementById("callBtn"), after: document.querySelector(".topbar") });
const messagesRef = ref(db, `${chatPath}/messages`);
const lastRef = ref(db, `${chatPath}/lastMessage`);

// ---------- state ----------
let me = null;
let participants = [];
let customName = "";
let customPhoto = "";
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
let oldestKey = null, loadingOlder = false, reachedStart = false;
let chatEncrypted = false;       // chatData/encrypted: new messages are encrypted (every message also carries its own `enc` flag)
let keyHolders = [];
let keysExist = false;            // the chat already has a key in the database (even if this device can't open it)
let keyState = "unknown";        // "ready" | "waiting" (no key on this device yet)
const rawOf = new WeakMap();      // decrypted message object -> the message exactly as stored (developer mode)
const BIG_MIN = 12000;                                   // characters: media above this is stored in media/{key} instead of inside the message
const hydrate = m => {
  if (m && m.big && (m.type === "image" || m.type === "video" || m.type === "audio")) return Promise.resolve({ ...m, content: "", _big: true, _enc: !!m.enc });     // the picture itself is loaded when it is on screen (loadBig)
  return m && m.enc ? openMessage(chatId, m).then(o => { if (o && typeof o === "object") rawOf.set(o, m); return o; }) : Promise.resolve(m);
};
// Fetch (or take from this device's cache) the media of a message whose body lives in media/{key}, open it, and redraw the message.
const bigLoading = new Set();
async function loadBig(key, manual = false) {
  const msg = msgData.get(key);
  if (!msg || !msg._big || bigLoading.has(key)) return;
  bigLoading.add(key);
  try {
    let body = await cacheGet(chatId, key);
    if (body == null) {
      // Data Saver: nothing is downloaded from the database until you tap it (what is already on this device still shows)
      if (!manual && saverOn()) {
        const el = document.getElementById("msg-" + key), b = el && el.querySelector(".media-lazy");
        if (b) { b.dataset.gated = "1"; b.classList.add("saver-gate"); b.textContent = (msg.type === "audio" ? "\ud83c\udfb5 Tap to load audio" : msg.type === "video" ? "\ud83c\udfa5 Tap to load video" : "\ud83d\udcf7 Tap to load photo") + " (Data Saver)"; b.onclick = () => { b.onclick = null; b.textContent = "Loading\u2026"; loadBig(key, true); }; }
        return;
      }
      body = (await get(ref(db, `${chatPath}/media/${key}`))).val(); if (typeof body === "string") cachePut(chatId, key, body);
    }
    if (typeof body !== "string") throw new Error("missing");
    const { _big, ...stub } = msg;
    const open = stub.enc ? await openMessage(chatId, { ...stub, content: body }) : { ...stub, content: body };
    msgData.set(key, open);
    const el = document.getElementById("msg-" + key);
    if (el) fillMessage(el, key, open);
  } catch (_) {
    const el = document.getElementById("msg-" + key), b = el && el.querySelector(".media-lazy");
    if (b) { b.textContent = "Couldn't load \u2014 tap to retry"; b.onclick = () => { bigLoading.delete(key); b.textContent = "Loading\u2026"; loadBig(key, true); }; }
  } finally { bigLoading.delete(key); }
}
const lazyIO = typeof IntersectionObserver === "function" ? new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { lazyIO.unobserve(e.target); loadBig(e.target.dataset.key); } }), { root: null, rootMargin: "600px 0px" }) : null;
onSaverChange(on => { if (!on) document.querySelectorAll(".media-lazy[data-gated]").forEach(b => { delete b.dataset.gated; b.onclick = null; b.textContent = "Loading\u2026"; loadBig(b.dataset.key); }); });
function lazyPlaceholder(bubble, key, msg) {
  const d = document.createElement("div");
  d.className = "media-lazy"; d.dataset.key = key;
  d.textContent = msg.type === "audio" ? "\ud83c\udfb5 Loading audio\u2026" : msg.type === "video" ? "\ud83c\udfa5 Loading video\u2026" : "\ud83d\udcf7 Loading photo\u2026";
  bubble.append(d); bubble.classList.add("media-bubble");
  lazyIO ? lazyIO.observe(d) : loadBig(key);
}
let addQ = Promise.resolve();
// Lock-screen protection (Android): while the phone is locked and a call was answered from the lock screen, only messages sent
// since then are shown (see shell.js "protect"). Older ones appear after the phone is unlocked.
// Inside an Android chat bubble (BubbleActivity): only this chat, no way to the rest of the app.
if (new URLSearchParams(location.search).has("bubble")) {
  document.documentElement.classList.add("in-bubble");
  // the bubble window changes size as it opens: always fit the chat to the space that is really there
  const fit = () => document.documentElement.style.setProperty("--bh", (window.visualViewport ? window.visualViewport.height : innerHeight) + "px");
  fit(); addEventListener("resize", fit); window.visualViewport && window.visualViewport.addEventListener("resize", fit);
}
const protect = () => { try { const q = (window.top && window.top.QM) || QM; return q && q.protect && q.protect.active() ? q.protect : null; } catch (_) { return null; } };
setInterval(() => document.documentElement.classList.toggle("locked-chat", !!protect()), 700);

// ---------- helpers ----------
const isNearBottom = () => messagesDiv.scrollHeight - messagesDiv.scrollTop - messagesDiv.clientHeight < 80;
let ignoreScrollUntil = 0, lastOlderAt = 0;
/** An image/video finished loading. Newly loaded media in the live part follows the bottom; media in OLDER messages (prepended above)
 *  must never move the reader: the scroll position is compensated for the growth instead, and the bottom is not forced. */
function swapToAudio(v) {
  const ap = audioPlayer(v.currentSrc || v.src);
  (v.closest(".qp-video") || v).replaceWith(ap);
  return ap;
}
/** A picture with a small download button in its corner. */
function withDl(img, url, name) {
  const w = document.createElement("span"); w.className = "media-wrap";
  const b = document.createElement("button"); b.type = "button"; b.className = "media-dl"; b.setAttribute("aria-label", "Download"); b.title = "Download";
  b.innerHTML = icon("download", 16); b.onclick = e => { e.stopPropagation(); downloadMedia(url, name || ""); };
  w.append(img, b); return w;
}
/** What replaces a picture / video / audio that fails to load (often a format this device can't show): it can still be saved
 *  and opened in another app that can. */
function failedMedia(kind, url, name) {
  const b = document.createElement("div"); b.className = "media-failed";
  const t = document.createElement("div"); t.className = "mf-text";
  const h = document.createElement("strong"); h.textContent = `Can't show this ${kind}`;
  const d = document.createElement("span"); d.textContent = "It may be missing, or in a format this device can't display. You can still download it and open it in another app.";
  t.append(h, d);
  const dl = document.createElement("button"); dl.type = "button"; dl.className = "btn small primary"; dl.innerHTML = icon("download", 16) + " Download";
  dl.onclick = () => downloadMedia(url, name || "");
  b.append(t, dl);
  return b;
}
function onMedia(el) {
  if (el instanceof HTMLVideoElement && el.videoWidth === 0 && el.readyState >= 1) el = swapToAudio(el);   // an audio-only "video": just the player
  const msg = el && el.closest && el.closest(".msg");
  if (msg && msg.dataset.old) return;        // the size watcher below keeps the view still while older messages grow
  if (stick) scrollToBottom();
}
const scrollToBottom = () => { messagesDiv.scrollTop = messagesDiv.scrollHeight; stick = true; jumpBtn.classList.add("hidden"); };
const isText = m => !m.type || m.type === "text";
const previewOf = m => m.type === "audio" ? "🎵 Audio" : m.type === "image" ? "📷 Photo" : m.type === "video" ? "🎥 Video" : m.type === "file" ? "📎 " + (m.name || "File") : (m.text ?? m.content ?? "");
const fmtDur = ms => { const t = Math.max(0, Math.round(ms / 1000)), h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), sec = t % 60; return h ? `${h}h ${m}m` : m ? `${m}m ${sec}s` : `${sec}s`; };
const fmtExpiry = ts => new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
if (new URLSearchParams(location.search).has("panel")) document.documentElement.classList.add("panel");

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
  $("headAvatar").replaceChildren(avatarEl(title, customPhoto || (useOther ? profiles[0].pfp : ""), "avatar sm"));
  isGroup = participants.length > 2;
  $("groupPhotoBox").hidden = !isGroup;
  messagesDiv.classList.toggle("group", isGroup);
  baseSub = isGroup ? `${participants.length} members` : "";
  renderSub();
}

// A text / code file sent inside the message: a card with the first lines coloured, tap to open the viewer.
function fillCode(bubble, msg) {
  const lang = msg.lang || langOf(msg.name);
  let body = "";
  try { body = textOfData(msg.content); } catch (_) { bubble.textContent = "Couldn't read that file."; return; }
  const c = document.createElement("button"); c.type = "button"; c.className = "file-card code-card";
  c.innerHTML = `<span class="file-ic">${icon("file", 22)}</span><span class="file-meta"><span class="file-name"></span><span class="file-size"></span><span class="code-snip"></span></span>`;
  c.querySelector(".file-name").textContent = msg.name || "Text file";
  c.querySelector(".file-size").textContent = [typeof msg.size === "number" ? fmtBytes(msg.size) : "", lang, msg._enc ? "🔒" : "", "Tap to open"].filter(Boolean).join(" · ");
  c.querySelector(".code-snip").innerHTML = body.split("\n").slice(0, 4).map(l => `<span>${colorLine(l.replace(/\r$/, "").slice(0, 80), lang) || " "}</span>`).join("");
  c.addEventListener("click", () => { track("code_viewer_open", { lang }); openCode({ name: msg.name, text: body, lang }); });
  bubble.append(c);
}

// ---------- message rendering ----------
// Litterbox files: shown inline when possible, greyed out once they've expired (the message itself stays).
const AUTO_DECRYPT_MAX = 40 * 1024 * 1024;
async function fetchPlain(msg) {
  let buf;
  try { buf = await (await fetch(msg.url, { referrerPolicy: "no-referrer", credentials: "omit" })).arrayBuffer(); }
  catch (_) {
    const r = await fetch(PRIVATE ? msg.url : "fetch-file.php?t=" + encodeURIComponent(await auth.currentUser.getIdToken()) + "&u=" + encodeURIComponent(msg.url));
    if (!r.ok) throw new Error("download failed");
    buf = await r.arrayBuffer();
  }
  return new Blob([await E2E.decBytes(chatId, buf)], { type: msg.mime || "application/octet-stream" });
}
function fillFile(bubble, msg) {
  if (msg.kind === "code" && typeof msg.content === "string" && msg.content) { fillCode(bubble, msg); return; }
  const expired = typeof msg.expiresAt === "number" && Date.now() > msg.expiresAt;
  let url = isLitterUrl(msg.url) ? msg.url : null;
  if (msg._enc) {
    // The file on the host is encrypted: decrypt it here, then show/download the plain copy from a local blob.
    url = msg.blobUrl || null;
    if (!url && !expired && isLitterUrl(msg.url) && ["image", "video", "audio"].includes(msg.kind) && (msg.size || 0) <= AUTO_DECRYPT_MAX && !msg._decrypting) {
      msg._decrypting = true;
      fetchPlain(msg).then(b => { msg.blobUrl = URL.createObjectURL(b); msg._decrypting = false; bubble.replaceChildren(); fillFile(bubble, msg); onMedia(bubble); })
        .catch(() => { msg._decrypting = false; msg._decryptFailed = true; bubble.replaceChildren(); fillFile(bubble, msg); });
    }
  }
  const wrap = document.createElement("div");
  wrap.className = "file-wrap" + (expired ? " expired" : "");
  const kind = msg.kind || "file";
  const card = () => {
    const encPending = msg._enc && !url && !expired && isLitterUrl(msg.url);
    const c = document.createElement(url && !expired ? "a" : "div");
    c.className = "file-card";
    if (url && !expired) { c.href = url; c.target = "_blank"; c.rel = "noopener noreferrer"; c.download = msg.name || ""; }
    if (encPending) {
      c.style.cursor = "pointer"; c.title = "Decrypt and download";
      c.addEventListener("click", async () => {
        try {
          toast("Decrypting…", "info", 1500);
          const b = await fetchPlain(msg); msg.blobUrl = URL.createObjectURL(b);
          const a = document.createElement("a"); a.href = msg.blobUrl; a.download = msg.name || "file"; document.body.append(a); a.click(); a.remove();
        } catch (_) { toast("Couldn't decrypt that file.", "error"); }
      });
    }
    c.innerHTML = `<span class="file-ic">${icon("file", 22)}</span><span class="file-meta"><span class="file-name"></span><span class="file-size"></span></span>`;
    c.querySelector(".file-name").textContent = msg.name || "File";
    c.querySelector(".file-size").textContent = [typeof msg.size === "number" ? fmtBytes(msg.size) : "", msg._enc ? "🔒" : "", msg._decrypting ? "Decrypting…" : "", expired ? "Expired" : ""].filter(Boolean).join(" · ");
    return c;
  };
  if (url && !expired && kind === "image") {
    const img = new Image();
    img.className = "media"; img.alt = msg.name || "Image"; img.loading = "lazy"; img.referrerPolicy = "no-referrer";
    img.addEventListener("load", ev => onMedia(ev.target));
    img.addEventListener("error", () => { const f = failedMedia("image", url, msg.name); (img.closest(".media-wrap") || img).replaceWith(f); });
    img.addEventListener("click", () => openImage(url, { alt: msg.name || "" }));
    if (saverOn()) {                                                    // Data Saver: the picture is fetched when you tap it
      const g = gateNode("image", msg.name, () => { img.src = url; g.replaceWith(withDl(img, url, msg.name)); });
      wrap.append(g);
    } else { img.src = url; wrap.append(withDl(img, url, msg.name)); }
  } else if (url && !expired && kind === "video") {
    const vp = videoPlayer(url, { onLayout: onMedia });
    vp.video.addEventListener("error", () => vp.replaceWith(failedMedia("video", url, msg.name)));
    wrap.append(vp);
  } else if (url && !expired && kind === "audio") {
    const ap = audioPlayer(url, { wave: msg.wave, duration: msg.duration });
    ap.audio.addEventListener("error", () => ap.replaceWith(failedMedia("audio", url, msg.name)));
    wrap.append(ap);
  } else {
    wrap.append(card());
    if (expired && kind === "image") wrap.classList.add("ghost-image");
  }
  const note = document.createElement("div");
  note.className = "file-expiry";
  note.textContent = typeof msg.expiresAt === "number" ? (expired ? "Expired " : "Expires ") + fmtExpiry(msg.expiresAt) : "";
  bubble.append(wrap, note);
  bubble.classList.add("file-bubble");
}

function eventText(msg) {
  const name = u => peekProfile(u)?.displayName || "Someone";
  switch (msg.event) {
    case "call_start": return `📞 ${name(msg.fromUid)} started a call`;
    case "call_decline": return `📵 ${name(msg.fromUid)} declined the call`;
    case "call_end": return `📞 Call ended${typeof msg.duration === "number" ? " · " + fmtDur(msg.duration) : ""}`;
    case "chat_add": return `➕ ${name(msg.fromUid)} added ${name(msg.target)}`;
    case "chat_leave": return `👋 ${name(msg.fromUid)} left the chat`;
    case "enc_on": return `🔒 ${name(msg.fromUid)} turned on encryption for this chat`;
    case "enc_off": return `🔓 ${name(msg.fromUid)} turned off encryption for this chat`;
    case "chat_kick": return `🚫 ${name(msg.fromUid)} removed ${name(msg.target)}`;
    default: return msg.text || "";
  }
}

function buildEvent(key, msg) {
  const el = document.createElement("div");
  el.className = "msg-event";
  el.id = "msg-" + key;
  el.dataset.key = key;
  el.innerHTML = `<span class="ev-text"></span><span class="ev-time"></span><span class="readBy"></span>`;
  const paint = () => { el.querySelector(".ev-text").textContent = eventText(msg); };
  paint();
  el.querySelector(".ev-time").textContent = formatMsgTime(msg.timestamp);
  const ids = [msg.fromUid, msg.target].filter(Boolean);
  Promise.all(ids.map(getProfile)).then(paint);
  return el;
}
// ---------- @mentions (see js/mentions.js) ----------
const peopleNow = () => participants.filter(u => u !== me).map(u => { const p = peekProfile(u); return p && p.displayName ? { uid: u, name: p.displayName, pfp: p.pfp } : null; }).filter(Boolean);
function mentionPeople(msg) {
  const ids = msg.mentions && typeof msg.mentions === "object" ? Object.keys(msg.mentions) : [];
  return ids.map(u => { const p = peekProfile(u); return { uid: u, name: (u === me ? ownName : p && p.displayName) || "" }; });
}
let ownName = "";
function decorateMsg(bubble, msg) {
  decorate(bubble, mentionPeople(msg), me);
  const ids = msg.mentions && typeof msg.mentions === "object" ? Object.keys(msg.mentions) : [];
  if (ids.some(u => u !== me && !peekProfile(u))) Promise.all(ids.map(u => getProfile(u).catch(() => null))).then(() => { if (bubble.isConnected) decorate(bubble, mentionPeople(msg), me); });
}
function fillMessage(el, key, msg) {
  el.classList.toggle("enc", !!msg._enc);                   // encrypted messages get their own colour
  el.classList.toggle("mentions-me", !!(msg.mentions && typeof msg.mentions === "object" && msg.mentions[me]));      // someone @mentioned you
  const bubble = el.querySelector(".bubble");
  bubble.replaceChildren();
  bubble.classList.remove("media-bubble");
  if (msg.replyTo && msg.replyTo.key) bubble.append(quoteEl(msg.replyTo));

  if (msg._big && !msg.content) {
    lazyPlaceholder(bubble, key, msg);
  } else if (msg.type === "file") {
    fillFile(bubble, msg);
  } else if (msg.type === "audio") {
    const src = safeMediaUrl(msg.content || msg.text, "audio");
    if (!src) bubble.textContent = "Unsupported audio";
    else {
      const ap = audioPlayer(src, { wave: msg.wave, duration: msg.duration });
      ap.audio.addEventListener("error", () => ap.replaceWith(failedMedia("audio", src, "")));
      bubble.append(ap); bubble.classList.add("media-bubble");
    }
  } else if (msg.type === "image" || msg.type === "video") {
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
      img.addEventListener("load", ev => onMedia(ev.target));
      img.addEventListener("click", () => openImage(src, { name: "" }));
      img.addEventListener("error", () => { const w = img.closest(".media-wrap") || img; w.replaceWith(failedMedia("image", src, "")); });
      if (saverOn() && /^https?:/i.test(src)) {                         // Data Saver: only pictures that come over the network wait for a tap
        const g = gateNode("image", "", () => { img.src = src; g.replaceWith(withDl(img, src, "")); }); bubble.append(g);
      } else { img.src = src; bubble.append(withDl(img, src, "")); }
      bubble.classList.add("media-bubble");
    } else {
      const vp = videoPlayer(src, { onLayout: onMedia });
      vp.video.addEventListener("error", () => vp.replaceWith(failedMedia("video", src, "")));
      bubble.append(vp);
      bubble.classList.add("media-bubble");
    }
  } else {
    bubble.append(linkify(msg.text ?? msg.content ?? ""));
    if (!msg._locked) decorateMsg(bubble, msg);
    if (msg._locked) {      // can't be read yet: an info button says why and how to get the key
      const why = document.createElement("button"); why.type = "button"; why.className = "enc-why"; why.setAttribute("aria-label", "What's this?");
      why.innerHTML = icon("info", 16); why.onclick = e => { e.stopPropagation(); explainEncrypted(msg); };
      bubble.append(why);
    }
    if (!msg._locked) attachPreviews(bubble, msg.text ?? msg.content ?? "", { enc: !!msg._enc, onLayout: ev => onMedia(ev || bubble) });
  }

  el.querySelector(".time").textContent = formatMsgTime(msg.timestamp);
  el.querySelector(".edited").classList.toggle("hidden", !msg.editedAt);
}

function buildMessage(key, msg) {
  if (msg.type === "event") return buildEvent(key, msg);
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
    // A bot can post "as" someone else (a Discord user, say). Only trusted when the bot itself is the sender: people can't write these fields.
    const botMsg = isBotUid(msg.fromUid) && msg.botId === msg.fromUid;
    if (botMsg) el.classList.add("bot-msg");
    const apply = p => {
      const shown = (botMsg && msg.as && msg.as.name) || p.displayName, pic = (botMsg && msg.as && msg.as.pfp) || p.pfp;
      name.textContent = shown; av.replaceWith(avatarEl(shown, pic, "msg-avatar"));
      if (botMsg) {                                              // which bot really posted it, and where it came from
        const tag = document.createElement("span"); tag.className = "tag bot-tag"; tag.textContent = "BOT";
        tag.title = `Posted by the bot “${p.displayName}”${msg.src ? " via " + msg.src : ""}`;
        name.append(tag);
        if ((msg.as && msg.as.name) || msg.src) { const via = document.createElement("span"); via.className = "bot-via"; via.textContent = ` ${p.displayName}${msg.src ? " · " + msg.src : ""}`; name.append(via); }
      }
    };
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
    {   // others' messages get a "more" button too (Reply, Copy)
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "icon-btn msg-menu";
      btn.setAttribute("aria-label", "Message actions");
      btn.innerHTML = icon("more", 16);
      btn.addEventListener("click", e => { e.stopPropagation(); showMenu(key, btn); });
      row.append(btn);
    }
  }

  const foot = document.createElement("div");
  foot.className = "msg-foot";
  foot.innerHTML = `<span class="time"></span><span class="edited hidden">· edited</span><span class="readBy"></span>`;

  col.append(row, foot);
  el.append(col);
  fillMessage(el, key, msg);
  sizeWatch.observe(el);
  return el;
}

// Keeps the page from jumping when something in a message changes size later (link previews, pictures, videos, edits, reactions, the keyboard):
//  - at the bottom the view stays at the bottom (decided by what the USER did, never by a scroll event that the growth itself caused);
//  - anywhere else the message you are reading is the anchor: whatever happens above it, it stays exactly where it was on screen.
// (The browser's own scroll anchoring is switched off for .messages in the CSS: it would fight with this and move things twice.)
let anchorEl = null, anchorTop = 0, lastInput = 0, lastGrow = 0;
const noteInput = () => { lastInput = Date.now(); };
for (const t of ["wheel", "touchstart", "touchmove", "pointerdown", "keydown"]) messagesDiv.addEventListener(t, noteInput, { passive: true, capture: true });
function pickAnchor() {
  const top = messagesDiv.getBoundingClientRect().top;
  anchorEl = null;
  for (const el of messagesDiv.children) {
    if (!el.classList.contains("msg") || !el.offsetHeight) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom > top + 1) { anchorEl = el; anchorTop = r.top - top; return; }
  }
}
const msgHeights = new WeakMap();
function keepPlace() {
  if (stick) { scrollToBottom(); return; }
  if (!anchorEl || !anchorEl.isConnected) { pickAnchor(); return; }
  const d = anchorEl.getBoundingClientRect().top - messagesDiv.getBoundingClientRect().top - anchorTop;
  if (Math.abs(d) >= 1) { ignoreScrollUntil = Date.now() + 250; messagesDiv.scrollTop += d; }
  pickAnchor();
}
const sizeWatch = new ResizeObserver(entries => {
  let changed = false;
  for (const e of entries) {
    const h = e.target.offsetHeight, prev = msgHeights.get(e.target);
    msgHeights.set(e.target, h);
    if (prev != null && prev !== h) changed = true;
  }
  if (changed) { lastGrow = Date.now(); keepPlace(); }
});
// the chat area itself changing size (keyboard, composer growing, rotating): stay at the bottom if that is where you were
new ResizeObserver(() => { if (stick) scrollToBottom(); else pickAnchor(); }).observe(messagesDiv);

function appendLive(key, msg) {
  if (document.getElementById("msg-" + key)) return null;
  msgData.set(key, msg); idxAdd(key, msg);
  const el = buildMessage(key, msg);
  messagesDiv.insertBefore(el, typingRow);
  if (msg.type !== "event") { try { QM?.plugins?.emit("message", { chatId, key, fromMe: msg.fromUid === me, text: isText(msg) && !msg._locked ? String(msg.text ?? msg.content ?? "").slice(0, 2000) : null, type: msg.type || "text", time: msg.timestamp || null }); } catch (_) { /* a plugin must never break the chat */ } }
  if (msg.type !== "event") latestKey = key;          // system lines (call started, someone joined…) are never marked as read: the read marker only ever points at a real message
  return el;
}

// Offline data: the newest messages of this chat as they are stored in the database (encrypted ones stay encrypted), saved so the chat opens at once.
const rawByKey = new Map();
let persistT = null;
function persistPage() {
  if (!offlineOn() || !ready) return;
  clearTimeout(persistT);
  persistT = setTimeout(() => { const keys = [...rawByKey.keys()].sort().slice(-PAGE); ocSet("page:" + chatId, keys.map(k => [k, rawByKey.get(k)])); }, 2000);
}
function onAdded(snap) {
  const raw = snap.val();
  if (raw) { rawByKey.set(snap.key, raw); persistPage(); }
  if (!raw || document.getElementById("msg-" + snap.key) || pendingKeys.has(snap.key)) return;   // pending: finishJob swaps it in
  const pr = protect();
  if (pr && raw.type !== "event" && !(raw.timestamp >= pr.since())) return;
  addQ = addQ.then(async () => {
    if (document.getElementById("msg-" + snap.key) || pendingKeys.has(snap.key)) return;
    const msg = await hydrate(raw);
    const wasNear = isNearBottom();
    appendLive(snap.key, msg);
    renderReceipts();
    if (!ready) return;
    if (msg.fromUid === me || wasNear) scrollToBottom();
    else jumpBtn.classList.remove("hidden");
    maybeMarkRead();
  }).catch(() => {});
}

function onChanged(snap) {
  const raw = snap.val();
  if (!raw) return;
  rawByKey.set(snap.key, raw); persistPage();
  addQ = addQ.then(async () => {
    const msg = await hydrate(raw);
    msgData.set(snap.key, msg); idxAdd(snap.key, msg);
    const el = document.getElementById("msg-" + snap.key);
    if (el && msg.type !== "event") fillMessage(el, snap.key, msg); else if (!el) onAdded(snap);
  }).catch(() => {});
}

function onRemoved(snap) {
  rawByKey.delete(snap.key); persistPage();
  cacheDrop(chatId, snap.key);                          // its picture / clip / voice note is no longer worth keeping on this device
  msgData.delete(snap.key); searchIdx?.drop(snap.key);
  document.getElementById("msg-" + snap.key)?.remove();
  if (latestKey === snap.key) {
    const msgs = [...messagesDiv.querySelectorAll(".msg")].filter(e => msgData.get(e.dataset.key)?.type !== "event");
    latestKey = msgs.length ? msgs[msgs.length - 1].dataset.key : null;
  }
}

let lastPageShort = false;
async function loadOlder() {
  if (loadingOlder || reachedStart || oldestKey == null || protect()) return;
  if (Date.now() - lastOlderAt < 600) { setTimeout(loadOlder, 650); return; }      // never chain page after page
  loadingOlder = true;
  historyStatus.textContent = "Loading older messages…";
  try {
    const snap = await get(query(messagesRef, orderByKey(), endBefore(oldestKey), limitToLast(OLDER_PAGE)));
    const list = [];
    snap.forEach(s => { list.push(s); });
    if (!list.length) {
      reachedStart = true;
      historyStatus.textContent = "Beginning of the conversation";
    } else {
      const prevHeight = messagesDiv.scrollHeight;
      const anchor = messagesDiv.querySelector(".msg") || typingRow;
      const added = [];
      const plains = await Promise.all(list.map(x => hydrate(x.val())));
      for (const [i, s] of list.entries()) {
        if (document.getElementById("msg-" + s.key)) continue;
        const m = plains[i];
        msgData.set(s.key, m); idxAdd(s.key, m);
        const el = buildMessage(s.key, m);
        el.dataset.old = "1";
        messagesDiv.insertBefore(el, anchor);
        added.push(el);
      }
      oldestKey = list[0].key;
      ignoreScrollUntil = Date.now() + 400;
      messagesDiv.scrollTop += messagesDiv.scrollHeight - prevHeight;
      added.forEach(el => { el.dataset.h = el.offsetHeight; });
      // A short page does not prove we reached the start (the SDK can answer from a partial cache): only an empty page does.
      historyStatus.textContent = "";
      lastPageShort = list.length < OLDER_PAGE;
    }
  } catch (err) {
    console.error("Failed to load history", err);
    historyStatus.textContent = "Couldn't load older messages";
  }
  loadingOlder = false; lastOlderAt = Date.now();
  if (!reachedStart && lastPageShort && messagesDiv.scrollTop < 40) { lastPageShort = false; setTimeout(loadOlder, 0); return; }   // confirm the start with an empty page
  fillViewport();
}

// If the loaded messages don't even fill the screen there's nothing to scroll, so keep pulling older ones.
function fillViewport() {
  if (!reachedStart && !loadingOlder && ready && messagesDiv.scrollHeight <= messagesDiv.clientHeight + 60) setTimeout(loadOlder, 0);
}

messagesDiv.addEventListener("scroll", () => {
  const near = isNearBottom();
  // A scroll event right after something grew, with no finger/wheel/key involved, is the layout moving, not the reader leaving the bottom.
  if (!(stick && !near && Date.now() - lastGrow < 200 && Date.now() - lastInput > 400)) stick = near && !windowed;
  if (!stick) pickAnchor();
  if (stick && !windowed) jumpBtn.classList.add("hidden");
  if (windowed && messagesDiv.scrollHeight - messagesDiv.scrollTop - messagesDiv.clientHeight < 400) loadNewer();
  if (messagesDiv.scrollTop < 40 && Date.now() > ignoreScrollUntil) loadOlder();
  closeMenu();
}, { passive: true });
jumpBtn.addEventListener("click", () => { if (windowed) goLive(); else scrollToBottom(); });

// ---------- opened on one message (from search): the area around it, more when you scroll up or down ----------
const NEWER_PAGE = 30;
/** Leave the history view: show the latest messages and go live (the jump button, or sending a message). */
async function goLive() {
  if (!windowed) return; windowed = false; stick = true;
  { const u = new URL(location.href); u.searchParams.delete("at"); history.replaceState(null, "", u); }
  messagesDiv.querySelectorAll('[id^="msg-"]').forEach(e => e.remove());
  msgData.clear(); rawByKey.clear(); reachedStart = false; oldestKey = null; newestKey = null;
  historyStatus.textContent = "Loading messages…";
  try {
    const snap = await get(query(messagesRef, orderByKey(), limitToLast(PAGE)));
    const items = []; snap.forEach(x => { items.push(x); });
    historyStatus.textContent = "";
    if (items.length) oldestKey = items[0].key; else reachedStart = true;
    items.forEach(x => rawByKey.set(x.key, x.val()));
    const plains = await Promise.all(items.map(x => hydrate(x.val())));
    items.forEach((x, i) => appendLive(x.key, plains[i]));
    scrollToBottom(); jumpBtn.classList.add("hidden"); renderReceipts(); maybeMarkRead(); fillViewport();
    const live = query(messagesRef, orderByKey(), startAt(oldestKey ?? ""));
    onChildAdded(live, onAdded); onChildChanged(live, onChanged); onChildRemoved(live, onRemoved);
  } catch (_) { historyStatus.textContent = "Couldn't load the latest messages. Reload to try again."; }
}
async function loadNewer() {
  if (!windowed || loadingNewer || newestKey == null) return;
  loadingNewer = true;
  try {
    const snap = await get(query(messagesRef, orderByKey(), startAt(newestKey), limitToFirst(NEWER_PAGE + 1)));
    const list = []; snap.forEach(x => { if (x.key !== newestKey) list.push(x); });
    const plains = await Promise.all(list.map(x => hydrate(x.val())));
    for (const [i, x] of list.entries()) {
      rawByKey.set(x.key, x.val());
      if (document.getElementById("msg-" + x.key)) continue;
      msgData.set(x.key, plains[i]); idxAdd(x.key, plains[i]);
      const el = buildMessage(x.key, plains[i]); messagesDiv.insertBefore(el, typingRow); el.dataset.h = el.offsetHeight;
    }
    if (list.length) newestKey = list[list.length - 1].key;
    if (list.length < NEWER_PAGE) {                         // caught up with the present: from here on it is the normal live chat
      windowed = false; { const u = new URL(location.href); u.searchParams.delete("at"); history.replaceState(null, "", u); }
      const real = [...messagesDiv.querySelectorAll(".msg")].map(e => e.dataset.key).filter(k => msgData.get(k)?.type !== "event");
      latestKey = real.length ? real[real.length - 1] : null;
      const live = query(messagesRef, orderByKey(), startAt(newestKey ?? ""));
      onChildAdded(live, onAdded); onChildChanged(live, onChanged); onChildRemoved(live, onRemoved);
      jumpBtn.classList.add("hidden"); maybeMarkRead();
    }
  } catch (err) { console.warn("load newer", err); }
  loadingNewer = false;
}

// ---------- read receipts ----------
// When this page lives in the call's chat panel it stays loaded while the panel is closed; the call page tells us.
let panelHidden = false;
window.addEventListener("message", e => {
  if (e.origin !== location.origin || !e.data || e.data.qm !== "panel") return;
  panelHidden = !e.data.visible;
  if (!panelHidden) { maybeMarkRead(); scrollToBottom(); }
});
const IS_PANEL = new URLSearchParams(location.search).has("panel");
// Android app: tell the app that this chat was read / answered here, so a notification or bubble it left behind is refreshed (or removed).
let appSyncT = 0;
function appSync() {
  clearTimeout(appSyncT);
  appSyncT = setTimeout(() => { try { const a = window.QMApp || (window.top && window.top.QMApp); if (a && a.chatSync) a.chatSync(chatId); } catch (_) { /* not the app */ } }, 1200);
}
function maybeMarkRead() {
  if (!ready || !latestKey || document.hidden || panelHidden) return;
  try { if (window.frameElement && window.frameElement.hidden) return; } catch (_) { /* ignore */ }     // a parked chat (still uploading) isn't being looked at
  // the full-screen call covers this chat: nothing here counts as read (the call's own chat panel marks its messages itself)
  if (!IS_PANEL) { try { if (QM && QM.state && QM.state.call && QM.state.call.visible) return; } catch (_) { /* ignore */ } }
  if (String(lastMarked) === String(latestKey)) return;
  lastMarked = latestKey;
  set(ref(db, `${chatPath}/messageRead/${me}`), latestKey).then(appSync, () => {});
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) maybeMarkRead(); });
window.addEventListener("focus", maybeMarkRead);
setInterval(maybeMarkRead, 1500);   // also catches the call overlay being minimised/closed

// A small avatar under the last message each other member has read — on every message, not just ours,
// so in groups you can see exactly where everyone left off.
function renderReceipts() {
  messagesDiv.querySelectorAll(".readBy").forEach(el => { el.replaceChildren(); });
  const byKey = {};
  for (const [uid, key] of Object.entries(readReceipts)) {
    if (uid === me || !participants.includes(uid)) continue;
    (byKey[String(key)] ||= []).push(uid);
  }
  for (const [key, uids] of Object.entries(byKey)) {
    const el = document.getElementById("msg-" + key);
    const host = el && el.querySelector(".readBy");
    if (!host) continue;
    for (const u of uids) {
      const p = peekProfile(u);
      const av = avatarEl(p?.displayName || "?", p?.pfp || "", "avatar read-av");
      av.title = "Seen by " + (p?.displayName || "someone");
      host.append(av);
    }
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

/** Messages that were unreadable ("waiting for the key") get decrypted and redrawn where they are — no reload. */
async function refreshLocked() {
  for (const [key, m] of [...msgData]) {
    if (!m || !m._locked) continue;
    try {
      const raw = (await get(ref(db, `${chatPath}/messages/${key}`))).val();
      if (!raw) continue;
      const msg = await hydrate(raw);
      if (msg._locked && !!msg._lost === !!m._lost) continue;
      msgData.set(key, msg);
      const el = document.getElementById("msg-" + key);
      if (el) fillMessage(el, key, msg);
    } catch (_) { /* leave it locked */ }
  }
}

// ---------- message info: sent / delivered / read ----------
const PUSH_CHARS = "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz";
/** Firebase push ids start with the server-adjusted time they were made: that is when the database accepted the message. */
function keyTime(key) {
  if (!key || key.length < 8) return null;
  let t = 0;
  for (let i = 0; i < 8; i++) { const c = PUSH_CHARS.indexOf(key[i]); if (c < 0) return null; t = t * 64 + c; }
  return t > 1e12 && t < 4e12 ? t : null;
}
const fullTime = ts => new Date(ts).toLocaleString([], { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });
async function showInfo(key, msg) {
  const box = document.createElement("div"); box.className = "msg-info";
  const row = (label, value, sub) => {
    const r = document.createElement("div"); r.className = "mi-row";
    const l = document.createElement("span"); l.className = "mi-l"; l.textContent = label;
    const v = document.createElement("span"); v.className = "mi-v"; v.textContent = value;
    r.append(l, v);
    if (sub) { const s = document.createElement("small"); s.textContent = sub; v.append(document.createElement("br"), s); }
    box.append(r); return r;
  };
  row("✉️ Sent", msg.timestamp ? fullTime(msg.timestamp) : "—", "From the sender's device");
  // deliveredAt is written by the database itself (a server timestamp) the moment the message arrives; older messages fall back to the time inside their id
  let dt = msg.deliveredAt;
  if (!dt) { try { dt = (await get(ref(db, `${chatPath}/messages/${key}/deliveredAt`))).val(); } catch (_) { /* ignore */ } }
  const realDelivered = dt;
  dt = dt || keyTime(key);
  row("☁️ Delivered", dt ? fullTime(dt) : "Not yet", "Received by the server");
  if (msg.timestamp && realDelivered) {     // how long the message took to reach the server
    const ms = Math.max(0, Math.round(realDelivered - msg.timestamp));
    const r = row("⏱ Send delay", ms.toLocaleString() + " ms", "Sent → delivered (depends on both clocks)");
    r.classList.add("mi-delay", ms < 100 ? "good" : ms < 1000 ? "warn" : "bad");
  }
  const head = document.createElement("div"); head.className = "mi-head"; head.textContent = "Read by"; box.append(head);
  const others = participants.filter(u => u !== me && u !== msg.fromUid);
  await Promise.all(others.map(getProfile));
  if (!others.length) { const n = document.createElement("div"); n.className = "muted"; n.textContent = "Nobody else in this chat."; box.append(n); }
  for (const u of others) {
    const p = peekProfile(u), rk = readReceipts[u];
    const read = rk != null && String(rk) >= String(key);
    const r = row(p?.displayName || "Someone", read ? "Read" : "Not read yet");
    r.prepend(avatarEl(p?.displayName || "?", p?.pfp || "", "avatar sm"));
    r.classList.toggle("mi-unread", !read);
  }
  await notifyRows(box, key, msg, row);
  confirmDialog({ title: "Message info", node: box, okText: "Close", hideCancel: true });
}

/** "Notification": did the push go out for this message, and if not, why. The notification server writes pushLog/{chat}/{message}/{person};
 *  the sender sees everyone's, a recipient sees their own. */
function pushWhy(w) {
  w = String(w || "");
  if (/Unregistered|device removed|SenderIdMismatch|registration token/i.test(w)) return "Their device's notification registration had expired, so it was removed. They need to turn notifications on again on that device.";
  if (/Quota|exceed|rate|Unavailable|Internal/i.test(w)) return "The push service was busy or limiting requests. " + w;
  if (/Permission|Unauthenticated|credential|403|401/i.test(w)) return "The notification server isn't allowed to use the push service (check its service account). " + w;
  return w;
}
async function notifyRows(box, key, msg, row) {
  if (msg.type === "event") return;
  const mine = msg.fromUid === me;
  const who = (mine ? participants.filter(u => u !== me) : [me]).filter(u => !String(u).startsWith("bot_") && u !== msg.fromUid);
  if (!who.length) return;
  const head = document.createElement("div"); head.className = "mi-head"; head.textContent = "Notification"; box.append(head);
  if (Date.now() - (msg.timestamp || 0) > 3 * 86400000) { const n = document.createElement("div"); n.className = "muted"; n.textContent = "Notification logs are only kept for 3 days, so there is no record for this message anymore."; box.append(n); return; }
  const [srv, logs] = await Promise.all([
    import("./serverstatus.js").then(m => m.getServerStatus()).catch(() => null),
    Promise.all(who.map(u => get(ref(db, `pushLog/${chatId}/${key}/${u}`)).then(s => s.val()).catch(e => ({ __err: String((e && (e.code || e.message)) || e) }))))
  ]);
  await Promise.all(who.map(getProfile));
  // One short result per person; what each result means is explained once, below the list, and only for the results that appear.
  const legend = new Map();                                   // "icon label|explanation" -> names
  const note = (label, text, name) => { const k = label + "\u0001" + text; (legend.get(k) || legend.set(k, []).get(k)).push(name); };
  who.forEach((u, i) => {
    const p = peekProfile(u), l0 = logs[i], l = l0 && l0.__err ? undefined : l0, name = u === me ? "You" : (p?.displayName || "Someone");
    let value, cls = "";
    if (l && l.status === "sent" && !l.why) { value = "✅ Sent"; cls = "good"; note(value, "The push service accepted it for their device(s). Whether it shows up still depends on their device.", name); }
    else if (l && l.status === "sent") { value = "⚠️ Partly sent"; cls = "warn"; note(value, `Accepted for ${l.ok} device${l.ok === 1 ? "" : "s"}, but another one failed: ${pushWhy(l.why)}`, name); }
    else if (l && l.status === "skipped") { value = "Not needed"; note(value, "They had already read it or had the chat open.", name); }
    else if (l && l.status === "no_token") { value = "❌ Not sent"; cls = "bad"; note(value, "None of their devices is set up for notifications (they haven't turned them on, or signed out). They only see the message when they open the app.", name); }
    else if (l && l.status === "failed") { value = "❌ Not sent"; cls = "bad"; note(value, pushWhy(l.why) || "The push service refused it.", name); }
    else if (srv && srv.state === "private") { value = "Not tracked"; note(value, "A private server sends its own notifications and doesn't keep a record of them.", name); }
    else if (l0 && l0.__err) { value = "Unknown"; note(value, /permission/i.test(l0.__err) ? "The database refused to show the record. Publish the newest database.rules.json (new \"pushLog\" rule) in the Firebase console → Realtime Database → Rules." : "Couldn't read the record (" + l0.__err.slice(0, 80) + ").", name); }
    else if (srv && (srv.state === "offline" || srv.state === "never")) { value = "❌ Probably not sent"; cls = "bad"; note(value, srv.state === "never" ? "No notification server has been set up." : "The notification server isn't running right now, so it can't have sent (or logged) anything.", name); }
    else { value = "No record"; note(value, "The server hasn't logged it (yet): it may still be working on it, or the message was sent before results were logged.", name); }
    const r = row(name, value);
    r.prepend(avatarEl(p?.displayName || "?", p?.pfp || "", "avatar sm"));
    if (cls) r.classList.add("mi-notify", cls);
  });
  const key2 = document.createElement("div"); key2.className = "mi-legend";
  for (const [k, names] of legend) {
    const [label, text] = k.split("\u0001"), line = document.createElement("div");
    const who2 = names.length > 3 && legend.size > 1 ? ` (${names.slice(0, 3).join(", ")} +${names.length - 3})` : legend.size > 1 && names.length ? ` (${names.join(", ")})` : "";
    const b = document.createElement("b"); b.textContent = label;
    line.append(b, document.createTextNode(" — " + text + who2)); key2.append(line);
  }
  box.append(key2);
}

function explainEncrypted(msg) {
  if (msg && msg._lost) {
    confirmDialog({
      title: "🔒 This message is lost",
      message: "It was end-to-end encrypted, and the key that could unscramble it no longer exists.\n\nWhy: the chat key is never stored anywhere readable. It only lives wrapped inside each member's own keys, and every member either reset their keys or lost them (no recovery code, no other signed-in device). With nobody holding the key, nothing — not you, not the other members, not the site — can open these messages.\n\nWhat now: the chat's key was cleared, so anyone in the chat can turn encryption on again (with a brand-new key) or leave it off. New messages work normally. The lost ones stay in the history so you can see that they were sent and when.",
      okText: "Got it", hideCancel: true
    });
    return;
  }
  if (msg && msg._locked) {
    confirmDialog({
      title: "🔒 Waiting for the encryption key…",
      message: "This message is end-to-end encrypted, and this device doesn't have the chat's key yet, so it can't be unscrambled here.\n\nHow to get it:\n• Usually it arrives by itself: as soon as another member of the chat opens it on a device that has the key, the key is shared with this one. This message then unlocks on its own, no need to refresh.\n• Signed in on a new device? Enter your recovery code when the chat list asks for it (your code is under Account → Encryption on a device that already has it).\n• If you lost your recovery code and have no other device, older encrypted messages can't be recovered — new ones will work once a key is set up.",
      okText: "Got it", hideCancel: true
    });
    return;
  }
  confirmDialog({
    title: "🔒 Encrypted message",
    message: "A 🔒 next to the time means the message is end-to-end encrypted. They are scrambled on your device before they are sent, and only the people in this chat can unscramble them. Nobody else can read them — not the people who run this site, and not anyone looking at the database. Files and links in them are protected the same way.\n\nThe catch: previews and notifications on other devices can only show the text if that device has your encryption key, and if you lose your recovery code you can't read these messages on a new device. Turn encryption off or on for the whole chat in the chat options.",
    okText: "Got it", hideCancel: true
  });
}

// ---------- replies ----------
let replyingTo = null;
const replyBar = $("replyBar");
async function setReply(key) {
  const m = msgData.get(key);
  if (!m || m.type === "event") return;
  replyingTo = { key, uid: m.fromUid, text: String(m._locked ? "Message" : previewOf(m)).replace(/\s+/g, " ").slice(0, 120) };
  replyBar.classList.remove("hidden");
  $("rbName").textContent = m.fromUid === me ? "Replying to yourself" : "Replying to …";
  $("rbText").textContent = replyingTo.text;
  if (m.fromUid !== me) getProfile(m.fromUid).then(p => { if (replyingTo && replyingTo.key === key) $("rbName").textContent = "Replying to " + p.displayName; });
  msgInput.focus();
}
// ---------- search this chat ----------
// Every message shown here is remembered for searching (text only). Older, never-seen history is fetched as plain pages, only when the result list asks for it.
searchIdx = initChatSearch({
  $, msgData, chatId, nameOf: u => u === me ? "You" : (peekProfile(u)?.displayName || "Someone"),
  oldestLoaded: () => windowed ? null : oldestKey, atStart: () => reachedStart && !windowed,
  store: { get: k => ocGet(k).then(r => r && r.v), set: (k, v) => chatEncrypted || sawEnc ? Promise.resolve() : ocSet(k, v) },
  fetchOlder: async (before, n) => {
    const snap = await get(before == null ? query(messagesRef, orderByKey(), limitToLast(n)) : query(messagesRef, orderByKey(), endBefore(before), limitToLast(n)));
    const rows = []; snap.forEach(x => { rows.push(x); if (x.val() && x.val().enc) sawEnc = true; });
    return Promise.all(rows.map(async x => [x.key, await hydrate(x.val())]));
  },
  firstKey: async () => { const s = await get(query(messagesRef, orderByKey(), limitToFirst(1))); let k = null; s.forEach(x => { k = x.key; }); return k; },
  thumbOf: async (key, k) => {                       // a search result's small picture: this device's copy if there is one, else the message (and its media node) once
    if (saverOn()) return null;
    let m = msgData.get(key);
    if (!m || (!m.content && !m.url)) {
      const raw = (await get(ref(db, `${chatPath}/messages/${key}`))).val();
      if (!raw) return null;
      if (raw.big) { let body = await cacheGet(chatId, key); if (body == null) { body = (await get(ref(db, `${chatPath}/media/${key}`))).val(); if (typeof body === "string") cachePut(chatId, key, body); } if (typeof body !== "string") return null; m = raw.enc ? await openMessage(chatId, { ...raw, content: body }) : { ...raw, content: body }; }
      else m = await hydrate(raw);
    }
    if (m.type === "image" || m.type === "video") { const src = safeMediaUrl(m.content || m.text, m.type); return src ? { src, kind: m.type } : null; }
    if (m.type === "file" && (m.kind === "image" || m.kind === "video") && m.url && !m._enc && /^https:/.test(m.url)) return { src: m.url, kind: m.kind };
    return null;
  },
  members: () => peopleNow().map(p => ({ uid: p.uid, name: p.name, sub: "Tap to mention them" })),
  pins: () => pinList(), resolvePin: k => resolvePin(k),
  onPerson: (uid, name) => { const i = $("msgInput"); i.value = (i.value && !/\s$/.test(i.value) ? i.value + " " : i.value) + "@" + name + " "; i.focus(); i.dispatchEvent(new Event("input")); },
  jumpTo: searchJump
});
function searchJump(key) {
  {
    const t = document.getElementById("msg-" + key);
    if (t) { t.scrollIntoView({ block: "center", behavior: "smooth" }); t.classList.add("flash"); setTimeout(() => t.classList.remove("flash"), 1600); return; }
    // not on screen: open just that area of the history (the chat page reloads on it; scrolling up or down loads more)
    toast("Opening that part of the chat…", "info", 2000);
    const u = new URL(location.href); u.searchParams.set("at", key); location.replace(u);
  }
}

function clearReply() { replyingTo = null; replyBar.classList.add("hidden"); }
$("rbClose").onclick = clearReply;
function quoteEl(r) {
  const q = document.createElement("div");
  q.className = "reply-quote"; q.setAttribute("role", "button");
  const n = document.createElement("strong"), t = document.createElement("span");
  n.textContent = r.uid === me ? "You" : (peekProfile(r.uid)?.displayName || "…");
  if (r.uid !== me && !peekProfile(r.uid)) getProfile(r.uid).then(p => { n.textContent = p.displayName; });
  t.textContent = r.text || "";
  q.append(n, t);
  q.addEventListener("click", () => {
    const target = document.getElementById("msg-" + r.key);
    if (!target) { toast("That message is further up — scroll up to load it.", "info", 2500); return; }
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    target.classList.add("flash"); setTimeout(() => target.classList.remove("flash"), 1300);
  });
  return q;
}
document.addEventListener("keydown", e => { if (e.key === "Escape" && replyingTo) clearReply(); });

// ---------- composer ----------
function autosize() {
  msgInput.style.height = "auto";
  msgInput.style.height = Math.min(msgInput.scrollHeight, 140) + "px";
}

const mbox = attachMentionBox({ input: msgInput, people: peopleNow });          // "@" picker + highlight behind typed @names
attachSwipeReply({
  container: messagesDiv, iconHtml: icon("reply", 18),
  canReply: el => { const m = msgData.get(el.dataset.key); return !!m && m.type !== "event" && !el.classList.contains("pending"); },
  onReply: el => setReply(el.dataset.key)
});
msgInput.addEventListener("keydown", e => {
  // Enter sends on desktop; on touch devices Enter inserts a newline.
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && matchMedia("(pointer: fine)").matches) {
    e.preventDefault();
    composer.requestSubmit();
  }
});
sendBtn.addEventListener("mousedown", e => e.preventDefault()); // keep keyboard open on mobile

composer.addEventListener("submit", e => {
  e.preventDefault();
  const text = msgInput.value.trim();
  if (!text && !trayFiles.length) return;
  if (!text) { flushTray(); msgInput.focus(); return; }
  // "/name args": a plugin may have registered that command (Developer mode); if one did, it handles it and nothing is sent
  if (text[0] === "/" && window.top !== window) {
    let used = false; try { used = !!(window.top.QM && window.top.QM.plugins && window.top.QM.plugins.command && window.top.QM.plugins.command(text, chatId)); } catch (_) { used = false; }
    if (used) { msgInput.value = ""; mbox.refresh(); autosize(); msgInput.focus(); return; }
  }
  const mn = mentionsOf(text, peopleNow(), me);
  msgInput.value = "";
  mbox.refresh();
  autosize();
  clearTimeout(typingTimer);
  setTyping(false);
  flushTray();                                       // files and the message leave together
  startJob({ type: "text", text, mentions: mn.uids, everyone: mn.everyone });
  msgInput.focus();
});

// What the plugin host (js/plugins.js, Developer mode) can read and do in this chat. Same-origin frames call these directly.
window.__qmMsgs = () => [...messagesDiv.querySelectorAll(".msg[data-key]")].map(el => {
  const m = msgData.get(el.dataset.key);
  if (!m || m.type === "event") return null;
  const who = m.fromUid === me ? ownName : (m.botId && m.botId === m.fromUid && m.as && m.as.name) || (peekProfile(m.fromUid) || {}).displayName || "";
  const textual = isText(m) && !m._locked;
  return { key: el.dataset.key, fromMe: m.fromUid === me, from: who || "", text: textual ? String(m.text ?? m.content ?? "").slice(0, 2000) : null, type: m.type || "text", name: m.name ? String(m.name).slice(0, 120) : undefined,
    time: m.timestamp || null, replyTo: m.replyTo && m.replyTo.key || null, edited: !!m.editedAt, pending: el.classList.contains("pending") };
}).filter(Boolean);
window.__qmComposer = {
  get: () => msgInput.value,
  set: t => { msgInput.value = String(t); msgInput.dispatchEvent(new Event("input", { bubbles: true })); mbox.refresh(); autosize(); },
  focus: () => msgInput.focus(),
  send: (t, replyKey) => {
    const text = String(t).trim().slice(0, 4000); if (!text) return false;
    if (replyKey && msgData.has(replyKey)) setReply(replyKey);
    const mn = mentionsOf(text, peopleNow(), me);
    return !!startJob({ type: "text", text, mentions: mn.uids, everyone: mn.everyone });
  }
};

// ---------- sending: every outgoing message first shows up as a grey "pending" copy of what it will look like ----------
// A job owns that grey bubble. While it uploads/writes it shows progress; on failure it turns red with an alert button
// (Retry / Cancel / See error). A retry reuses the same message key, so it can never double-post.
const SEND_TIMEOUT = 20000;
const jobs = new Map();                 // id -> job
const pendingKeys = new Set();          // message keys whose real child_added is held back until the write is acknowledged
let jobSeq = 0;

// Tell the app shell which attachments are uploading in this chat: it keeps this page alive when you leave the chat, shows the indicator in the chat
// list, warns before the tab is closed and drives the app's upload notification.
let lastReport = "";
function reportUploads() {
  const list = [];
  for (const j of jobs.values()) {
    if (!j.file) continue;
    list.push({ id: j.id, name: String(j.file.name || "File").slice(0, 80), size: j.file.size || 0, pct: typeof j.progress === "number" ? Math.round(j.progress * 100) / 100 : null, state: j.state });
  }
  const key = JSON.stringify(list.map(j => [j.id, j.state, Math.floor((j.pct || 0) * 100)]));
  if (key === lastReport) return;
  lastReport = key;
  try { const q = !IS_PANEL && window.top !== window && window.top.QM; q && q.setUploads && q.setUploads(chatId, list); } catch (_) { /* standalone */ }
}
window.addEventListener("pagehide", () => { try { const q = !IS_PANEL && window.top !== window && window.top.QM; q && q.setUploads && q.setUploads(chatId, []); } catch (_) { /* ignore */ } });

// Files that ANOTHER page of the app is still uploading (the Android app keeps the page that was uploading when you closed it running in the
// background): show them here as pending messages with their progress, until the real message arrives.
const bgUploads = new Map();            // "key:id" -> { job, ts }
function syncBgUploads() {
  if (!me) return;
  let list = [];
  try { const q = window.top !== window && window.top.QM; list = (q && q.foreignUploads && q.foreignUploads(chatId)) || []; } catch (_) { list = []; }
  const seen = new Set();
  for (const j of list) {
    const k = j.key + ":" + j.id; seen.add(k);
    let b = bgUploads.get(k);
    if (!b) {
      const el = buildMessage("bg-" + k.replace(/[^\w-]/g, "_"), { fromUid: me, type: "text", text: "", timestamp: Date.now() });
      el.classList.add("pending");
      const btn = el.querySelector(".msg-menu"); if (btn) btn.hidden = true;
      const job = { id: "bg", spec: { type: "file", extra: { name: j.name, kind: "file" } }, file: { name: j.name, size: j.size || 0, type: "" }, state: "sending", progress: j.pct, error: null,
        localUrl: null, litter: true, el, btn: btn || document.createElement("button") };
      messagesDiv.insertBefore(el, typingRow);
      paintJob(job);
      b = { job }; bgUploads.set(k, b);
      if (stick) scrollToBottom();
    } else { b.job.progress = j.pct; paintJobProgress(b.job); }
  }
  for (const [k, b] of bgUploads) if (!seen.has(k)) { b.job.el.remove(); bgUploads.delete(k); }
}
setTimeout(syncBgUploads, 900); setInterval(syncBgUploads, 1500);

const buildPayload = (spec, timestamp) => ({
  ...(spec.type === "text" ? { fromUid: me, text: spec.text, timestamp }
  : spec.type === "file" ? { fromUid: me, type: "file", text: spec.extra.name, ...spec.extra, timestamp }
  : { fromUid: me, type: spec.type, content: spec.content, ...(spec.wave ? { wave: spec.wave, duration: spec.duration } : {}), timestamp }),
  ...(spec.reply ? { replyTo: spec.reply } : {}),
  ...(spec.type === "text" && spec.mentions && spec.mentions.length && !spec.everyone ? { mentions: Object.fromEntries(spec.mentions.map(u => [u, true])) } : {})      // only these people are notified
});

/** @param spec {type:'text'|'image'|'video'|'file', text?, content?, extra?} message to send
 *  @param opts {file?:File, prepare?:(job)=>Promise<spec>} */
function startJob(spec, opts = {}) {
  if (!requireVerified("send messages")) return null;
  spec = { ...spec };
  track("message_sent", { type: spec.type === "file" ? (spec.extra && spec.extra.kind === "code" ? "code" : "file") : (spec.type || "text"), reply: !!replyingTo, encrypted: !!chatEncrypted, group: participants.length > 2 });
  if (replyingTo) { spec.reply = replyingTo; clearReply(); }
  const job = { id: ++jobSeq, spec, file: opts.file || null, prepare: opts.prepare || null, state: "sending", progress: null, error: null,
    ref: null, ts: 0, localUrl: opts.file ? URL.createObjectURL(opts.file) : null, ctrl: null, cancelled: false, litter: false };
  jobs.set(job.id, job);
  const fake = { fromUid: me, type: spec.type, text: spec.text, content: spec.content, timestamp: Date.now(), replyTo: spec.reply };
  job.el = buildMessage("job-" + job.id, fake);
  job.el.classList.add("pending");
  const old = job.el.querySelector(".msg-menu");
  const btn = old.cloneNode(true);                   // drop the real-message menu handler
  old.replaceWith(btn);
  btn.addEventListener("click", e => { e.stopPropagation(); showJobMenu(job, btn); });
  job.btn = btn;
  messagesDiv.insertBefore(job.el, typingRow);
  paintJob(job);
  scrollToBottom();
  runJob(job);
  reportUploads();
  return job;
}

function paintJob(job) {
  const el = job.el, bubble = el.querySelector(".bubble"), failed = job.state === "error";
  el.classList.toggle("failed", failed);
  el.classList.toggle("pending", !failed);
  job.btn.innerHTML = icon(failed ? "alert" : "more", 16);
  job.btn.classList.add("job-btn");
  job.btn.classList.toggle("job-err", failed);
  job.btn.setAttribute("aria-label", failed ? "Message failed — options" : "Sending — options");
  const spec = job.spec, lit = job.litter || spec.type === "file";
  bubble.replaceChildren();
  bubble.classList.remove("media-bubble", "file-bubble");
  const src = job.localUrl || (spec.type === "image" || spec.type === "video" ? safeMediaUrl(spec.content, spec.type) : null);
  const kind = lit ? (spec.extra?.kind || kindOf(job.file?.type)) : spec.type;
  if (spec.type === "text") {
    bubble.append(linkify(spec.text));
    decorate(bubble, peopleNow().filter(p => (spec.mentions || []).includes(p.uid)), me);
  } else if (src && kind === "image") {
    const img = new Image(); img.className = "media"; img.alt = "Sending image"; img.referrerPolicy = "no-referrer";
    img.addEventListener("load", ev => onMedia(ev.target));
    img.src = src; bubble.append(img); bubble.classList.add("media-bubble");
  } else if (src && kind === "video") {
    const v = document.createElement("video"); v.className = "media"; v.muted = true; v.preload = "metadata"; v.playsInline = true;
    v.addEventListener("loadedmetadata", ev => onMedia(ev.target));
    v.src = src; bubble.append(v); bubble.classList.add("media-bubble");
  } else {
    const c = document.createElement("div");
    c.className = "file-card";
    c.innerHTML = `<span class="file-ic">${icon("file", 22)}</span><span class="file-meta"><span class="file-name"></span><span class="file-size"></span></span>`;
    c.querySelector(".file-name").textContent = job.file?.name || spec.extra?.name || "File";
    c.querySelector(".file-size").textContent = job.file ? fmtBytes(job.file.size) : "";
    const w = document.createElement("div"); w.className = "file-wrap"; w.append(c);
    bubble.append(w); bubble.classList.add("file-bubble");
  }
  // Litterbox uploads: percent (or "Uploading…") sits where the expiry text will go once it's sent.
  job.note = null;
  if (lit) {
    const bar = document.createElement("div"); bar.className = "up-bar"; bar.innerHTML = "<i></i>";
    const note = document.createElement("div"); note.className = "file-expiry up-note";
    bubble.append(bar, note);
    job.bar = bar; job.note = note;
  }
  paintJobProgress(job);
}

function paintJobProgress(job) {
  reportUploads();
  const failed = job.state === "error", uploading = job.progress !== "sending" && (job.litter || job.spec.type === "file") && !job.spec.extra?.url;
  const foot = job.el.querySelector(".time");
  const pct = typeof job.progress === "number" ? Math.floor(job.progress * 100) : null;
  const waiting = job.state === "waiting";
  if (foot) foot.textContent = failed ? "Failed to send" : waiting ? "Waiting for connection…" : (uploading ? "Uploading…" : "Sending…");
  if (job.note) job.note.textContent = failed ? (uploading ? "Upload failed" : "Couldn't send") : waiting ? "Waiting for connection…" : uploading ? (pct == null ? "Uploading…" : `Uploading… ${pct}%`) : "Sending…";
  if (job.bar) {
    job.bar.classList.toggle("indet", !failed && uploading && pct == null);
    job.bar.hidden = failed || !uploading;
    job.bar.firstChild.style.width = (pct ?? 0) + "%";
  }
}

async function runJob(job) {
  if (windowed) await goLive();                           // sending from the history view: back to the present first
  job.state = "sending"; job.error = null;
  job.ctrl = new AbortController();
  paintJob(job);
  try {
    if (job.prepare) {
      const spec = await job.prepare(job);
      if (job.cancelled) return;
      job.spec = spec;
      job.prepare = null;                                // cached: a retry goes straight to the write
      if (spec.type === "file") job.litter = true;
    }
    job.progress = "sending";
    paintJob(job);
    // A slow connection is not a failed send: the database keeps the write and sends it as soon as it can (and the finished write still completes this
    // bubble — see writeJob). So after a while the bubble just says "waiting for connection"; only a real refusal (no permission, bad data) is a failure.
    const slow = setTimeout(() => { if (jobs.has(job.id) && job.state === "sending") { job.state = "waiting"; paintJob(job); } }, SEND_TIMEOUT);
    try { await writeJob(job); } finally { clearTimeout(slow); }
  } catch (err) {
    if (job.cancelled || err.aborted || !jobs.has(job.id)) return;
    failJob(job, err);
  }
}

let srvOff = 0;                                         // how far this device's clock is from the database's
try { onValue(ref(db, ".info/serverTimeOffset"), s => { srvOff = s.val() || 0; }); } catch (_) { /* ignore */ }

async function writeJob(job) {
  job.ref ||= push(messagesRef);
  job.ts ||= Date.now() + srvOff;                     // the database's clock, not this device's, so "sent" and "delivered" are measured on the same clock
  const payload = buildPayload(job.spec, job.ts), key = job.ref.key;
  const sealIt = canSeal();                                                           // without the chat key this device can't encrypt: the message goes out readable (the banner says so)
  job.key = key; job.payload = sealIt ? { ...payload, _enc: true } : payload;                         // the plain version: what the UI shows once it's sent
  let wire = payload, last = { fromUid: me, text: previewOf(payload), timestamp: job.ts, id: key };
  if (sealIt) {
    wire = await sealPayload(chatId, payload);
    last = { fromUid: me, text: await sealPreview(chatId, previewOf(payload)), enc: true, timestamp: job.ts, id: key };
  }
  pendingKeys.add(key);
  let bigBody = null;
  if ((wire.type === "image" || wire.type === "video" || wire.type === "audio") && typeof wire.content === "string" && wire.content.length > BIG_MIN) {
    bigBody = wire.content; wire = { ...wire, content: "", big: true };
    cachePut(chatId, key, bigBody);                                                   // the sender never needs to download its own picture
  }
  const multi = {
    [`${chatPath}/messages/${key}`]: { ...wire, deliveredAt: serverTimestamp() },        // "delivered": stamped by the database when it arrives
    [`${chatPath}/lastMessage`]: last
  };
  if (bigBody != null) multi[`${chatPath}/media/${key}`] = bigBody;
  // "Something new" ping for every other member: the app's single live stream (live/{uid}) wakes up and shows the notification.
  // A message that @mentions people only pings (= notifies) those people; one without a mention pings everybody.
  const only = payload.mentions && typeof payload.mentions === "object" ? Object.keys(payload.mentions) : null;
  for (const u of participants) if (u !== me && (!only || only.includes(u))) multi[`live/${u}/pings/${chatId}`] = { id: key, ts: job.ts, from: me, ...(only ? { mention: true } : {}) };
  const p = update(ref(db), multi);
  p.then(() => { appSync(); if (jobs.has(job.id) && !job.cancelled) finishJob(job); }, () => {});
  return p;
}

function finishJob(job) {
  jobs.delete(job.id);
  reportUploads();
  pendingKeys.delete(job.key);
  if (job.localUrl) URL.revokeObjectURL(job.localUrl);
  job.el.remove();
  closeMenu();
  if (!document.getElementById("msg-" + job.key)) {
    msgData.set(job.key, job.payload);
    appendLive(job.key, job.payload);
    renderReceipts();
  }
  scrollToBottom();
  maybeMarkRead();
}

function failJob(job, err) {
  console.error("Send failed", err);
  job.state = "error";
  job.error = (err && err.message) || String(err);
  paintJob(job);
  reportUploads();
  const what = job.spec.type === "text" ? "Message" : "File";
  toast(`${what} failed to send: ${friendlyError(job.error)}`, "error", 6000);
}

const friendlyError = m => /permission_denied/i.test(m) ? (isVerified() ? "you don't have permission to post here." : "verify your email first.") : String(m).replace(/^Error:\s*/, "").slice(0, 140);

function cancelJob(job) {
  job.cancelled = true;
  job.ctrl?.abort();
  jobs.delete(job.id);
  reportUploads();
  if (job.key) { pendingKeys.delete(job.key); if (job.ref) remove(job.ref).catch(() => {}); }  // in case a timed-out write lands later
  if (job.localUrl) URL.revokeObjectURL(job.localUrl);
  job.el.remove();
}

function showJobMenu(job, btn) {
  const wasOpen = btn.classList.contains("open");
  closeMenu();
  if (wasOpen) return;
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
  if (job.state === "error" || job.state === "waiting") {
    add("Retry", "send", () => runJob(job));
    if (job.state === "error") add("See error", "alert", () => alertDialog({ title: "Why it failed", message: job.error || "Unknown error" }));
  }
  add(job.state === "error" ? "Cancel" : "Cancel sending", "close", () => cancelJob(job), true);
  menuEl.classList.remove("hidden");
  const r = btn.getBoundingClientRect(), m = menuEl.getBoundingClientRect();
  menuEl.style.left = Math.min(Math.max(8, r.right - m.width), innerWidth - m.width - 8) + "px";
  let top = r.bottom + 4;
  if (top + m.height > innerHeight - 8) top = Math.max(8, r.top - m.height - 4);
  menuEl.style.top = top + "px";
}

// Used by anything that just needs "send this now" semantics (e.g. the link dialog).
function sendMessage(spec) { return startJob(spec); }

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
  add("Info", "info", () => showInfo(key, msg));
  if (!msg._locked) add("Reply", "send", () => { track("message_action", { action: "reply" }); setReply(key); });
  if (isText(msg)) {
    add("Copy", "copy", () => copyText(msg.text ?? msg.content ?? ""));
    if (msg.fromUid === me) add("Edit", "more", () => editMessage(key));
  }
  if (!msg._locked) add(pinsMap[key] ? "Unpin" : "Pin", "pin", () => togglePin(key));
  if (msg.fromUid === me) add("Delete", "close", () => { track("message_action", { action: "delete" }); deleteMessage(key); }, true);
  if (msg._enc) add("What's this?", "info", () => explainEncrypted(msg));
  try {                                   // choices added by plugins (Developer mode)
    const q = window.top !== window && window.top.QM;
    const info = { chatId, key, fromMe: msg.fromUid === me, text: isText(msg) && !msg._locked ? String(msg.text ?? msg.content ?? "").slice(0, 2000) : null, type: msg.type || "text", time: msg.timestamp || null };
    for (const it of (q && q.plugins && q.plugins.menuItems ? q.plugins.menuItems(info) : [])) add(it.label, ["info", "send", "copy", "close", "more"].includes(it.icon) ? it.icon : "more", () => q.plugins.menuClick(it.plugin, it.id, info), it.danger);
  } catch (_) { /* a plugin must never break the menu */ }
  if (devOn()) add("Developer info", "more", () => showMessageDev(key, msg));

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
  if (!text || text === msg.text || msg._locked) return;
  try {
    // Keep the original timestamp so the message doesn't jump in the ordering.
    const stored = msg._enc ? await sealPreview(chatId, text) : text;
    await update(ref(db, `${chatPath}/messages/${key}`), { text: msg._enc ? await E2E.encText(chatId, text) : stored, editedAt: Date.now() });
    if (await isLastMessage(key, msg)) await update(lastRef, msg._enc ? { text: stored, enc: true, id: key } : { text, id: key });
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
    await update(ref(db), { [`${chatPath}/messages/${key}`]: null, ...(msg && (msg.type === "image" || msg.type === "video" || msg.type === "audio") ? { [`${chatPath}/media/${key}`]: null } : {}) });
    cacheDrop(chatId, key);
    if (msg && (msg._enc || msg.enc)) dropKeyIfUnused();
    if (wasLast) {
      // Point the chat-list preview at the previous message instead of the deleted one.
      let prev = null;
      (await get(query(messagesRef, orderByChild("timestamp"), limitToLast(1)))).forEach(s => { prev = { key: s.key, ...s.val() }; });
      await set(lastRef, prev
        ? { fromUid: prev.fromUid, text: prev.enc && prev.type !== "file" && prev.type !== "image" && prev.type !== "video" ? prev.text : prev.enc ? await sealPreview(chatId, prev.type === "image" ? "📷 Photo" : prev.type === "video" ? "🎥 Video" : "📎 File") : previewOf(prev), ...(prev.enc ? { enc: true } : {}), timestamp: prev.timestamp, id: prev.key, notifSent: true }
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
$("lightbox").addEventListener("click", () => $("lightbox").close());

$("attachBtn").onclick = () => { $("mediaUrl").value = ""; attachDialog.showModal(); };
$("attachClose").onclick = () => attachDialog.close();
$("pickFileBtn").onclick = () => $("fileInput").click();
$("pickCameraBtn").onclick = () => { attachDialog.close(); openCamera(); };
// Camera shots still ask first; files chosen from the device wait in the tray above the message box and go out together with the text.
$("cameraInput").addEventListener("change", e => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  attachDialog.close();
  confirmFile(file).then(ok => { if (ok) sendFile(file); });
});
$("fileInput").addEventListener("change", e => {
  const files = [...e.target.files];
  e.target.value = "";
  attachDialog.close();
  addToTray(files);
});

const tray = $("tray"), trayFiles = [];
const TRAY_MAX = 10;
function addToTray(files) {
  for (const f of files) {
    if (trayFiles.length >= TRAY_MAX) { toast(`Up to ${TRAY_MAX} files at a time.`, "info"); break; }
    trayFiles.push({ file: f, url: /^(image|video)\//.test(f.type || "") ? URL.createObjectURL(f) : null });
  }
  paintTray();
  msgInput.focus();
}
function paintTray() {
  tray.hidden = !trayFiles.length;
  tray.replaceChildren(...trayFiles.map((it, i) => {
    const f = it.file, t = f.type || "", chip = document.createElement("div"); chip.className = "tray-chip";
    let thumb;
    if (it.url && t.startsWith("image/")) { thumb = new Image(); thumb.alt = ""; thumb.src = it.url; }
    else if (it.url) { thumb = document.createElement("video"); thumb.muted = true; thumb.preload = "metadata"; thumb.src = it.url + "#t=0.1"; }
    else { thumb = document.createElement("span"); thumb.className = "tray-ic"; thumb.innerHTML = icon("file", 20); }
    const meta = document.createElement("span"); meta.className = "tray-meta";
    const inline = t.startsWith("image/") || ((t.startsWith("video/") || t.startsWith("audio/")) && f.size <= MAX_VIDEO_BYTES) || inlineText(f);
    const nm = document.createElement("b"); nm.textContent = f.name || "File";
    const sz = document.createElement("small"); sz.textContent = fmtBytes(f.size) + (inline ? "" : " · uploads to file host");
    meta.append(nm, sz);
    const x = document.createElement("button"); x.type = "button"; x.className = "tray-x"; x.setAttribute("aria-label", "Remove " + (f.name || "file")); x.innerHTML = icon("close", 14);
    x.onclick = () => { if (it.url) URL.revokeObjectURL(it.url); trayFiles.splice(trayFiles.indexOf(it), 1); paintTray(); };
    chip.append(thumb, meta, x);
    return chip;
  }));
}
/** Send everything in the tray (each file is its own message; none are grouped). Returns how many went out. */
function flushTray() {
  const items = trayFiles.splice(0), keep = replyingTo;
  track("tray_send", { files: bucket(items.length) });
  replyingTo = null;                                  // a reply belongs to the message, not to the files sent beside it
  for (const it of items) { if (it.url) setTimeout(() => URL.revokeObjectURL(it.url), 60000); sendFile(it.file); }
  replyingTo = keep;
  paintTray();
  return items.length;
}

// "Send this file?": every file picked from the device is shown (name, size, preview, where it goes) before anything is uploaded.
async function confirmFile(file) {
  const t = file.type || "", box = document.createElement("div"); box.className = "send-prev";
  const url = URL.createObjectURL(file);
  let el = null;
  if (t.startsWith("image/")) { el = new Image(); el.alt = "Preview"; el.src = url; }
  else if (t.startsWith("video/")) { el = document.createElement("video"); el.controls = true; el.muted = true; el.preload = "metadata"; el.playsInline = true; el.src = url; }
  else if (t.startsWith("audio/")) { el = document.createElement("audio"); el.controls = true; el.src = url; }
  if (el) box.append(el);
  const nm = document.createElement("div"); nm.className = "nm"; nm.textContent = file.name || "File";
  const meta = document.createElement("div"); meta.className = "hint"; meta.textContent = `${fmtBytes(file.size)}${t ? " · " + t : ""}`;
  const where = document.createElement("div"); where.className = "hint";
  const inline = t.startsWith("image/") || ((t.startsWith("video/") || t.startsWith("audio/")) && file.size <= MAX_VIDEO_BYTES);
  where.textContent = inline ? "It will be sent directly in the chat." : "This file is too big or not a photo / short clip, so it will be uploaded to a file hosting service (Account → File hosting) and the link will expire after a while.";
  box.append(nm, meta, where);
  const ok = await confirmDialog({ title: "Send this file?", node: box, okText: "Send" });
  URL.revokeObjectURL(url);
  return ok;
}

$("sendLinkBtn").onclick = async () => {
  const url = $("mediaUrl").value.trim();
  if (!/^https?:\/\/\S+$/i.test(url)) return toast("Enter a full http(s) link.", "error");
  const type = /\.(mp3|wav|m4a|aac|flac|opus|oga)(\?|#|$)/i.test(url) ? "audio" : /\.(mp4|webm|mov|m4v|ogv|ogg)(\?|#|$)/i.test(url) ? "video" : "image";
  attachDialog.close();
  sendMessage({ type, content: url });
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
    // Smallest picture that still looks good: WebP where the browser can make one (about 30% smaller than JPEG), and the first size/quality that
    // fits under ~300 KB is used (storage and every download scale with this); only if none does, the smallest result below the hard limit.
    const TARGET = 300 * 1024;
    let best = null;
    for (const [dim, q] of [[1280, 0.72], [1100, 0.62], [900, 0.55], [720, 0.5], [560, 0.45]]) {
      const scale = Math.min(1, dim / Math.max(bmp.width, bmp.height));
      const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(bmp, 0, 0, w, h);
      let url = canvas.toDataURL("image/webp", q);
      if (!url.startsWith("data:image/webp")) url = canvas.toDataURL("image/jpeg", q);
      if (!best || url.length < best.length) best = url;
      if (url.length <= TARGET) return url;
    }
    if (best && best.length <= LIMIT) return best;
  } finally { bmp.close?.(); }
  throw new Error("That image is too large even after resizing.");
}

const TOO_BIG = "That file is too big to send directly, so it's being uploaded to a file hosting service. It will expire after a while.";
const OTHER = "Files are uploaded to a file hosting service and expire after a while (see Account → File hosting).";

// Mode "ask me every time": which service should this file go to?
async function pickHost(list) {
  const box = document.createElement("div"); box.className = "host-pick";
  list.forEach(({ host, ttl }, i) => {
    const l = document.createElement("label");
    const r = document.createElement("input"); r.type = "radio"; r.name = "qm-host"; r.value = host.id; r.checked = i === 0;
    const t = document.createElement("span"); const b = document.createElement("strong"); b.textContent = host.name;
    const sm = document.createElement("small"); sm.textContent = `Keeps the file ${fmtTtl(ttl)} · up to ${fmtLimit(host.maxBytes)}`;
    t.append(b, sm); l.append(r, t); box.append(l);
  });
  const ok = await confirmDialog({ title: "Where should this file go?", message: "Pick a file hosting service. If it fails, the next ones you've turned on are tried.", node: box, okText: "Upload" });
  if (!ok) return null;
  const id = box.querySelector("input:checked")?.value;
  return (list.find(x => x.host.id === id) || list[0]).host;
}

async function litterSpec(job, why) {
  const file = job.file;
  const sealed = canSeal();
  job.litter = true;
  if (!job.noticed) { job.noticed = true; toast(why, "info", 7000); }
  paintJob(job);
  let up = file;
  if (sealed) {
    if (file.size > 200 * 1024 * 1024) throw new Error("Encrypted files can be up to 200 MB.");
    up = new File([await E2E.encBytes(chatId, await file.arrayBuffer())], "x.bin", { type: "application/octet-stream" });
  }
  const wv = (file.type || "").startsWith("audio/") ? await waveFromFile(file) : null;      // the waveform travels with the message
  let info;
  try {
    info = await uploadToHosts(up, {
      onProgress: f => { job.progress = f; paintJobProgress(job); }, signal: job.ctrl.signal, relayMax: await relayMax(), choose: pickHost,
      onSwitch: (a, b, e) => toast(`${a.name} didn't work (${friendlyError((e && e.message) || "error")}). Trying ${b.name}…`, "info", 5000)
    });
  } catch (e) { if (e.aborted && !job.cancelled) cancelJob(job); throw e; }
  if (wv) Object.assign(info, wv);
  if (sealed) Object.assign(info, { name: file.name || "File", size: file.size, mime: file.type || "application/octet-stream", kind: kindOf(file.type) });
  return { type: "file", extra: info };
}

// Every file becomes a job: it shows a grey preview straight away, and the work of resizing/uploading happens inside it.
const inlineText = f => isTextFile(f) && f.size <= MAX_TEXT_BYTES;
function sendFile(file) {
  const t = file.type || "";
  const prepare = async job => {
    if (t.startsWith("image/")) {
      let dataUrl = null;
      try { dataUrl = await prepareImage(file); } catch (_) { /* too large for inline → Litterbox */ }
      return dataUrl ? { type: "image", content: dataUrl } : litterSpec(job, TOO_BIG);
    }
    if (t.startsWith("video/")) {
      return file.size > MAX_VIDEO_BYTES ? litterSpec(job, TOO_BIG) : { type: "video", content: await readAsDataURL(file) };
    }
    if (t.startsWith("audio/") && file.size <= MAX_AUDIO_BYTES) return { type: "audio", content: await readAsDataURL(file), ...(await waveFromFile(file) || {}) };
    if (inlineText(file)) {                       // text / code: travels inside the message (a data link), opened by the built-in viewer
      const dataUrl = await readAsDataURL(new Blob([await file.arrayBuffer()], { type: "text/plain;charset=utf-8" }));
      return { type: "file", extra: { name: file.name || "file.txt", size: file.size, mime: "text/plain", kind: "code", lang: langOf(file.name), content: dataUrl } };
    }
    return litterSpec(job, OTHER);
  };
  // Until prepare() decides, give the placeholder the right look: images/videos preview, anything else is a file card.
  const guess = t.startsWith("image/") ? "image" : t.startsWith("video/") ? "video" : t.startsWith("audio/") && file.size <= MAX_AUDIO_BYTES ? "audio" : "file";
  const code = guess === "file" && inlineText(file);
  return startJob({ type: guess, extra: guess === "file" ? { name: file.name || "File", kind: code ? "code" : kindOf(t) } : undefined }, { file, prepare });
}

// Paste an image straight from the clipboard (with a confirmation preview). Works from the browser's paste, and from the
// Android keyboard's image / clipboard / GIF suggestions (the app hands those over through window.__qmPasteImage).
async function pasteFile(file) {
  if (!file || !/^image\//.test(file.type || "")) return;
  const objUrl = URL.createObjectURL(file);
  const preview = new Image();
  preview.src = objUrl;
  preview.alt = "Pasted image";
  preview.style.cssText = "max-width:100%;max-height:240px;border-radius:12px;align-self:center";
  const ok = await confirmDialog({ title: "Send this image?", node: preview, okText: "Send" });
  URL.revokeObjectURL(objUrl);
  if (ok) sendFile(file);
}
msgInput.addEventListener("paste", e => {
  const cd = e.clipboardData;
  const item = [...(cd?.items || [])].find(i => i.type.startsWith("image/"));
  const file = item?.getAsFile() || [...(cd?.files || [])].find(f => f.type.startsWith("image/"));
  if (!file) return;
  e.preventDefault();
  pasteFile(file);
});
window.__qmPasteImage = (mime, b64, name) => {
  try {
    const bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const ext = (/\/(\w+)/.exec(mime) || [])[1] || "png";
    pasteFile(new File([bytes], name || "pasted." + ext, { type: mime }));
  } catch (_) { toast("Couldn't paste that image.", "error"); }
};

// ---------- chat options ----------
// One menu for search and chat settings (like Discord): the search dialog has two panes, Search and Settings.
const hub = $("searchDialog");
function showPane(p) {
  hub.dataset.pane = p;
  for (const b of $("hubTabs").children) b.classList.toggle("on", b.dataset.p === p);
  if (p === "settings") { $("chatNameInput").value = customName; $("chatPhotoInput").value = customPhoto; renderParticipants(); }
  else if (p === "search") { searchIdx && searchIdx.open(); }
  else paintPinsPane();
}
const optionsDialog = {
  get open() { return hub.open && hub.dataset.pane === "settings"; },
  showModal() { if (!hub.open) hub.showModal(); showPane("settings"); },
  close() { hub.close(); }
};
wireDialog(hub);
$("hubTabs").addEventListener("click", e => { const b = e.target.closest("button[data-p]"); if (b) { track("chat_menu_tab", { tab: b.dataset.p }); showPane(b.dataset.p); } });
let participantsRenderToken = 0;

/** Everything known about one link in a message, plus a button that fetches its preview right now. */
async function urlCard(url, enc) {
  const i = await inspectUrl(url, { enc }), pt = i.parts || {};
  const sc = i.sharedCache && typeof i.sharedCache === "object" ? i.sharedCache : null;
  const d = sc && sc.data;
  const card = devCard("Link", [
    ["URL", url], ["Kind", i.kind], ["Host", pt.host], ["Scheme", pt.protocol ? devPill(pt.protocol.replace(":", ""), i.insecure ? "warn" : "ok") : ""],
    ["Path", pt.path], ["Query parameters", pt.query && pt.query.length ? pt.query.join(", ") : ""], ["Fragment", pt.hash],
    ["Link previews setting", i.previewsOn ? devPill("on", "ok") : devPill("off", "warn")],
    ["Shared preview cache", sc ? devPill(sc.fresh ? `fresh (${sc.ageHours} h old)` : `stale (${sc.ageHours} h old)`, sc.fresh ? "ok" : "warn") : String(i.sharedCache)],
    ["Preview title", d && d.title], ["Preview text", d && d.description && d.description.slice(0, 120)], ["Preview image", d && d.image], ["Preview price", d && d.price]
  ]);
  const b = document.createElement("button"); b.type = "button"; b.className = "btn small"; b.textContent = "Fetch preview now";
  b.onclick = async () => {
    b.disabled = true; b.textContent = "Fetching…";
    try {
      const r = await fetchPreviewNow(url, enc), x = r.data || {};
      for (const [k, v] of [["Fetched in", r.ms + " ms"], ["Result", r.data ? devPill("preview found", "ok") : devPill(r.retryLater ? "server unreachable" : "no preview", "warn")], ["Fetched title", x.title], ["Fetched text", x.description && x.description.slice(0, 120)], ["Fetched image", x.image], ["Site name", x.site || x.siteName], ["Type", x.type], ["Price", x.price]]) {
        if (v == null || v === "") continue;
        const row = document.createElement("div"); row.className = "dev-row"; const kk = document.createElement("span"); kk.className = "dev-k"; kk.textContent = k; const vv = document.createElement("span"); vv.className = "dev-v"; v instanceof Node ? vv.append(v) : (vv.textContent = String(v)); row.append(kk, vv); card.insertBefore(row, b);
      }
      b.remove();
    } catch (e) { b.textContent = "Failed: " + (e && e.message || e); b.disabled = false; }
  };
  card.append(b);
  return card;
}

async function showMessageDev(key, msg) {
  const stored = rawOf.get(msg) || msg;
  const raw = () => ({ key, path: `${chatPath}/messages/${key}`, stored, shown: msg, fromMe: msg.fromUid === me, pending: pendingKeys.has(key) });
  await showDev("Message " + key.slice(-6), { raw, scope: "message", visual: async () => {
    const p = await getProfile(msg.fromUid).catch(() => null);
    const t = fmtDate, srv = keyTime(key), sent = msg.timestamp;
    const readers = await Promise.all(Object.entries(readReceipts || {}).filter(([u, k]) => u !== msg.fromUid && String(k) >= key).map(async ([u]) => [u, await getProfile(u).catch(() => null)]));
    const size = (() => { try { return JSON.stringify(stored).length; } catch (_) { return 0; } })();
    const state = msg._lost ? devPill("lost", "bad") : msg._locked ? devPill("locked", "warn") : stored.enc ? devPill("decrypted", "ok") : devPill("plain");
    const urlCards = [];
    for (const u of urlsIn([msg.text, msg.content, msg.url].filter(x => typeof x === "string" && !msg._locked).join(" ")).slice(0, 4)) urlCards.push(await urlCard(u, !!msg._enc));
    return devGrid(
      devCard("", [["Type", msg.type || "text"], ["Message id", key], ["Stored size", fmtBytes(size)], ["Pending upload", pendingKeys.has(key) ? devPill("yes", "warn") : ""]], { head: devWho((p && p.displayName) || "Someone", p && p.pfp, msg.fromUid === me ? "You" : msg.fromUid) }),
      devCard("Timing", [["Sent (client clock)", sent ? fullTime(sent) : ""], ["Accepted by database", srv ? fullTime(srv) : ""], ["Client → server", sent && srv ? (srv - sent) + " ms" : "", sent && srv && Math.abs(srv - sent) > 3000 ? "warn" : ""], ["Delivered", msg.deliveredAt ? fullTime(msg.deliveredAt) : ""], ["Edited", msg.editedAt ? fullTime(msg.editedAt) : ""], ["Clock offset", srvOff + " ms"]]),
      devCard("Encryption", [["Encrypted", stored.enc ? devPill("yes", "info") : devPill("no")], ["State", state], ["Cipher length", stored.enc ? String((stored.text || stored.content || "").length) + " chars" : ""]]),
      devCard("Content", [["URL / file", msg.content || msg.url || ""], ["File name", msg.name], ["Size", msg.size != null ? fmtBytes(msg.size) : ""], ["Mime", msg.mime], ["Duration", msg.duration ? msg.duration + " s" : ""], ["Waveform", msg.wave ? devPill("sent with message", "ok") : msg.type === "audio" ? devPill("missing", "warn") : ""], ["Expires", msg.expiresAt ? fullTime(msg.expiresAt) : ""], ["Reply to", msg.replyTo ? msg.replyTo.key : ""]]),
      devCard("Read by", readers.length ? readers.map(([u, p]) => [(p && p.displayName) || u, devPill("read", "ok")]) : [["Nobody yet", ""]]),
      ...urlCards
    );
  } });
}
const fmtDate = ts => new Date(ts).toLocaleString();

// developer mode: a small button with everything raw about this chat
$("chatOptionsBtn").before(devButton("{ }", async () => {
  const g = async p => { try { return (await get(ref(db, `${chatPath}/${p}`))).val(); } catch (e) { return { error: String(e) }; } };
  const rawData = async () => {
    const els = [...messagesDiv.querySelectorAll(".msg")];
    const keysNode = await g("keys");
    return {
      chatId, path: chatPath, me, participants, chatEncrypted, keyState, keysExist, keyHolders: keysNode && typeof keysNode === "object" ? Object.fromEntries(Object.entries(keysNode).map(([u, k]) => [u, k && { by: k.by, iv: (k.iv || "").length, ct: (k.ct || "").length }])) : keysNode,
      e2e: { ready: E2E.ready(), fingerprint: E2E.myFingerprint() },
      loaded: { rendered: els.length, first: els[0]?.dataset.key, last: els[els.length - 1]?.dataset.key, withMedia: messagesDiv.querySelectorAll("img.media,video,.qp-audio").length, pendingJobs: jobs.size, latestKey },
      chatData: await g("chatData"), lastMessage: await g("lastMessage"), messageRead: await g("messageRead"), typing: typingUids,
      serverClockOffsetMs: srvOff, env: envInfo()
    };
  };
  await showDev("Chat " + chatId.slice(0, 8), { raw: rawData, every: 0, scope: "chat", visual: async () => {
    const els = [...messagesDiv.querySelectorAll(".msg")];
    const locked = [...msgData.values()].filter(m => m && m._locked), lost = locked.filter(m => m._lost).length;
    const people = await Promise.all(participants.map(async u => ({ u, p: await getProfile(u).catch(() => null) })));   // (bots included)
    const env = envInfo();
    const who = devCard("People", people.map(({ u, p }) => [(p && p.displayName) || u, (() => { const w = document.createElement("span"); w.append(devPill(keyHolders.includes(u) ? "has key" : "no key", keyHolders.includes(u) ? "ok" : "warn"), " ", devPill(typingUids.includes(u) ? "typing" : readReceipts[u] ? "read" : "", "")); return w; })()]));
    return devGrid(
      devCard("Chat", [["Id", chatId], ["Members", participants.length], ["Name", customName || "(none)"], ["Connection", navigator.onLine ? devPill("online", "ok") : devPill("offline", "bad")], ["Server clock offset", srvOff + " ms"]]),
      devCard("Encryption", [["Chat flag", chatEncrypted ? devPill("on", "info") : devPill("off")], ["This device", keyState === "ready" ? devPill("has key", "ok") : devPill(keysExist ? "waiting for key" : "no key exists", "warn")], ["Key copies", keysExist ? `${keyHolders.length} / ${participants.length}` : "none"], ["Identity", E2E.ready() ? devPill("unlocked", "ok") : devPill("locked", "warn")], ["Fingerprint", E2E.myFingerprint()], ["Locked messages", locked.length ? `${locked.length} (${lost} lost)` : "0"]]),
      who,
      devCard("Loaded", [["Messages rendered", els.length], ["Media items", messagesDiv.querySelectorAll("img.media,video,.qp-audio").length], ["Uploads in progress", jobs.size], ["Reached start", reachedStart ? "yes" : "no"], ["Page data loaded", env.loadedResources ? fmtBytes(env.loadedResources.transferredBytes) : ""], ["Requests", env.loadedResources && env.loadedResources.requests], ["DOM elements", document.getElementsByTagName("*").length], ["Images / videos / audio", `${messagesDiv.querySelectorAll("img.media").length} / ${messagesDiv.querySelectorAll("video").length} / ${messagesDiv.querySelectorAll(".qp-audio").length}`], ["Oldest loaded id", oldestKey], ["Newest loaded id", latestKey], ["Typing now", typingUids.length], ["Read receipts", Object.keys(readReceipts || {}).length], ["Failed media", messagesDiv.querySelectorAll(".media-failed").length], ["Download queue", ""]]),
      devCard("Device", [["App", env.app ? "Android app" : "browser"], ["Viewport", `${env.viewport.w}×${env.viewport.h} @${env.viewport.dpr}x`], ["Network", [env.network.type, env.network.downlink && env.network.downlink + " Mbps", env.network.rtt && env.network.rtt + " ms"].filter(Boolean).join(" · ")], ["JS heap", env.memoryMB && env.memoryMB + " MB"]])
    );
  } });
}, { title: "Developer info about this chat" }));
$("chatOptionsBtn").onclick = () => { if (!hub.open) hub.showModal(); showPane("settings"); };
document.querySelector(".chat-title-wrap").style.cursor = "pointer";
document.querySelector(".chat-title-wrap").addEventListener("click", () => optionsDialog.showModal());      // tap the chat's name: straight to its settings

wirePhotoUpload($("uploadPhotoBtn"), $("chatPhotoFile"), d => { $("chatPhotoInput").value = d; $("savePhotoBtn").click(); }, m => toast(m, "error"));
$("savePhotoBtn").onclick = async () => {
  const v = $("chatPhotoInput").value.trim();
  if (v && !/^(https?:\/\/\S+|data:image\/\S+)$/i.test(v)) { toast("Enter a full image URL starting with http:// or https://, or upload a photo.", "error"); return; }
  if (v.length > 30000) { toast("That picture is too large. Upload a photo instead.", "error"); return; }
  try { await set(ref(db, `${chatPath}/chatData/photo`), v); toast(v ? "Group photo saved." : "Group photo removed.", "success"); }
  catch (err) { console.error(err); toast("Couldn't save the photo.", "error"); }
};

// ---------- pins (shared by the whole chat: privateChats/<chat>/pins/<messageKey> = { by, ts }) ----------
let pinsMap = {};
const pinList = () => Object.entries(pinsMap).map(([key, v]) => ({ key, by: v && v.by || "", ts: v && v.ts || 0 }));
const pinCache = new Map();           // key -> slim record of a pinned message that isn't loaded
async function resolvePin(key) {
  const raw = await get(ref(db, `privateChats/${chatId}/messages/${key}`)).then(s => s.val());
  if (!raw || raw.type === "event") return null;
  const m = await hydrate(raw);
  if (raw.enc) sawEnc = true;
  return { key, k: m.type === "image" || m.type === "video" || m.type === "audio" || m.type === "file" ? m.type : "text", ts: m.timestamp || 0, from: m.fromUid || "", text: String(m.text || "").slice(0, 400), name: String(m.name || ""), size: m.size || 0 };
}
async function togglePin(key) {
  track("pin_toggled", { on: !pinsMap[key] });
  try {
    if (pinsMap[key]) { await remove(ref(db, `privateChats/${chatId}/pins/${key}`)); toast("Unpinned", "success", 1500); return; }
    if (Object.keys(pinsMap).length >= 50) return toast("A chat can have 50 pins. Unpin one first.", "error");
    await set(ref(db, `privateChats/${chatId}/pins/${key}`), { by: me, ts: Date.now() }); toast("Pinned for everyone in this chat", "success", 2000);
  } catch (_) { toast("Couldn't change the pin. The database rules may need republishing.", "error"); }
}
function decoratePins() {
  for (const el of messagesDiv.querySelectorAll(".msg")) {
    const on = !!pinsMap[el.dataset.key];
    el.classList.toggle("pinned", on);
    const meta = el.querySelector(".msg-foot");
    const has = el.querySelector(".pin-badge");
    if (on && !has && meta) { const b = document.createElement("span"); b.className = "pin-badge"; b.textContent = "\ud83d\udccc"; b.title = "Pinned"; meta.append(b); }
    else if (!on && has) has.remove();
  }
}
let pinsPaint = 0;
/** The Pins tab of the chat menu: every pinned message, newest first; tap to jump to it. */
async function paintPinsPane() {
  const box = $("pinsList"), token = ++pinsPaint, list = pinList().sort((a, b) => b.ts - a.ts);
  if (hub.dataset.pane !== "pins") return;
  box.replaceChildren();
  if (!list.length) { const e = document.createElement("div"); e.className = "muted cs-empty"; e.textContent = "Nothing is pinned yet. Open a message's menu and choose Pin."; box.append(e); return; }
  for (const p of list) {
    let r = null; const m = msgData.get(p.key);
    if (m) r = { text: m.text, name: m.name, k: m.type }; else { try { r = pinCache.get(p.key) || await resolvePin(p.key); if (r) pinCache.set(p.key, r); } catch (_) { /* offline */ } }
    if (token !== pinsPaint) return;
    const b = document.createElement("div"); b.className = "cs-item";
    const ic = document.createElement("span"); ic.className = "cs-ic"; ic.textContent = "\ud83d\udccc";
    const body = document.createElement("span"); body.className = "cs-body";
    const t = document.createElement("span"); t.className = "cs-t"; t.textContent = r ? (r.text || r.name || ({ image: "Photo", video: "Video", audio: "Voice message", file: "File" }[r.k] || "Pinned message")) : "Pinned message";
    const sub = document.createElement("span"); sub.className = "cs-s"; sub.textContent = "Pinned by " + (p.by === me ? "you" : (peekProfile(p.by)?.displayName || "someone"));
    body.append(t, sub);
    const x = document.createElement("button"); x.type = "button"; x.className = "btn small cs-pinx"; x.textContent = "Unpin"; x.onclick = e => { e.stopPropagation(); togglePin(p.key); };
    b.append(ic, body, x); b.style.cursor = "pointer"; b.onclick = () => { hub.close(); searchJump(p.key); };
    box.append(b);
  }
}
new MutationObserver(() => decoratePins()).observe(messagesDiv, { childList: true });
function startPins() { onValue(ref(db, `privateChats/${chatId}/pins`), s => { pinsMap = s.val() || {}; decoratePins(); if (hub.open && hub.dataset.pane === "pins") paintPinsPane(); }, () => {}); }

// ---------- mute (stored in the database so every device and the notification server honor it) ----------
const FOREVER = 9e15;
let myMute = {};
const muteRef = () => ref(db, `privateChats/${chatId}/mutes/${me}`);
function paintMute() {
  const now = Date.now(), m = (myMute.m || 0) > now, c = (myMute.c || 0) > now;
  const until = t => t >= FOREVER / 2 ? "until you turn it off" : "until " + new Date(t).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit", month: "short", day: "numeric" });
  const parts = [];
  if (m && c && myMute.m === myMute.c) parts.push("Messages and calls muted " + until(myMute.m));
  else { if (m) parts.push("Messages muted " + until(myMute.m)); if (c) parts.push("Calls muted " + until(myMute.c)); }
  $("muteState").textContent = parts.join(" \u00b7 ") || "Not muted.";
  $("unmuteBtn").hidden = !(m || c);
  document.body.classList.toggle("chat-muted", m || c);
}
function startMute() { onValue(muteRef(), s => { myMute = s.val() || {}; paintMute(); }, () => {}); setInterval(paintMute, 60000); }
$("muteFor").onchange = () => { $("muteCustom").hidden = $("muteFor").value !== "custom"; };
$("muteBtn").onclick = async () => {
  const f = $("muteFor").value;
  const ms = f === "forever" ? FOREVER : f === "custom" ? Math.round((+$("muteAmount").value || 0) * +$("muteUnit").value) : +f;
  if (!(ms > 0)) return toast("Pick how long to mute.", "error");
  const until = ms >= FOREVER ? FOREVER : Date.now() + ms, w = $("muteWhat").value, next = { ...myMute };
  if (w !== "c") next.m = until; if (w !== "m") next.c = until;
  track("mute_set", { what: w, length: f === "forever" ? "forever" : f === "custom" ? "custom" : "preset" });
  try { await set(muteRef(), next); toast("Muted", "success", 2000); } catch (_) { toast("Couldn't save the mute. The database rules may need republishing.", "error"); }
};
$("unmuteBtn").onclick = async () => { try { await set(muteRef(), null); toast("Mute is off", "success", 2000); } catch (_) { toast("Couldn't turn the mute off.", "error"); } };

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
    if (isBotUid(p.uid)) { const t = document.createElement("span"); t.className = "tag bot-tag"; t.textContent = "BOT"; t.title = "A bot account"; name.append(t); }
    if (p.uid === me) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = "You";
      name.append(tag);
    }
    if (chatEncrypted || keysExist) {                                           // who can read the encrypted messages
      const has = keyHolders.includes(p.uid);
      const k = document.createElement("span"); k.className = "key-tag " + (has ? "ok" : "warn");
      k.textContent = has ? "🔑 Has key" : "🔑 No key"; k.title = has ? "Has a copy of this chat's encryption key." : "Doesn't have this chat's encryption key yet. It is shared automatically when someone who has it opens the chat.";
      name.append(k);
    }
    // The copy button is only here when that person made their friend code public (and it is switched on). Yours is always copyable.
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "icon-btn";
    copy.hidden = true;
    copy.setAttribute("aria-label", `Copy ${p.displayName}'s friend code`);
    copy.title = "Copy friend code";
    copy.innerHTML = icon("copy", 18);
    (p.uid === me ? ensureFriend(me).then(f => f && f.code) : publicCodeOf(p.uid)).then(code => {
      if (!code) return;
      copy.hidden = false;
      copy.onclick = async () => { await copyText(code); toast("Friend code copied.", "success", 1800); };
    }).catch(() => { /* no code to show */ });
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn small" + (p.uid === me ? " danger" : "");
    btn.textContent = p.uid === me ? "Leave" : "Remove";
    btn.onclick = () => removeParticipant(p.uid);
    row.append(name, copy, btn);
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
      setTimeout(() => toHome(), 600);
      return;
    }
    await logEvent(chatId, me, { event: self ? "chat_leave" : "chat_kick", target: self ? null : uid });
    await update(ref(db), {
      [`${chatPath}/participants/${uid}`]: null,
      [`${chatPath}/messageRead/${uid}`]: null,
      [`${chatPath}/typing/${uid}`]: null
    });
    if (self) {
      remove(ref(db, `chatList/${me}/${chatId}`)).catch(() => {});
      toast("You left the chat.");
      setTimeout(() => toHome(), 600);
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
  if (!requireVerified("add people")) return;
  let newUid;
  try { newUid = await resolveRecipient(input.value); } catch (e) { return toast(e.message, "error"); }
  if (participants.includes(newUid)) return toast("They're already in this chat.", "error");

  try {
    if (!(await profileExists(newUid))) return toast("No user found.", "error");
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
    logEvent(chatId, me, { event: "chat_add", target: newUid });
    if (chatEncrypted) E2E.ensureMemberKeys(chatId, [...participants, newUid]).catch(() => {});
    input.value = "";
    toast(`${p.displayName} was added.`, "success");
  } catch (err) {
    console.error(err);
    toast("Couldn't add that user.", "error");
  }
};

$("addBotBtn").onclick = async () => {
  if (!requireVerified("add a bot")) return;
  let mine = [];
  try { mine = (await listBots(me)).filter(b => !participants.includes(b.id)); } catch (_) { return toast("Couldn't load your bots.", "error"); }
  if (!mine.length) return toast("You have no bots to add. Make one in Account → Bots.", "info", 4000);
  const node = document.createElement("div"); node.className = "stack";
  let chosen = mine[0].id;
  mine.forEach((b, i) => {
    const l = document.createElement("label"); l.className = "switch-row";
    const r = document.createElement("input"); r.type = "radio"; r.name = "pickbot"; r.checked = i === 0; r.onchange = () => { chosen = b.id; };
    l.append(r, avatarEl(b.name, b.pfp || "", "avatar sm"), Object.assign(document.createElement("span"), { textContent: " " + b.name })); node.append(l);
  });
  if (chatEncrypted) { const w = document.createElement("p"); w.className = "plugin-issue warn"; w.textContent = "This chat is end-to-end encrypted. A bot can't read encrypted messages, and what it posts here is not encrypted (it is stored readable)."; node.append(w); }
  const ok = await confirmDialog({ title: "Add a bot to this chat?", node, message: "The bot can read the plain messages in this chat (through its token or webhook) and post here. Only add bots you control.", okText: "Add bot" });
  if (!ok) return;
  try {
    await addBotToChat(chatPath, chatId, chosen);
    logEvent(chatId, me, { event: "chat_add", target: chosen });
    toast("Bot added.", "success");
  } catch (err) { console.error(err); toast("Couldn't add that bot.", "error"); }
};

// ---------- encryption setup ----------
let keyPoll = null;
/** Encryption is off and no encrypted message is left (all deleted): the chat key is no longer needed. Delete it so that anyone
 *  in the chat can turn encryption on again with a fresh key (otherwise a member who lost the old key could never do it). */
async function dropKeyIfUnused() {
  try {
    if ((await get(ref(db, `${chatPath}/chatData/encrypted`))).val() === true) return;
    if (!(await get(ref(db, `${chatPath}/keys`))).exists()) return;
    const left = await get(query(messagesRef, orderByChild("enc"), equalTo(true), limitToFirst(1)));
    if (left.exists()) return;
    await remove(ref(db, `${chatPath}/keys`));
    E2E.forgetChatKey(chatId);
  } catch (e) { console.warn("key cleanup", e); }
}
async function setupKeys() {
  try {
    chatEncrypted = ((await getSWR(ref(db, `${chatPath}/chatData`))).val() || {}).encrypted === true;
    if (!E2E.ready()) { keyState = "waiting"; paintEnc(); return; }
    let key = await E2E.getChatKey(chatId);
    const members = Object.keys((await getSWR(ref(db, `${chatPath}/participants`))).val() || {});
    if (!key && chatEncrypted && !(await get(ref(db, `${chatPath}/keys`))).exists()) {
      // flagged encrypted but nobody has made a key yet (e.g. created by an older client): make it now
      const { wrapped } = await E2E.createChatKey(chatId, members);
      await set(ref(db, `${chatPath}/keys`), wrapped);
      key = await E2E.getChatKey(chatId);
    }
    keyState = key ? "ready" : "waiting";
    if (key) E2E.ensureMemberKeys(chatId, members).catch(() => {});
    else if (!keyPoll) keyPoll = setInterval(async () => { if (await E2E.getChatKey(chatId)) { clearInterval(keyPoll); keyPoll = null; keyState = "ready"; paintEnc(); refreshLocked(); } }, 6000);
  } catch (e) { console.warn("encryption setup", e); keyState = "waiting"; }
  paintEnc();
}
/** "Encryption key" row in the chat options: does this device have the key, and does anybody? */
function paintKeyRow() {
  const row = $("encKeyRow"); if (!row) return;
  const mine = keyHolders.includes(me);
  let txt = "", cls = "";
  if (!keysExist) { if (!chatEncrypted) { row.hidden = true; return; } txt = "No key yet: nobody in this chat has one, a fresh key is made as soon as someone with unlocked keys opens it."; cls = "warn"; }
  else if (keyState === "ready") { txt = `This device has the chat key. ${keyHolders.length} of ${participants.length} member${participants.length === 1 ? "" : "s"} hold a copy.`; cls = "ok"; }
  else if (!mine) { txt = "You don't have a key for this chat (for example you reset your keys). It is handed to you automatically when another member opens the chat; older messages stay locked until then."; cls = "warn"; }
  else if (!E2E.ready()) { txt = "Your key is stored, but this device is locked. Enter your recovery code under Account → Encryption."; cls = "warn"; }
  else { txt = "Your copy of the key can't be opened on this device (it was made for an older identity). It is refreshed when another member opens the chat."; cls = "warn"; }
  row.hidden = false; row.className = "enc-key " + cls; row.textContent = "🔑 " + txt;
}
function paintEnc() {
  const t = $("encToggle"), st = $("encStatus");
  if (!t) return;
  paintKeyRow(); paintVerify();
  t.checked = chatEncrypted;
  // without the chat's key this device can neither turn encryption on nor off for the chat
  t.disabled = keysExist && keyState !== "ready";
  t.closest("label")?.classList.toggle("disabled", t.disabled);
  if (t.disabled) {
    st.textContent = "Locked: this device doesn't have the chat's encryption key, so it can't change this setting. The key arrives when another member opens the chat, or restore your recovery code when the chat list asks.";
    document.documentElement.classList.toggle("enc-on", chatEncrypted);
    return;
  }
  st.textContent = !chatEncrypted ? "Off: new messages are stored readable. Turn on to encrypt new messages (older ones stay as they were)."
    : keyState === "ready" ? "On: messages, links and files are encrypted so only people in this chat can read them."
    : "On, but this device doesn't have the chat key yet. It arrives when another member opens the chat, or restore your recovery code (Account → Encryption).";
  document.documentElement.classList.toggle("enc-on", chatEncrypted);
}
$("encToggle")?.addEventListener("change", async e => {
  const on = e.target.checked;
  track("encryption_toggled", { on });
  try {
    if (!requireVerified("change chat settings")) { e.target.checked = !on; return; }
    if (on) {
      if (!E2E.ready()) throw new Error("This device is locked: enter your recovery code under Account → Encryption first.");
      let key = await E2E.getChatKey(chatId);
      if (!key) {
        if ((await get(ref(db, `${chatPath}/keys`))).exists()) throw new Error("This chat already has a key you can't open yet.");   // (the toggle is disabled in that case)
        const { wrapped } = await E2E.createChatKey(chatId, participants);
        await set(ref(db, `${chatPath}/keys`), wrapped);
        key = await E2E.getChatKey(chatId);
      }
      keyState = key ? "ready" : "waiting";
    }
    await set(ref(db, `${chatPath}/chatData/encrypted`), on);
    chatEncrypted = on; paintEnc();
    if (!on) dropKeyIfUnused();
    logEvent(chatId, me, { event: on ? "enc_on" : "enc_off" });         // everyone sees that it changed
    toast(on ? "Encryption on for new messages." : "Encryption off for new messages.", "success");
    if (on && await E2E.takeNewCode(me).catch(() => null)) toast("Save your recovery code now: Account → Encryption → Show recovery code. Without it you can't read encrypted chats on a new device.", "info", 9000);
  } catch (err) { console.error(err); e.target.checked = !on; toast(err.message || "Couldn't change encryption.", "error"); }
});

/** An encrypted chat whose key this device doesn't have: messages can still be sent, but they go out unencrypted (see the banner). */
const keyLocked = () => chatEncrypted && keyState === "waiting";
/** Encrypt outgoing messages only when this device really has the chat key. */
function canSeal() { return chatEncrypted && keyState === "ready"; }
function paintVerify() {
  const ok = isVerified();
  msgInput.disabled = !ok; sendBtn.disabled = !ok; $("attachBtn").disabled = !ok;
  msgInput.placeholder = !ok ? "Verify your email to send messages" : "Message";
  const kb = $("keyBanner"); if (kb) kb.hidden = !(ok && keyLocked());
}
$("whyKeyBtn")?.addEventListener("click", () => confirmDialog({
  title: "Why are my messages unencrypted?",
  message: "This chat is end-to-end encrypted, but this device doesn't have the chat's key right now (for example because you reset your keys, or you are on a new device that hasn't been unlocked).\n\nWithout the key your device can't scramble messages, so the messages you send now are stored readable, like in a chat without encryption. Other people's encrypted messages stay locked for you too.\n\nHow it gets fixed: as soon as another member who has the key opens this chat, their device hands the key to yours automatically. From then on your new messages are encrypted again, and the older locked ones open. Messages you sent while you had no key stay unencrypted: that can't be undone afterwards.\n\nIf you'd rather not send anything until then, simply wait a bit. If you have your recovery code, restoring it under Account → Encryption also brings the key back.",
  okText: "Got it", hideCancel: true
}));

// ---------- boot ----------
function leaveChat(message) {
  toast(message, "error");
  setTimeout(() => toHome(), 900);
}

onAuthStateChanged(auth, async user => {
  if (!user) { toHome(); return; }
  if (me) return; // already initialised
  me = user.uid; startMute(); startPins();
  getProfile(me).then(p => { ownName = p.displayName || ""; }).catch(() => {});
  ensureProfile(user).catch(() => {});

  // Membership + header (also detects being removed from the chat)
  onValueSWR(ref(db, `${chatPath}/participants`), snap => {
    const v = snap.val();
    if (!v || !v[me]) { leaveChat("You're no longer in this chat."); return; }
    participants = Object.keys(v);
    updateHeader();
    renderReceipts();
    if (optionsDialog.open) renderParticipants();
  }, () => leaveChat("You don't have access to this chat."));

  onValueSWR(ref(db, `${chatPath}/chatData`), snap => {        // name, photo and the encryption flag: one listener
    const d = snap.val() || {};
    customPhoto = d.photo || ""; customName = d.name || ""; chatEncrypted = d.encrypted === true;
    updateHeader(); paintEnc();
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

  // ---- encryption: this device's identity, whether the chat is encrypted, and the chat key
  // (runs alongside the loading of the messages: on a slow connection the saved messages must not wait for it)
  const encP = (async () => {
    await E2E.init(me).catch(() => "error");
    E2E.onRemoteIdentity(async () => {                                        // identity restored in another frame → unlock this chat in place
      if (E2E.ready()) return;
      await E2E.init(me).catch(() => {});
      await setupKeys();
      refreshLocked();
    });
    await setupKeys();
    {   // the chat's key changed or was removed (re-enabled with a fresh one, or deleted): forget the old one and look again
      let first = true, last = null;
      onValue(ref(db, `${chatPath}/keys`), async snap => {
        const wasLost = E2E.isChatLost(chatId);
        keysExist = snap.exists();
        keyHolders = Object.keys(snap.val() || {});
        E2E.setChatLost(chatId, !keysExist);                                   // nobody holds a key any more → old encrypted messages are lost
        const sig = JSON.stringify((snap.val() || {})[me] || null);
        if (!first && sig !== last) { E2E.forgetChatKey(chatId); await setupKeys(); refreshLocked(); }
        else if (wasLost !== !keysExist) refreshLocked();
        if (optionsDialog.open) renderParticipants();
        first = false; last = sig; paintEnc();
      }, () => {});
    }

  })().catch(e => console.warn("encryption setup", e));
  paintVerify(); watchVerified(paintVerify);

  // Initial page of history, then a live window starting at its oldest message.
  historyStatus.textContent = "Loading messages…";
  const slowT = setTimeout(() => { if (!ready) historyStatus.textContent = "Still loading… your connection looks slow"; }, 5000);
  try {
    if (AT && !protect()) {
      // Only the area around the chosen message: ~20 before it, ~20 from it on. No live listener until the reader scrolls down to the present.
      const [before, after] = await Promise.all([
        get(query(messagesRef, orderByKey(), endBefore(AT), limitToLast(20))),
        get(query(messagesRef, orderByKey(), startAt(AT), limitToFirst(21)))
      ]);
      const items = []; before.forEach(x => { items.push(x); }); after.forEach(x => { items.push(x); });
      clearTimeout(slowT); historyStatus.textContent = "";
      windowed = true; stick = false;
      if (items.length) { oldestKey = items[0].key; newestKey = items[items.length - 1].key; } else { reachedStart = true; }
      await Promise.race([encP, new Promise(r => setTimeout(r, offlineOn() ? 1500 : 60000))]);
      items.forEach(x => rawByKey.set(x.key, x.val()));
      const plains = await Promise.all(items.map(x => hydrate(x.val())));
      items.forEach((x, i) => appendLive(x.key, plains[i]));
      latestKey = null;                                      // not the end of the chat: nothing here is marked as read
      renderReceipts();
      ready = true; jumpBtn.classList.remove("hidden"); jumpBtn.title = "Back to the latest messages";
      const t = document.getElementById("msg-" + AT);
      if (t) { t.scrollIntoView({ block: "center" }); t.classList.add("flash"); setTimeout(() => t.classList.remove("flash"), 1800); }
      else toast("That message is no longer in the chat.", "info", 2500);
      fillViewport();
      encP.then(() => { try { refreshLocked(); } catch (_) { /* ignore */ } });
      return;
    }
    // Saved copy first when the live page is slow (1.2 s) or can't arrive; the live page is always fetched and then reconciles what was shown.
    const pageQ = query(messagesRef, orderByKey(), limitToLast(PAGE));
    const realP = get(pageQ);
    const saved = offlineOn() ? await ocGet("page:" + chatId).catch(() => undefined) : undefined;
    const savedItems = saved && Array.isArray(saved.v) && saved.v.length ? saved.v : null;
    let shownSaved = null;
    const initSnap = await new Promise((res, rej) => {
      const t25 = setTimeout(() => rej(new Error("timeout")), 25000);
      const useSaved = () => { if (shownSaved) return; shownSaved = savedItems; res(savedPage(savedItems)); };
      const tS = savedItems ? setTimeout(useSaved, 1000) : null;
      realP.then(s => { clearTimeout(t25); clearTimeout(tS); res(s); }, e => { clearTimeout(t25); clearTimeout(tS); if (savedItems) useSaved(); else rej(e); });
    });
    const keepPage = s => { const it = []; s.forEach(x => { it.push([x.key, x.val()]); }); return it; };
    realP.then(s => ocSet("page:" + chatId, keepPage(s)), () => {});
    if (shownSaved) {
      // what the live page says about the messages that were shown from the saved copy: deleted ones go, edited ones update, new ones appear
      const endSync = beginSync("messages");
      let reconciled = false;
      const reconcile = s => {
        if (!ready) { setTimeout(() => reconcile(s), 150); return; }                      // after the saved messages are on screen
        if (reconciled) return; reconciled = true;
        const real = keepPage(s), realKeys = new Set(real.map(x => x[0])), first = real.length ? real[0][0] : null;
        for (const [k] of shownSaved) if (!realKeys.has(k) && (first === null || k >= first)) onRemoved(new SavedSnap(null, k, null));
        for (const [k, v] of real) { const mine = rawByKey.get(k); if (!mine) onAdded(new SavedSnap(null, k, v)); else if (JSON.stringify(mine) !== JSON.stringify(v)) onChanged(new SavedSnap(null, k, v)); }
        endSync();
      };
      const retryOnline = () => {
        let off = () => {};
        off = onValue(ref(db, ".info/connected"), c => { if (c.val() === true) { off(); get(pageQ).then(reconcile, retryOnline); } }, () => {});
      };
      realP.then(reconcile, retryOnline);
    }
    clearTimeout(slowT);
    if (historyStatus.textContent.startsWith("Loading") || historyStatus.textContent.startsWith("Still loading")) historyStatus.textContent = "";
    const initial = [];
    initSnap.forEach(s => { initial.push(s); });

    if (!initial.length) {
      reachedStart = true;
      historyStatus.textContent = "No messages yet — say hi 👋";
    }
    if (initial.length) oldestKey = initial[0].key;
    const pr0 = protect();
    const keep = initial.filter(s => { const v = s.val(); return !pr0 || v.type === "event" || v.timestamp >= pr0.since(); });
    if (pr0) {
      reachedStart = true; historyStatus.textContent = "";
      const b = document.createElement("div");
      document.documentElement.classList.add("locked-chat");
      b.className = "protect-banner";
      b.innerHTML = '<span>🔒 Older messages are locked. Only messages sent since you joined this call are shown.</span><button type="button" class="btn small primary">Unlock to see all messages</button>';
      b.querySelector("button").onclick = () => pr0.unlock();
      messagesDiv.prepend(b);
      const t = setInterval(() => { if (!protect()) { clearInterval(t); location.reload(); } }, 1000);
    }
    await Promise.race([encP, new Promise(r => setTimeout(r, offlineOn() ? 1500 : 60000))]);          // the chat key, unless that is slow (then the messages show locked, and unlock below)
    keep.forEach(s => rawByKey.set(s.key, s.val()));
    const plains = await Promise.all(keep.map(s => hydrate(s.val())));
    keep.forEach((s, i) => appendLive(s.key, plains[i]));
    renderReceipts();
    scrollToBottom();
    ready = true;
    maybeMarkRead();
    fillViewport();
    cachePrune(chatId, oldestKey ?? "", new Set(msgData.keys())).catch(() => {});      // anything deleted while this device was away

    encP.then(() => { try { refreshLocked(); } catch (_) { /* ignore */ } });
    const live = query(messagesRef, orderByKey(), startAt(oldestKey ?? ""));
    onChildAdded(live, onAdded);
    onChildChanged(live, onChanged);
    onChildRemoved(live, onRemoved);
  } catch (err) {
    console.error("Failed to load messages", err);
    clearTimeout(slowT);
    const off = navigator.onLine === false || /offline/i.test(String(err && err.message));
    historyStatus.innerHTML = "";
    historyStatus.append(off ? "You're offline — messages couldn't load. " : "There was a problem loading this chat. ");
    const retry = document.createElement("button"); retry.type = "button"; retry.className = "btn small"; retry.textContent = "Try again";
    retry.onclick = () => location.reload();
    historyStatus.append(retry);
  }
});


// ---------- camera: photo or video, the whole picture ----------
const camDlg = $("cameraDialog"), camVideo = $("camVideo"), camShot = $("camShot"), camPlay = $("camPlay"), camTime = $("camTime");
let camStream = null, camFacing = "environment", camBlob = null, camMode = "photo", camRec = null, camChunks = [], camTick = null, camT0 = 0, camPlayUrl = null;
const mmss = ms => { const s = Math.floor(ms / 1000); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
const pickMime = list => (window.MediaRecorder && list.find(m => MediaRecorder.isTypeSupported(m))) || "";
const stopCam = () => { camStream?.getTracks().forEach(t => t.stop()); camStream = null; camVideo.srcObject = null; };
function discardRec() { if (camRec) { camRec.onstop = null; try { camRec.state !== "inactive" && camRec.stop(); } catch (_) { /* ignore */ } camRec = null; } clearInterval(camTick); camTime.hidden = true; }
function camUi(state) {   // "live" | "recording" | "review"
  const photo = camMode === "photo";
  camVideo.hidden = state === "review"; camShot.hidden = !(state === "review" && photo); camPlay.hidden = !(state === "review" && !photo);
  $("camSnap").hidden = state === "review"; $("camSend").hidden = state !== "review"; $("camRetake").hidden = state !== "review";
  $("camSnap").textContent = state === "recording" ? "Stop" : photo ? "Take photo" : "Start recording";
  $("camSnap").classList.toggle("danger", state === "recording");
  $("camModePhoto").classList.toggle("on", photo); $("camModeVideo").classList.toggle("on", !photo);
  $("camModePhoto").disabled = $("camModeVideo").disabled = state !== "live";
  $("camTitle").textContent = state === "review" ? (photo ? "Your photo" : "Your video") : photo ? "Take a photo" : "Record a video";
  $("camFlip").hidden = state !== "live" || $("camFlip").dataset.n < 2;
}
async function startCam() {
  stopCam(); discardRec();
  camBlob = null; if (camPlayUrl) { URL.revokeObjectURL(camPlayUrl); camPlayUrl = null; }
  camUi("live");
  camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: camFacing }, width: { ideal: 1920 } }, audio: camMode === "video" });
  camVideo.srcObject = camStream;
  await camVideo.play().catch(() => {});
  const n = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "videoinput").length;
  $("camFlip").dataset.n = n; $("camFlip").hidden = n < 2;
}
async function openCamera() {
  if (!navigator.mediaDevices?.getUserMedia) { $("cameraInput").click(); return; }   // old browsers: system camera picker
  camMode = "photo";
  camDlg.showModal();
  try { await startCam(); }
  catch (err) {
    camDlg.close();
    toast(err && err.name === "NotAllowedError" ? "Camera access was blocked. Allow it in your browser's site settings." : "Couldn't open the camera.", "error");
  }
}
wireDialog(camDlg);
camDlg.addEventListener("close", () => { stopCam(); discardRec(); if (camPlayUrl) { URL.revokeObjectURL(camPlayUrl); camPlayUrl = null; } });
$("camClose").onclick = () => camDlg.close();
$("camFlip").onclick = async () => { camFacing = camFacing === "user" ? "environment" : "user"; try { await startCam(); } catch (_) { /* keep dialog */ } };
const setCamMode = async m => { if (camMode === m) return; camMode = m; try { await startCam(); } catch (e) { camDlg.close(); toast(e && e.name === "NotAllowedError" ? "Camera or microphone access was blocked. Allow it in your browser's site settings." : "Couldn't switch the camera mode.", "error"); } };
$("camModePhoto").onclick = () => setCamMode("photo");
$("camModeVideo").onclick = () => setCamMode("video");
$("camSnap").onclick = () => {
  if (camMode === "video") {
    if (camRec) { camRec.stop(); return; }                 // Stop
    if (!camStream || !window.MediaRecorder) return toast("This browser can't record video here.", "error");
    const mime = pickMime(["video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]);
    camChunks = [];
    camRec = new MediaRecorder(camStream, mime ? { mimeType: mime } : undefined);
    camRec.ondataavailable = e => { if (e.data && e.data.size) camChunks.push(e.data); };
    camRec.onstop = () => {
      clearInterval(camTick); camTime.hidden = true;
      const type = (camRec && camRec.mimeType || mime || "video/webm").split(";")[0];
      camRec = null;
      camBlob = new Blob(camChunks, { type });
      camPlayUrl = URL.createObjectURL(camBlob); camPlay.src = camPlayUrl;
      stopCam(); camUi("review");
    };
    camRec.start(1000);
    camT0 = Date.now(); camTime.textContent = "0:00"; camTime.hidden = false;
    camTick = setInterval(() => { camTime.textContent = mmss(Date.now() - camT0); }, 250);
    camUi("recording");
    return;
  }
  const w = camVideo.videoWidth, h = camVideo.videoHeight;
  if (!w) return;
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  c.getContext("2d").drawImage(camVideo, 0, 0, w, h);
  c.toBlob(b => {
    if (!b) return;
    camBlob = b;
    camShot.src = URL.createObjectURL(b);
    stopCam(); camUi("review");
  }, "image/jpeg", 0.9);
};
$("camRetake").onclick = () => { if (camShot.src.startsWith("blob:")) URL.revokeObjectURL(camShot.src); startCam().catch(() => camDlg.close()); };
$("camSend").onclick = () => {
  if (!camBlob) return;
  const ext = camMode === "photo" ? "jpg" : /mp4/.test(camBlob.type) ? "mp4" : "webm";
  const file = new File([camBlob], (camMode === "photo" ? "photo." : "video.") + ext, { type: camBlob.type || (camMode === "photo" ? "image/jpeg" : "video/webm") });
  camDlg.close();
  sendFile(file);
};

// ---------- record audio (a voice recording sent as an audio file) ----------
const voiceDlg = $("voiceDialog"), voicePlay = $("voicePlay");
let vStream = null, vRec = null, vChunks = [], vTick = null, vT0 = 0, vBlob = null, vUrl = null, vCtx = null, vRaf = 0;
function vStop() { cancelAnimationFrame(vRaf); vStream?.getTracks().forEach(t => t.stop()); vStream = null; try { vCtx?.close(); } catch (_) { /* ignore */ } vCtx = null; $("voiceLevel").firstChild.style.width = "0"; }
function vReset() { if (vRec) { vRec.onstop = null; try { vRec.state !== "inactive" && vRec.stop(); } catch (_) { /* ignore */ } vRec = null; } clearInterval(vTick); vStop(); if (vUrl) { URL.revokeObjectURL(vUrl); vUrl = null; } vBlob = null; }
function vUi(state) {   // "idle" | "recording" | "review"
  voicePlay.hidden = state !== "review"; $("voiceLevel").hidden = state === "review";
  $("voiceRec").hidden = state === "review"; $("voiceSend").hidden = state !== "review"; $("voiceRetake").hidden = state !== "review";
  $("voiceRec").textContent = state === "recording" ? "Stop" : "Start recording"; $("voiceRec").classList.toggle("danger", state === "recording");
  if (state === "idle") $("voiceTime").textContent = "0:00";
}
wireDialog(voiceDlg);
voiceDlg.addEventListener("close", vReset);
$("voiceClose").onclick = () => voiceDlg.close();
$("pickVoiceBtn").onclick = () => { attachDialog.close(); vReset(); vUi("idle"); $("voiceMsg").textContent = ""; voiceDlg.showModal(); };
$("voiceRetake").onclick = () => { vReset(); vUi("idle"); };
$("voiceRec").onclick = async () => {
  if (vRec) { vRec.stop(); return; }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { $("voiceMsg").textContent = "This browser can't record audio."; return; }
  try { vStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (err) { $("voiceMsg").textContent = err && err.name === "NotAllowedError" ? "Microphone access was blocked. Allow it in your browser's site settings." : "Couldn't open the microphone."; return; }
  $("voiceMsg").textContent = "";
  const mime = pickMime(["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]);
  vChunks = [];
  vRec = new MediaRecorder(vStream, mime ? { mimeType: mime } : undefined);
  vRec.ondataavailable = e => { if (e.data && e.data.size) vChunks.push(e.data); };
  vRec.onstop = () => {
    clearInterval(vTick);
    const type = (vRec && vRec.mimeType || mime || "audio/webm").split(";")[0];
    vRec = null; vStop();
    vBlob = new Blob(vChunks, { type });
    vUrl = URL.createObjectURL(vBlob); voicePlay.src = vUrl;
    vUi("review");
  };
  vRec.start(1000);
  // live level meter
  try {
    vCtx = new (window.AudioContext || window.webkitAudioContext)();
    const an = vCtx.createAnalyser(); an.fftSize = 512; vCtx.createMediaStreamSource(vStream).connect(an);
    const buf = new Uint8Array(an.fftSize);
    const loop = () => { an.getByteTimeDomainData(buf); let m = 0; for (const v of buf) m = Math.max(m, Math.abs(v - 128)); $("voiceLevel").firstChild.style.width = Math.min(100, m / 128 * 140) + "%"; vRaf = requestAnimationFrame(loop); };
    loop();
  } catch (_) { /* no meter */ }
  vT0 = Date.now(); $("voiceTime").textContent = "0:00";
  vTick = setInterval(() => { $("voiceTime").textContent = mmss(Date.now() - vT0); }, 250);
  vUi("recording");
};
$("voiceSend").onclick = () => {
  if (!vBlob) return;
  const d = new Date(), p = n => String(n).padStart(2, "0");
  const ext = /mp4|aac/.test(vBlob.type) ? "m4a" : /ogg/.test(vBlob.type) ? "ogg" : "webm";
  const file = new File([vBlob], `recording-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`, { type: vBlob.type || "audio/webm" });
  voiceDlg.close();
  sendFile(file);
};

markReady();   // tells the app shell this frame booted (see frame watchdog in shell.js)
