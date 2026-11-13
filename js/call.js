// Group call page. Orchestrates: local media → room (Firebase sessions/inbox) → one PeerLink per remote
// *session* → tiles/layout. Each device/tab is its own session, so one account on two devices is two
// participants in the mesh (clearly labelled), never one clobbering the other.
import { track, secsBucket } from "./analytics.js";
import { askScreenSettings } from "./call/sharedialog.js";
import { clearScreenOverride } from "./screenprefs.js";
import { audioSettingsNode, applyOutput, applyNativeAudio } from "./call/devices.js";
import { toggleDevPanel, callSnapshot } from "./call/devstats.js";
import { plain } from "./dev.js";
import { auth, db } from "./firebase.js";
import { onAuthStateChanged } from "./sdk.js";
import {
  ref, get, set, query, orderByKey, limitToLast, onChildAdded, onChildRemoved, onValue
} from "./sdk.js";
import { avatarEl, icon, hydrateIcons, toast, confirmDialog } from "./ui.js";
import { requireVerified, isVerified } from "./verify.js";
import { fmtDuration } from "./call-banner.js";
import { QM, enterShell, toTop, markReady } from "./embed.js";
import { logEvent } from "./catlog.js";
import { getProfile } from "./users.js";
import { CallRoom } from "./call/signal.js";
import { PeerLink, LINK, worstState } from "./call/mesh.js";
import { LocalMedia } from "./call/media.js";
import { RTC_CONFIG } from "./call/rtc-config.js";
import { gridSizes, spotlightSizes } from "./call/layout.js";
import { Tile } from "./call/tile.js";
import { deviceLabel } from "./call/device.js";
import { watchRing, startRing, clearRing, declineRing } from "./call/ring.js";

hydrateIcons();

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const chatId = params.get("chatId");
if (!chatId || !/^[\w-]{1,64}$/.test(chatId)) {
  toTop("index.html");
  throw new Error("Missing or invalid chatId");
}
if (enterShell(`chat=${encodeURIComponent(chatId)}&call=${Date.now()}`)) throw new Error("Redirecting into the app shell");
const DEBUG = params.has("debug");
const dbg = (...a) => { if (DEBUG) console.log("[call]", ...a); };

// ---------------------------------------------------------------- state
const S = {
  me: null,
  participants: [],
  profiles: new Map(),
  customName: "",
  room: null,
  media: null,
  joined: false,
  joining: false,
  online: true,
  sessions: {},
  links: new Map(),          // remote sessionId -> PeerLink
  remote: new Map(),         // remote sessionId -> { streams: Map<streamId, MediaStream> }
  pendingSignals: new Map(), // sessionId -> [msg]  (signal arrived before we knew the session)
  tiles: new Map(),          // key -> Tile      (key = sessionId or sessionId + ":screen")
  selfTile: null,
  pinnedKey: null,
  knownScreens: new Set(),
  preferSelfInGrid: false,
  selfInGrid: false,
  corner: "br",
  declined: new Map(),       // uid -> until (ms): they declined, so ringing them is locked for a minute
  ringStates: new Map(),     // uid -> status text
  incomingRing: null,
  stopRingWatch: null,
  wakeLock: null,
  lastCamTrackId: null
};
try { S.preferSelfInGrid = sessionStorage.getItem("qm-self-grid") === "1"; S.corner = sessionStorage.getItem("qm-self-corner") || "br"; } catch (_) { /* storage blocked */ }

// ---------------------------------------------------------------- elements
const el = {
  lobby: $("lobby"), lobbyAvatar: $("lobbyAvatar"), lobbyTitle: $("lobbyTitle"), lobbyText: $("lobbyText"), joinBtn: $("joinBtn"), ringAllBtn: $("ringAllBtn"),
  root: $("callRoot"), safe: $("safe"), grid: $("grid"), floatLayer: $("floatLayer"),
  lobbyBack: $("lobbyBack"), top: $("top"), dock: $("dock"), notices: $("notices"),
  title: $("callTitle"), status: $("callStatus"), headAvatar: $("headAvatar"), backLink: $("backLink"),
  peopleBtn: $("peopleBtn"), peopleBadge: $("peopleBadge"), people: $("people"), peopleList: $("peopleList"), peopleClose: $("peopleClose"),
  chatBtn: $("chatBtn"), chatBadge: $("chatBadge"), chat: $("chat"), chatFrame: $("chatFrame"), chatClose: $("chatClose"), chatHeadTitle: $("chatHeadTitle"),
  mute: $("muteBtn"), deafen: $("deafenBtn"), cam: $("cameraBtn"), screen: $("screenBtn"), sw: $("switchBtn"), end: $("endBtn"),
  incoming: $("incomingDialog"), incomingProfile: $("incomingProfile"), incomingText: $("incomingText"),
  accept: $("acceptCallBtn"), decline: $("declineCallBtn")
};
const CHAT_URL = `message.html?chatId=${encodeURIComponent(chatId)}`;
document.querySelectorAll("[data-chat-link]").forEach(a => {
  a.href = CHAT_URL;
  // Inside the app shell the arrow only minimises the call (you stay in it and can browse other chats).
  if (QM) a.addEventListener("click", e => { e.preventDefault(); QM.minimizeCall(); });
});
el.end.innerHTML = icon("phoneOff", 22);

const profileOf = uid => S.profiles.get(uid) || { uid, displayName: "Someone", pfp: "" };
const mySid = () => S.room?.sessionId;

// ---------------------------------------------------------------- lobby / stage switching
function showLobby({ title, text, busy = false, canJoin = false }) {
  el.root.hidden = true;
  el.lobby.hidden = false;
  el.lobbyTitle.textContent = title ?? el.lobbyTitle.textContent;
  el.lobbyText.textContent = text;
  el.joinBtn.hidden = !canJoin;
  const old = el.lobby.querySelector(".spinner");
  if (busy && !old) { const sp = document.createElement("div"); sp.className = "spinner"; el.lobbyText.before(sp); }
  if (!busy && old) old.remove();
}

function showStage() {
  el.lobby.hidden = true;
  el.root.hidden = false;
  measure();
}

// ---------------------------------------------------------------- notices (stacked inside the header layer)
const notices = new Map();
function setNotice(id, { text, tone = "", action, dismissible = false }) {
  let n = notices.get(id);
  if (!n) {
    n = document.createElement("div");
    n.className = "notice";
    n.dataset.id = id;
    notices.set(id, n);
    el.notices.append(n);
  }
  n.className = "notice " + tone;
  n.replaceChildren();
  const t = document.createElement("span");
  t.className = "txt";
  t.textContent = text;
  n.append(t);
  if (action) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = action.label;
    b.onclick = action.run;
    n.append(b);
  }
  if (dismissible) {
    const x = document.createElement("button");
    x.type = "button";
    x.className = "quiet";
    x.setAttribute("aria-label", "Dismiss");
    x.innerHTML = icon("close", 16);
    x.onclick = () => clearNotice(id);
    n.append(x);
  }
}
function clearNotice(id) { notices.get(id)?.remove(); notices.delete(id); }

// ---------------------------------------------------------------- chat info
async function loadChat() {
  const [pSnap, nSnap, phSnap] = await Promise.all([
    get(ref(db, `privateChats/${chatId}/participants`)),
    get(ref(db, `privateChats/${chatId}/chatData/name`)),
    get(ref(db, `privateChats/${chatId}/chatData/photo`)).catch(() => null)
  ]);
  const value = pSnap.val() || {};
  if (!value[S.me]) throw new Error("You're no longer in this chat.");
  S.participants = Object.keys(value);
  S.customName = nSnap.val() || "";
  const loaded = await Promise.all(S.participants.map(getProfile));
  S.profiles = new Map(loaded.map(p => [p.uid, p]));

  const others = S.participants.filter(u => u !== S.me).map(u => profileOf(u).displayName);
  const title = S.customName.trim() || others.join(", ") || "Call";
  el.title.textContent = title;
  el.lobbyTitle.textContent = title;
  el.chatHeadTitle.textContent = "Chat";
  document.title = `${title} · QuickMessage`;
  const useOther = !S.customName.trim() && others.length === 1;
  const other = S.participants.find(u => u !== S.me);
  // the chat's picture: the group photo if it has one, else the other person's photo (1:1), else a letter
  const groupPhoto = (phSnap && phSnap.val()) || "";
  S.photo = groupPhoto || (others.length === 1 ? profileOf(other).pfp || "" : "");
  el.headAvatar.replaceChildren(avatarEl(title, S.photo, "avatar sm"));
  el.lobbyAvatar.replaceChildren(avatarEl(title, S.photo, "avatar-lg"));
}

// ---------------------------------------------------------------- measuring (keeps video clear of header/controls)
function measure() {
  const vertical = matchMedia("(max-height: 470px) and (orientation: landscape)").matches;
  const root = document.documentElement.style;
  root.setProperty("--top-h", el.top.offsetHeight + "px");
  root.setProperty("--dock-h", vertical ? "0px" : el.dock.offsetHeight + "px");
  root.setProperty("--dock-w", vertical ? el.dock.offsetWidth + "px" : "0px");
}
new ResizeObserver(measure).observe(el.top);
new ResizeObserver(measure).observe(el.dock);
addEventListener("orientationchange", () => setTimeout(measure, 150));
new ResizeObserver(() => { layout(); placeFloat(false); }).observe(el.safe);
new MutationObserver(() => layout()).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

// ---------------------------------------------------------------- joining
async function join() {
  if (S.joining || S.joined) return;
  if (!isVerified()) {            // unverified accounts may sit in the chat but can't join calls (the database rules agree)
    showLobby({ text: "Verify your email to join calls. Check your inbox for the verification link, then reload this page.", canJoin: false });
    requireVerified("join calls");
    return;
  }
  S.joining = true;
  showLobby({ text: "Getting your microphone and camera ready… (allow access if your browser asks)", busy: true });

  try {
    const media = (S.media = new LocalMedia({
      onSlot: (slot, track, stream) => { for (const l of S.links.values()) l.setTrack(slot, track, stream).catch(e => dbg("setTrack", slot, e)); },
      onChange: onMediaChange,
      log: dbg
    }));
    await media.init();

    const room = (S.room = new CallRoom({
      chatId, uid: S.me,
      onSessions: syncSessions,
      onSignal: routeSignal,
      onReset: onRoomReset,
      onConnection: online => { S.online = online; online ? clearNotice("offline") : setNotice("offline", { text: "You're offline. Trying to reconnect…", tone: "bad" }); },
      log: dbg
    }));
    S.joined = true;
    setTimeout(applyNativeAudio, 700);              // Android: use the saved microphone / speaker (the app starts in speakerphone mode)
    await room.join({
      device: deviceLabel(),
      audio: media.micOn, video: media.camOn, screen: false,
      camStream: media.camStream.id, screenStream: null
    });

    S.joinedAt = Date.now();
    track("call_joined", { video: !!media.camOn, audio: !!media.micOn });
    clearRing(chatId, S.me);                      // stop other devices of mine from ringing
    startChat();
    startDuration();
    createSelfTile();
    showStage();
    onMediaChange();
    announceMediaProblems();
    requestWakeLock();
    render();
  } catch (err) {
    console.error(err);
    await teardown();
    showLobby({ text: err.message || "Couldn't join the call.", canJoin: true });
    toast(err.message || "Couldn't join the call.", "error");
  } finally {
    S.joining = false;
  }
}

function announceMediaProblems() {
  const m = S.media;
  if (m.micError === "denied" && m.camError === "denied") {
    setNotice("media", { tone: "warn", dismissible: true, text: "Your microphone and camera are blocked, so you're listening only. Allow them in your browser's site settings, then rejoin." });
  } else if (m.micError === "denied") {
    setNotice("media", { tone: "warn", dismissible: true, text: "Your microphone is blocked — others can't hear you. Allow it in your browser's site settings." });
  } else if (!m.mic && !m.cam) {
    setNotice("media", { tone: "warn", dismissible: true, text: "No microphone or camera found — you're listening only." });
  }
}

async function leave(showLobbyAfter = true) {
  if (!S.joined && !S.joining) return;
  if (S.joinedAt) track("call_left", { length: secsBucket((Date.now() - S.joinedAt) / 1000) });
  await teardown();
  // Hanging up returns to this chat's room (not the home page).
  if (showLobbyAfter) { if (QM) QM.callEnded(chatId); else location.replace(CHAT_URL); }
}

async function teardown() {
  // Last one out writes "Call ended · duration" into the chat (we're still a member, so the rules allow it).
  const wasLast = S.joined && S.room && Object.keys(S.sessions || {}).filter(k => k !== S.room.sessionId).length === 0;
  const callDur = wasLast && callStart() ? S.room.now() - callStart() : null;
  S.joined = false;
  for (const sid of [...S.links.keys()]) destroyLink(sid, false);
  S.pendingSignals.clear();
  for (const t of S.tiles.values()) t.destroy();
  S.tiles.clear();
  S.selfTile?.destroy();
  S.selfTile = null;
  S.pinnedKey = null;
  S.knownScreens.clear();
  for (const id of [...notices.keys()]) clearNotice(id);
  el.people.hidden = true;
  el.peopleBtn.setAttribute("aria-expanded", "false");
  stopChat();
  stopDuration();
  S.knownSids = null; S.knownSince = 0;
  queueMicrotask(pushShellState);
  S.media?.destroy();
  S.media = null;
  const room = S.room;
  S.room = null;
  S.sessions = {};
  releaseWakeLock();
  try { await room?.leave(); } catch (_) { /* ignore */ }
  if (callDur !== null) logEvent(chatId, S.me, { event: "call_end", duration: callDur });
}

// ---------------------------------------------------------------- sessions → links
function syncSessions(sessions) {
  if (!S.joined) return;
  S.sessions = sessions;
  announceChanges(sessions);
  for (const [sid, s] of Object.entries(sessions)) {
    if (sid !== mySid() && !S.links.has(sid)) createLink(sid, s);
  }
  for (const sid of [...S.links.keys()]) if (!sessions[sid]) destroyLink(sid);
  render();
}

// "X joined" / "X left" toasts (not for the people already there when we arrive)
function announceChanges(sessions) {
  const now = new Map(Object.entries(sessions).map(([sid, s]) => [sid, s]));
  if (!S.knownSids && now.size <= 1 && S.me) logEvent(chatId, S.me, { event: "call_start" });   // first one in
  if (!S.knownSince) S.knownSince = Date.now();
  if (S.knownSids) {
    for (const [sid, s] of now) {
      if (S.knownSids.has(sid) || sid === mySid()) continue;
      const mine = s.uid === S.me;
      toast(mine ? `Your other device joined${s.device ? " (" + s.device + ")" : ""}` : `${profileOf(s.uid).displayName} joined the call`, "info", 3000);
    }
    for (const [sid, s] of S.knownSids) {
      if (now.has(sid)) continue;
      const mine = s.uid === S.me;
      // a leftover copy of our own previous session disappearing right after we rejoin is not "another device leaving"
      if (mine && (Date.now() - S.knownSince < 20000 || sid === mySid())) continue;
      toast(mine ? "Your other device left the call" : `${profileOf(s.uid).displayName} left the call`, "info", 3000);
    }
  }
  S.knownSids = new Map(now);
}

function createLink(sid, info) {
  const media = S.media, room = S.room;
  S.remote.set(sid, { streams: new Map() });
  const link = new PeerLink({
    selfId: room.sessionId, peerId: sid, rtcConfig: RTC_CONFIG, camStream: media.camStream,
    send: msg => room.send(info.uid, sid, msg),
    onTrack: (track, stream) => onRemoteTrack(sid, track, stream),
    onState: state => { room.setLinkState(sid, state); render(); },
    log: (...a) => dbg(sid.slice(-4), ...a)
  });
  S.links.set(sid, link);
  room.setLinkState(sid, link.state);

  if (media.mic) link.setTrack("mic", media.mic).catch(e => dbg(e));
  if (media.cam) link.setTrack("cam", media.cam).catch(e => dbg(e));
  if (media.screen) {
    link.setTrack("screen", media.screen.video, media.screen.stream).catch(e => dbg(e));
    if (media.screen.audio) link.setTrack("screenAudio", media.screen.audio, media.screen.stream).catch(e => dbg(e));
  }
  for (const msg of S.pendingSignals.get(sid) || []) link.handleSignal(msg);
  S.pendingSignals.delete(sid);
}

function destroyLink(sid, rerender = true) {
  const link = S.links.get(sid);
  if (link) link.close();
  S.links.delete(sid);
  S.remote.delete(sid);
  S.room?.setLinkState(sid, null);
  if (S.pinnedKey && S.pinnedKey.startsWith(sid)) S.pinnedKey = null;
  if (rerender) render();
}

function routeSignal(msg) {
  const link = S.links.get(msg.from);
  if (link) { link.handleSignal(msg); return; }
  // Signal from a session we haven't seen listed yet: hold it briefly.
  const q = S.pendingSignals.get(msg.from) || [];
  q.push(msg);
  S.pendingSignals.set(msg.from, q);
  setTimeout(() => { if (!S.links.has(msg.from)) S.pendingSignals.delete(msg.from); }, 15000);
}

// Our session was dropped by the server and re-created → peers rebuilt their side, so rebuild ours too.
function onRoomReset() {
  for (const sid of [...S.links.keys()]) destroyLink(sid, false);
  toast("Reconnected to the call.", "info");
  render();
}

function onRemoteTrack(sid, track, stream) {
  const r = S.remote.get(sid);
  if (!r) return;
  const s = stream || new MediaStream([track]);
  r.streams.set(s.id, s);
  const refresh = () => render();
  track.addEventListener("ended", refresh);
  s.addEventListener("removetrack", refresh);
  render();
}

// ---------------------------------------------------------------- local media → published state, dock
function onMediaChange() {
  const m = S.media;
  if (!m) return;
  queueMicrotask(pushShellState);
  S.room?.updateState({
    audio: m.micOn, video: m.camOn && !!m.cam, deaf: !!S.deafened,
    screen: !!m.screen, screenStream: m.screen ? m.screen.stream.id : null
  });
  updateDock();
  if (S.selfTile) updateSelfTile();
  if (!!m.screen !== !!S.hadScreen) { S.hadScreen = !!m.screen; render(); }
}

function setCtl(btn, { icon: name, label, off = false, on = false, disabled = false, hidden = false }) {
  btn.innerHTML = icon(name, 22);
  btn.setAttribute("aria-label", label);
  btn.title = label;
  btn.classList.toggle("off", off);
  btn.classList.toggle("on", on);
  btn.setAttribute("aria-pressed", String(off || on));
  btn.disabled = disabled;
  btn.hidden = hidden;
}

// ---------------------------------------------------------------- dock overflow: what doesn't fit goes behind a ⋯ button
const dockPill = el.dock.querySelector(".dock-pill"), moreBtn = $("moreBtn"), dockMenu = $("dockMenu");
const dockHome = [...dockPill.children];                          // the original order, so everything can go back
const DOCK_MOVE_ORDER = ["pipAllBtn", "devCallBtn", "audioBtn", "switchBtn", "chatBtn", "screenBtn", "cameraBtn", "deafenBtn"];   // first to leave the bar … last
let fitting = false;
function fitDock() {
  if (fitting) return; fitting = true;
  try {
    dockPill.append(...dockHome);                                 // everything back in place (also re-parents moved buttons)
    dockMenu.replaceChildren(); moreBtn.hidden = true;
    const cs = getComputedStyle(el.dock), vert = getComputedStyle(dockPill).flexDirection === "column";
    const avail = vert ? el.dock.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) : el.dock.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const size = () => (vert ? dockPill.offsetHeight : dockPill.offsetWidth);
    if (avail > 0 && size() > avail + 0.5) {
      moreBtn.hidden = false;
      for (const id of DOCK_MOVE_ORDER) {
        if (size() <= avail + 0.5) break;
        const b = $(id);
        if (b && !b.hidden && b.offsetParent !== null) dockMenu.append(b);
      }
      if (!dockMenu.children.length) moreBtn.hidden = true;
    }
    if (moreBtn.hidden) closeDockMenu();
    syncMoreBadge();
  } finally { fitting = false; }
}
function syncMoreBadge() { moreBtn.classList.toggle("badged", !!dockMenu.querySelector(".badge:not([hidden])")); }
function closeDockMenu() { dockMenu.hidden = true; moreBtn.setAttribute("aria-expanded", "false"); }
moreBtn.onclick = e => { e.stopPropagation(); const open = dockMenu.hidden; dockMenu.hidden = !open; moreBtn.setAttribute("aria-expanded", String(open)); };
document.addEventListener("pointerdown", e => { if (!dockMenu.hidden && !dockMenu.contains(e.target) && !moreBtn.contains(e.target)) closeDockMenu(); });
dockMenu.addEventListener("click", e => { if (e.target.closest("button") && !e.target.closest("#chatBtn")) setTimeout(closeDockMenu, 0); else if (e.target.closest("#chatBtn")) closeDockMenu(); });
new ResizeObserver(() => requestAnimationFrame(fitDock)).observe(el.dock);
addEventListener("resize", () => requestAnimationFrame(fitDock));
new MutationObserver(recs => { if (recs.some(r => r.target !== moreBtn)) requestAnimationFrame(fitDock); }).observe(dockPill, { attributes: true, attributeFilter: ["hidden"], subtree: true });
new MutationObserver(syncMoreBadge).observe(dockMenu, { attributes: true, subtree: true, attributeFilter: ["hidden"] });

function updateDock() {
  const m = S.media;
  if (!m) return;
  setCtl(el.mute, {
    icon: m.micOn ? "mic" : "micOff",
    label: !m.canMic ? (m.micError === "denied" ? "Microphone blocked in browser settings" : "No microphone found")
      : m.micOn ? "Mute microphone" : "Unmute microphone",
    off: !m.micOn, disabled: !m.canMic
  });
  setCtl(el.deafen, {
    icon: S.deafened ? "headphonesOff" : "headphones",
    label: S.deafened ? "Undeafen (hear everyone again)" : "Deafen (stop hearing everyone)",
    on: !!S.deafened
  });
  setCtl(el.cam, {
    icon: m.camOn ? "camera" : "cameraOff",
    label: !m.canCam ? (m.camError === "denied" ? "Camera blocked in browser settings" : "No camera found")
      : m.camOn ? "Turn camera off" : "Turn camera on",
    off: !m.camOn, disabled: !m.canCam
  });
  setCtl(el.screen, {
    icon: m.screen ? "monitorOff" : "monitor",
    label: m.screen ? "Stop sharing" : "Share screen",
    on: !!m.screen, hidden: !m.canScreen
  });
  setCtl(el.sw, { icon: "refresh", label: "Switch camera", hidden: !m.canSwitch });
  el.end.setAttribute("aria-label", "Leave call");
  el.end.title = "Leave call";

  if (m.screen) {
    setNotice("sharing", { tone: "", text: "You're sharing your screen", action: { label: "Stop sharing", run: () => m.stopScreen() } });
  } else clearNotice("sharing");
  measure(); fitDock();
}

el.mute.onclick = () => S.media?.toggleMic();
/** Deafen: nobody in the call is played on this device, and everyone sees the headphones icon on your tile. */
function setDeafened(on) {
  S.deafened = !!on;
  S.tiles.forEach(t => { if (!t.isSelf) t.setDeafened(S.deafened); });
  S.room?.updateState({ deaf: S.deafened });
  updateDock(); if (S.selfTile) updateSelfTile(); queueMicrotask(pushShellState);
}
el.deafen.onclick = () => setDeafened(!S.deafened);
el.cam.onclick = async () => {
  try { await S.media.toggleCam(); }
  catch (err) { toast(err.name === "NotAllowedError" ? "Camera is blocked in your browser settings." : "Couldn't start the camera.", "error"); }
};
// Pop the WHOLE call out (the per-person pop-out button on a tile pops out just that person's video).
// App: Android's own picture-in-picture. Browser: a Document Picture-in-Picture window holding the call grid.
$("pipAllBtn").innerHTML = icon("popout", 22);
{   // hide the button where nothing can pop the whole call out (Android has its own picture-in-picture; browsers need Document PiP)
  let can = !!(window.QMApp && window.QMApp.enterPip);
  try { can = can || !!(window.top || window).documentPictureInPicture; } catch (_) { can = can || !!window.documentPictureInPicture; }
  if (!can) $("pipAllBtn").hidden = true;
}
$("pipAllBtn").onclick = async () => {
  if (window.QMApp && window.QMApp.enterPip) {
    // whole-call pop-out: make sure no single person's tile is still marked as the pop-out target
    document.documentElement.classList.remove("pip-tile");
    document.querySelectorAll(".tile.pip-target").forEach(t => t.classList.remove("pip-target"));
    window.QMApp.enterPip(); return;
  }
  // Document Picture-in-Picture only works from the top-level window; the call page lives in an iframe, so use the top's API.
  let dpip = null; try { dpip = (window.top || window).documentPictureInPicture; } catch (_) { dpip = window.documentPictureInPicture; }
  if (!dpip) { toast("Your browser can't pop out the whole call. Use the pop-out button on a person's video instead.", "info", 4500); return; }
  if (dpip.window) { dpip.window.close(); return; }
  try {
    const w = await dpip.requestWindow({ width: 520, height: 320 });
    for (const ss of document.styleSheets) {
      try { const s = document.createElement("style"); s.textContent = [...ss.cssRules].map(r => r.cssText).join("\n"); w.document.head.append(s); }
      catch (_) { if (ss.href) { const l = document.createElement("link"); l.rel = "stylesheet"; l.href = ss.href; w.document.head.append(l); } }
    }
    w.document.documentElement.dataset.theme = "dark";
    const wrap = w.document.createElement("div"); wrap.className = "call-root"; wrap.style.cssText = "position:fixed;inset:0";
    const safe = $("safe"), home = safe.parentNode;
    wrap.append(safe); w.document.body.style.margin = "0"; w.document.body.append(wrap);
    w.addEventListener("pagehide", () => { home.prepend(safe); });
  } catch (err) { console.warn("[pip] couldn't open", err); toast("Couldn't pop out the call.", "error"); }
};

el.sw.onclick = async () => {
  try { await S.media.switchCamera(); } catch (err) { toast("Couldn't switch camera.", "error"); }
};
el.screen.onclick = () => shareScreen(false);
/** quick = started from the notification / PiP: no dialog (the app may not even be on screen), saved defaults are used. */
async function shareScreen(quick) {
  const m = S.media;
  if (!m) return;
  if (m.screen) { m.stopScreen(); return; }
  if (!quick && !(await askScreenSettings())) return;
  try {
    const s = await m.startScreen();
    if (!s) { clearScreenOverride(); return; }
    for (const l of S.links.values()) {
      l.setTrack("screen", s.video, s.stream).catch(e => dbg(e));
      if (s.audio) l.setTrack("screenAudio", s.audio, s.stream).catch(e => dbg(e));
    }
  } catch (err) {
    console.error(err); clearScreenOverride();
    toast("Couldn't start screen sharing.", "error");
  }
}
el.end.onclick = () => leave(true);
el.joinBtn.onclick = () => join();

document.addEventListener("keydown", e => {
  if (e.target.closest("input,textarea,select") || e.ctrlKey || e.metaKey || e.altKey || !S.joined) return;
  if (e.key === "m") S.media?.toggleMic();
  else if (e.key === "v") el.cam.click();
});

// ---------------------------------------------------------------- tiles
function newTile(key, kind, isSelf = false) {
  const tile = new Tile({
    key, kind, isSelf,
    onPin: k => { S.pinnedKey = S.pinnedKey === k ? null : k; render(); },
    onRetry: k => S.links.get(k.split(":")[0])?.restart(),
    onBlocked: () => setNotice("audio", {
      tone: "warn", text: "Your browser is blocking call audio until you tap.",
      action: { label: "Enable audio", run: () => { S.tiles.forEach(t => t.play()); clearNotice("audio"); } }
    })
  });
  el.grid.append(tile.el);
  S.tiles.set(key, tile);
  if (S.deafened && !isSelf) tile.setDeafened(true);
  return tile;
}

function createSelfTile() {
  const tile = new Tile({
    key: "self", kind: "cam", isSelf: true,
    onPin: k => { S.pinnedKey = S.pinnedKey === k ? null : k; render(); },
    onSelfToggle: () => toggleSelfPlacement()
  });
  tile.setName("You", "");
  tile.setAvatar(profileOf(S.me));
  tile.setStream(S.media.preview);
  tile.el.classList.add("self-float");
  tile.el.setAttribute("aria-label", "Your video. Drag to move; double-click to move it into the grid.");
  S.selfTile = tile;
  initFloatDrag(tile);
  el.floatLayer.append(tile.el);
  updateSelfTile();
}

function updateSelfTile() {
  const m = S.media, t = S.selfTile;
  if (!m || !t) return;
  const camId = m.cam ? m.cam.id : null;
  if (camId !== S.lastCamTrackId) { S.lastCamTrackId = camId; t.setStream(m.preview, true); }
  t.setMedia({ audio: m.micOn, video: m.camOn && !!m.cam, deaf: !!S.deafened, mirror: (() => { try { return !(m.cam && m.cam.getSettings().facingMode === "environment"); } catch (_) { return true; } })() });
  const micId = m.mic ? m.mic.id : null;
  if (micId !== S.lastMicTrackId) { S.lastMicTrackId = micId; t.setAudioSource(m.mic ? new MediaStream([m.mic]) : null); }
  t.setAvatar(profileOf(S.me));
  t.selfBtn.innerHTML = icon(S.selfInGrid ? "pip" : "grid", 16);
  t.selfBtn.title = S.selfInGrid ? "Float my video" : "Move my video into the grid";
  t.selfBtn.setAttribute("aria-label", t.selfBtn.title);
}

function toggleSelfPlacement() {
  S.preferSelfInGrid = !S.preferSelfInGrid;
  try { sessionStorage.setItem("qm-self-grid", S.preferSelfInGrid ? "1" : "0"); } catch (_) { /* ignore */ }
  render();
}

// ---------------------------------------------------------------- render: reconcile tiles with sessions/state
function remoteList() {
  return Object.entries(S.sessions)
    .filter(([sid]) => sid !== mySid())
    .map(([sid, s]) => ({ sid, ...s }))
    .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0) || (a.sid < b.sid ? -1 : 1));
}

function render() {
  if (!S.joined || !S.room) return;
  const list = remoteList();
  const want = new Set();
  const mine = Object.values(S.sessions).filter(s => s.uid === S.me).length;
  const sameUid = new Map();
  for (const s of list) sameUid.set(s.uid, (sameUid.get(s.uid) || 0) + 1);

  const screenKeys = new Set();
  let order = 0;
  const ordered = [];

  for (const s of list) {
    const link = S.links.get(s.sid);
    const r = S.remote.get(s.sid);
    const prof = profileOf(s.uid);
    const isMine = s.uid === S.me;
    const multi = isMine || sameUid.get(s.uid) > 1;
    const name = isMine ? "You" : prof.displayName;
    const tag = isMine ? `Your other device${s.device ? " · " + s.device : ""}` : (multi && s.device ? s.device : "");
    const state = worstState(link?.state, s.links?.[mySid()]);

    // camera tile (always present while the session is in the call: it also carries the audio)
    let tile = S.tiles.get(s.sid) || newTile(s.sid, "cam");
    want.add(s.sid);
    const stream = r && (r.streams.get(s.camStream) || [...r.streams.values()].find(x => x.id !== s.screenStream && x.getAudioTracks().length + x.getVideoTracks().length > 0));
    tile.setName(name, tag);
    tile.setAvatar(prof);
    tile.setStream(stream || null);
    tile.setMedia({ audio: s.audio, video: s.video, deaf: !!s.deaf });
    tile.setLinkState(state);
    tile.setHasAudio(true);
    if (isMine && !tile._volInit) { tile._volInit = true; tile.setVolume(0); } // don't echo my own other device by default
    tile.el.style.order = String(order++);
    ordered.push(tile);

    // screen share tile: its own tile, never replaces the camera
    const screenStream = s.screen && r && r.streams.get(s.screenStream);
    if (screenStream) {
      const key = s.sid + ":screen";
      let st = S.tiles.get(key) || newTile(key, "screen");
      want.add(key);
      screenKeys.add(key);
      st.setName(`${name}'s screen`, isMine ? "Your other device" : "");
      st.setAvatar(prof);
      st.setStream(screenStream);
      st.setMedia({ audio: true, video: true });
      st.setHasAudio(screenStream.getAudioTracks().length > 0);
      st.setLinkState(state);
      st.el.style.order = String(order++);
      ordered.push(st);
    }
  }

  // my own shared screen: shown to me too, so I can see what everyone else is seeing
  if (S.media?.screen) {
    const key = "self:screen";
    let st = S.tiles.get(key) || newTile(key, "screen", true);
    want.add(key);
    screenKeys.add(key);
    st.setName("Your screen", "Preview");
    st.setAvatar(profileOf(S.me));
    st.setStream(S.media.screen.stream.getVideoTracks().length ? new MediaStream(S.media.screen.stream.getVideoTracks()) : null);
    st.setMedia({ audio: true, video: true });
    st.el.style.order = String(order++);
    ordered.push(st);
  }

  for (const [key, t] of [...S.tiles]) if (!want.has(key)) { t.destroy(); S.tiles.delete(key); if (S.pinnedKey === key) S.pinnedKey = null; }

  // a new screen share re-enables the automatic spotlight
  // a new stream gets pinned — unless something is already pinned, which always wins
  for (const k of screenKeys) if (!S.knownScreens.has(k) && !S.pinnedKey) S.pinnedKey = k;
  S.knownScreens = screenKeys;

  // where does my own video live? floating, unless I chose the grid or nobody else is here
  S.selfInGrid = S.preferSelfInGrid || list.length === 0;
  const self = S.selfTile;
  if (self) {
    const target = S.selfInGrid ? el.grid : el.floatLayer;
    if (self.el.parentElement !== target) { target.append(self.el); self.play(); }
    self.el.classList.toggle("self-float", !S.selfInGrid);
    self.el.style.transform = "";
    self.el.style.width = self.el.style.height = "";
    self.el.style.order = String(order);
    updateSelfTile();
    if (!S.selfInGrid) placeFloat(false);
  }

  layout();
  updateHeader(list, mine);
  updateNotices(list, screenKeys);
  renderPeople();
}

function gridTiles() {
  const all = [...S.tiles.values()].filter(t => t.el.parentElement === el.grid);
  if (S.selfTile && S.selfTile.el.parentElement === el.grid) all.push(S.selfTile);
  return all.sort((a, b) => Number(a.el.style.order) - Number(b.el.style.order));
}

function spotKey(tiles) {
  if (tiles.length < 2) return null;
  if (S.pinnedKey && tiles.some(t => t.key === S.pinnedKey)) return S.pinnedKey;
  return null;
}

function layout() {
  const tiles = gridTiles();
  const cs = getComputedStyle(el.grid);
  const pad = parseFloat(cs.paddingLeft) || 8;
  const gap = parseFloat(cs.columnGap) || 8;
  const W = el.grid.clientWidth - pad * 2, H = el.grid.clientHeight - pad * 2;
  el.grid.classList.remove("spot-col", "spot-row", "scroll");
  tiles.forEach(t => t.setPinned(t.key === S.pinnedKey));
  if (!tiles.length || W <= 0 || H <= 0) return;

  const spot = document.documentElement.classList.contains("qm-pip") ? null : spotKey(tiles);   // PiP: always the plain grid so everyone fits
  if (spot) {
    const z = spotlightSizes(tiles.length, W, H, gap);
    el.grid.classList.add(z.dir === "column" ? "spot-col" : "spot-row");
    let idx = 0;
    for (const t of tiles) {
      const main = t.key === spot;
      t.el.style.width = (main ? z.main.w : z.strip.w) + "px";
      t.el.style.height = (main ? z.main.h : z.strip.h) + "px";
      t.el.style.order = main ? "-1" : String(++idx);
    }
  } else {
    const inPip = document.documentElement.classList.contains("qm-pip");
    const g = gridSizes(tiles.length, W, H, gap, inPip ? 0 : 120);   // in the small PiP window every tile shrinks until all fit — no scrolling
    el.grid.classList.toggle("scroll", g.overflow);
    tiles.forEach((t, i) => { t.el.style.width = g.w + "px"; t.el.style.height = g.h + "px"; t.el.style.order = String(i); });
  }
  if (!el.grid.classList.contains("scroll")) shrinkToFit(tiles);
}

/** Safety net: if the tiles still don't fit (odd window sizes, rounding, scrollbars), shrink them all until they do, and never let
 *  the overflow be centred (which cut off the top AND the bottom): what can't fit scrolls from the top instead. */
function shrinkToFit(tiles) {
  const g = el.grid;
  for (let i = 0; i < 5; i++) {
    const oy = g.scrollHeight - g.clientHeight, ox = g.scrollWidth - g.clientWidth;
    if (oy <= 1 && ox <= 1) return;
    const f = Math.max(0.3, Math.min(g.clientHeight / (g.clientHeight + Math.max(0, oy)), g.clientWidth / (g.clientWidth + Math.max(0, ox))) * 0.985);
    for (const t of tiles) {
      t.el.style.width = Math.max(16, Math.floor(parseFloat(t.el.style.width) * f)) + "px";
      t.el.style.height = Math.max(12, Math.floor(parseFloat(t.el.style.height) * f)) + "px";
    }
  }
  if (g.scrollHeight - g.clientHeight > 1 || g.scrollWidth - g.clientWidth > 1) g.classList.add("scroll");
}

// audio devices + microphone volume (also changed from Account → Audio: the storage event reaches this frame)
const applyAudioPrefs = what => {
  if (what === "native") return;                    // already applied by the dialog
  if (!what || what === "spk") applyOutput();
  if (S.media && (!what || what === "mic")) S.media.setMicDevice(audioPrefsMic()).catch(() => toast("Couldn't switch to that microphone.", "error"));
  if (S.media && (!what || what === "vol")) S.media.setMicVolume();
};
const audioPrefsMic = () => { try { return localStorage.getItem("qm-mic-dev") || ""; } catch (_) { return ""; } };
$("audioBtn").onclick = () => confirmDialog({ title: "Audio settings", node: audioSettingsNode(applyAudioPrefs), okText: "Done", hideCancel: true });
addEventListener("storage", e => { if (e.key === "qm-app-in" || e.key === "qm-app-out") applyNativeAudio(); else if (e.key === "qm-mic-dev") applyAudioPrefs("mic"); else if (e.key === "qm-spk-dev") applyAudioPrefs("spk"); else if (e.key === "qm-mic-vol") applyAudioPrefs("vol"); });

addEventListener("qm-audio-devices", () => { if (S.joined) applyNativeAudio(); });      // Android: a headset was plugged in / removed

// developer mode: live call statistics (frame rate, bitrate, connection path, …)
$("devCallBtn").onclick = () => toggleDevPanel(S, plain);
window.__qmDev = Object.assign(window.__qmDev || {}, { call: () => callSnapshot(S) });      // lets the shell (plugins with "devinfo") read the call stats

// ---------------------------------------------------------------- app shell hooks (mini call bar)
function pushShellState() {
  try { if (window.QMApp && window.QMApp.setCallDeaf) window.QMApp.setCallDeaf(!!S.deafened, (localStorage.getItem("qm-notif-btn") || "screen") === "deafen"); } catch (_) { /* ignore */ }
  try { if (window.QMApp && window.QMApp.setPipControls) window.QMApp.setPipControls(S.media ? !S.media.micOn : false, !!(S.media && S.media.camOn && S.media.cam), !!S.media?.canCam, !!S.deafened); } catch (_) { /* ignore */ }
  if (!QM) return;
  const start = callStart();
  QM.setCallState({
    chatId, photo: S.photo || "", joined: S.joined, title: S.customName || el.title.textContent || "Call",
    muted: S.media ? !S.media.micOn : false, canMic: !!S.media?.mic, deafened: !!S.deafened,
    camOn: !!(S.media && S.media.camOn && S.media.cam), canCam: !!S.media?.canCam,
    screenOn: !!S.media?.screen, canScreen: !!S.media?.canScreen,
    uids: [...new Set(Object.values(S.sessions || {}).map(x => x.uid).concat(S.joined ? [S.me] : []))],
    // group chats: who is in the call right now (shown instead of "Ongoing call" in Android's call notification); "" for 1:1 chats
    who: S.participants.length > 2 ? [...new Set(Object.values(S.sessions || {}).map(x => x.uid))].filter(u => u !== S.me).map(u => profileOf(u).displayName).join(", ") : "",
    startLocal: start && S.room ? start - S.room.offset : null
  });
}
window.__qmCall = {
  toggleMute() { el.mute.click(); },
  toggleDeafen() { el.deafen.click(); },
  toggleCam() { el.cam.click(); },
  toggleScreen() { shareScreen(true); },
  leave: () => leave(true),
  get joined() { return S.joined; }
};

// ---------------------------------------------------------------- call duration (since the call started; stored on the server so it survives the starter leaving)
function callStart() {
  if (S.room && typeof S.room.startedAt === "number") return S.room.startedAt;   // the call's real start, not "oldest person still here"
  let start = null;
  for (const s of Object.values(S.sessions || {})) if (typeof s.joinedAt === "number" && (start === null || s.joinedAt < start)) start = s.joinedAt;
  return start;
}
function paintStatus() {
  const start = callStart();
  const dur = start && S.room ? fmtDuration(S.room.now() - start) : "";
  el.status.textContent = (S.statusBase || "") + (dur ? ` · ${dur}` : "");
  el.status.title = dur ? "Call duration" : "";
}
function startDuration() { stopDuration(); S.durTimer = setInterval(paintStatus, 1000); }
function stopDuration() { clearInterval(S.durTimer); S.durTimer = null; S.statusBase = ""; }

function updateHeader(list, mine) {
  const people = new Set([S.me, ...list.map(s => s.uid)]).size;
  const devices = list.length + 1;
  let text = people === 1 && devices === 1 ? "Only you are here" : `${people} ${people === 1 ? "person" : "people"}`;
  if (devices > people) text += ` · ${devices} devices`;
  const bad = list.some(s => worstState(S.links.get(s.sid)?.state, s.links?.[mySid()]) === LINK.FAILED);
  const trying = list.some(s => { const w = worstState(S.links.get(s.sid)?.state, s.links?.[mySid()]); return w === LINK.CONNECTING || w === LINK.RECONNECTING; });
  if (bad) text += " · some connections failed";
  else if (trying) text += " · connecting…";
  S.statusBase = text;
  paintStatus();
  pushShellState();
  el.peopleBadge.hidden = people < 2;
  el.peopleBadge.textContent = String(people);
}

function updateNotices(list, screenKeys) {
  if (!list.length) {
    setNotice("alone", {
      text: "You're the only one here.",
      action: { label: "Ring people", run: () => togglePeople(true) }
    });
  } else clearNotice("alone");

  clearNotice("spot");
}

// ---------------------------------------------------------------- floating self view (drag + snap to corners)
const FLOAT_MARGIN = 12;
function cornerPos(corner) {
  const L = el.floatLayer.getBoundingClientRect();
  const w = S.selfTile.el.offsetWidth, h = S.selfTile.el.offsetHeight;
  const x = corner.includes("l") ? FLOAT_MARGIN : L.width - w - FLOAT_MARGIN;
  const y = corner.includes("t") ? FLOAT_MARGIN : L.height - h - FLOAT_MARGIN;
  return { x: Math.max(0, x), y: Math.max(0, y) };
}

function placeFloat(animate) {
  const t = S.selfTile;
  if (!t || S.selfInGrid || t.el.classList.contains("dragging")) return;
  const { x, y } = cornerPos(S.corner);
  if (!animate) t.el.style.transition = "none";
  t.el.style.transform = `translate(${x}px, ${y}px)`;
  if (!animate) { void t.el.offsetWidth; t.el.style.transition = ""; }
}

function initFloatDrag(tile) {
  const node = tile.el;
  let start = null;

  node.addEventListener("pointerdown", e => {
    if (S.selfInGrid || e.button > 0 || e.target.closest("button,input")) return;
    const m = new DOMMatrixReadOnly(getComputedStyle(node).transform);
    start = { id: e.pointerId, px: e.clientX, py: e.clientY, x: m.m41, y: m.m42, moved: false };
    node.setPointerCapture(e.pointerId);
  });

  node.addEventListener("pointermove", e => {
    if (!start || e.pointerId !== start.id) return;
    const dx = e.clientX - start.px, dy = e.clientY - start.py;
    if (!start.moved && Math.hypot(dx, dy) < 5) return;
    start.moved = true;
    node.classList.add("dragging");
    const L = el.floatLayer.getBoundingClientRect();
    const x = Math.min(Math.max(0, start.x + dx), Math.max(0, L.width - node.offsetWidth));
    const y = Math.min(Math.max(0, start.y + dy), Math.max(0, L.height - node.offsetHeight));
    node.style.transform = `translate(${x}px, ${y}px)`;
  });

  const finish = e => {
    if (!start || e.pointerId !== start.id) return;
    const moved = start.moved;
    start = null;
    try { node.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    if (!moved) return;
    const L = el.floatLayer.getBoundingClientRect();
    const r = node.getBoundingClientRect();
    const cx = r.left + r.width / 2 - L.left, cy = r.top + r.height / 2 - L.top;
    S.corner = (cy < L.height / 2 ? "t" : "b") + (cx < L.width / 2 ? "l" : "r");
    try { sessionStorage.setItem("qm-self-corner", S.corner); } catch (_) { /* ignore */ }
    node.classList.remove("dragging");
    placeFloat(true);
  };
  node.addEventListener("pointerup", finish);
  node.addEventListener("pointercancel", finish);

  node.addEventListener("dblclick", e => { if (!e.target.closest("button,input")) { e.stopPropagation(); toggleSelfPlacement(); } }, true);
  node.addEventListener("keydown", e => {
    if (S.selfInGrid || !e.key.startsWith("Arrow")) return;
    e.preventDefault();
    const c = S.corner;
    if (e.key === "ArrowLeft") S.corner = "t" === c[0] ? "tl" : "bl";
    if (e.key === "ArrowRight") S.corner = "t" === c[0] ? "tr" : "br";
    if (e.key === "ArrowUp") S.corner = "t" + c[1];
    if (e.key === "ArrowDown") S.corner = "b" + c[1];
    placeFloat(true);
  });
}


// ---------------------------------------------------------------- in-call chat = the real chat page, in a panel
// (so nothing is lost: files, camera, read markers, editing …). The page is only loaded while the panel is open, so
// messages that arrive while it is closed stay unread and drive the badge below.
el.chatBtn.insertAdjacentHTML("afterbegin", icon("chat", 22));
const unread = { msgs: new Map(), readKey: null, since: 0, unsubs: [] };
function recountUnread() {
  let n = 0;
  for (const [key, m] of unread.msgs) if (m.fromUid !== S.me && m.type !== "event" && (!unread.readKey || key > unread.readKey)) n++;
  el.chatBadge.hidden = n === 0 || !el.chat.hidden;
  el.chatBadge.textContent = n > 9 ? "9+" : String(n);
}
function startChat() {
  stopChat();
  unread.since = Date.now() - 3000;
  const q = query(ref(db, `privateChats/${chatId}/messages`), orderByKey(), limitToLast(100));
  unread.unsubs = [
    onValue(ref(db, `privateChats/${chatId}/messageRead/${S.me}`), s => { unread.readKey = s.val() || null; recountUnread(); }, () => {}),
    onChildAdded(q, snap => {
      const m = snap.val();
      if (!m || typeof m.fromUid !== "string") return;
      unread.msgs.set(snap.key, m);
      recountUnread();
      const live = typeof m.timestamp === "number" && m.timestamp > unread.since;
      if (live && m.fromUid !== S.me && m.type !== "event" && el.chat.hidden) {
        const what = m.type === "image" ? "📷 Photo" : m.type === "video" ? "🎥 Video" : m.type === "file" ? "📎 " + (m.name || "File") : String(m.text ?? "").slice(0, 80);
        toast(`${profileOf(m.fromUid).displayName}: ${what}`, "info", 3500);
      }
    }, () => {}),
    onChildRemoved(q, snap => { unread.msgs.delete(snap.key); recountUnread(); }, () => {})
  ];
}
// The chat page is loaded lazily the first time the panel opens, then kept alive (just hidden) so closing and re-opening
// doesn't reload it or lose scroll/draft/uploads. It's only unloaded when the call is torn down.
let chatLoaded = false;
const chatUrl = () => `message.html?chatId=${encodeURIComponent(chatId)}&panel=1`;
const tellChat = visible => { try { el.chatFrame.contentWindow.postMessage({ qm: "panel", visible }, location.origin); } catch (_) { /* ignore */ } };
function unloadChat() {
  chatLoaded = false;
  try { el.chatFrame.contentWindow.location.replace("about:blank"); } catch (_) { /* ignore */ }
}
function stopChat() {
  unread.unsubs.forEach(u => { try { u(); } catch (_) { /* ignore */ } });
  unread.unsubs = []; unread.msgs.clear(); unread.readKey = null;
  closeChatPanel();
  unloadChat();
  el.chatBadge.hidden = true;
}
function closeChatPanel() {
  const wasOpen = !el.chat.hidden;
  el.chat.hidden = true;
  el.chatBtn.setAttribute("aria-expanded", "false");
  if (wasOpen && chatLoaded) tellChat(false);     // hidden but alive: the page must not mark messages read while nobody can see it
}
function toggleChat(force) {
  const open = force ?? el.chat.hidden;
  if (!open) { closeChatPanel(); recountUnread(); return; }
  togglePeople(false);
  el.chat.hidden = false;
  el.chatBtn.setAttribute("aria-expanded", "true");
  if (!chatLoaded) {
    chatLoaded = true;
    try { el.chatFrame.contentWindow.location.replace(chatUrl()); } catch (_) { el.chatFrame.src = chatUrl(); }
  } else tellChat(true);
  recountUnread();
}
el.chatBtn.onclick = () => toggleChat();
el.chatClose.onclick = () => toggleChat(false);
document.addEventListener("keydown", e => { if (e.key === "Escape" && !el.chat.hidden) toggleChat(false); });


// ---------------------------------------------------------------- people panel + ringing
function togglePeople(force) {
  const open = force ?? el.people.hidden;
  if (open && !el.chat.hidden) toggleChat(false);
  el.people.hidden = !open;
  el.peopleBtn.setAttribute("aria-expanded", String(open));
  if (open) renderPeople();
}
el.peopleBtn.onclick = () => togglePeople();
el.peopleClose.onclick = () => togglePeople(false);
document.addEventListener("keydown", e => { if (e.key === "Escape" && !el.people.hidden) togglePeople(false); });

function btnIcon(name) { const s = document.createElement("span"); s.className = "btn-ic"; s.innerHTML = icon(name, 16); return s; }
for (const [id, ic] of [["joinBtn", "phone"], ["ringAllBtn", "bell"], ["declineCallBtn", "phoneOff"], ["acceptCallBtn", "phone"], ["lobbyBack", "back"]]) {
  const b = document.getElementById(id); if (b) b.prepend(btnIcon(ic));
}

function renderPeople() {
  if (el.people.hidden || !S.joined) return;
  const byUid = new Map();
  for (const [sid, s] of Object.entries(S.sessions)) {
    if (!byUid.has(s.uid)) byUid.set(s.uid, []);
    byUid.get(s.uid).push({ sid, ...s });
  }
  el.peopleList.replaceChildren();

  const order = [S.me, ...S.participants.filter(u => u !== S.me)];
  for (const uid of order) {
    const p = profileOf(uid);
    const sess = (byUid.get(uid) || []).sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
    const isMe = uid === S.me;

    const card = document.createElement("div");
    card.className = "person";
    const row = document.createElement("div");
    row.className = "person-row";
    row.append(avatarEl(p.displayName, p.pfp, "avatar"));

    const info = document.createElement("div");
    info.className = "info";
    const nm = document.createElement("strong");
    nm.textContent = isMe ? `${p.displayName} (you)` : p.displayName;
    const stat = document.createElement("div");
    stat.className = "stat";
    const inCall = sess.length > 0;
    const ringText = S.ringStates.get(uid);
    const lockedUntil = S.declined.get(uid) || 0, isDeclined = lockedUntil > Date.now();
    stat.textContent = isDeclined ? "Declined the call" : ringText || (inCall ? `In call${sess.length > 1 ? ` · ${sess.length} devices` : ""}` : "Not in call");
    if (inCall && !ringText) stat.classList.add("live");
    if (isDeclined) stat.classList.add("declined");
    info.append(nm, stat);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn";
    const others = isMe ? sess.length >= 1 : inCall;       // ringing yourself means "my other devices"
    btn.replaceChildren(btnIcon(inCall && !isMe ? "phone" : "bell"), document.createTextNode(isMe ? "Ring my devices" : inCall ? "In call" : "Ring"));
    btn.disabled = (!isMe && inCall) || S.ringStates.has(uid) || isDeclined;
    btn.onclick = () => ringUser(uid);
    row.append(info, btn);
    card.append(row);

    if (sess.length > 1 || (isMe && sess.length)) {
      const devs = document.createElement("div");
      devs.className = "devices";
      for (const s of sess) {
        const d = document.createElement("div");
        d.className = "device";
        const dot = document.createElement("span");
        dot.className = "dot";
        const mine = s.sid === mySid();
        const st = mine ? "connected" : worstState(S.links.get(s.sid)?.state, s.links?.[mySid()]);
        dot.dataset.state = st;
        const label = document.createElement("span");
        label.textContent = (s.device || "Device");
        d.append(dot, label);
        if (mine) { const y = document.createElement("span"); y.className = "you"; y.textContent = "this device"; d.append(y); }
        if (!s.audio) { const i = document.createElement("span"); i.className = "ic"; i.innerHTML = icon("micOff", 13); i.title = "Mic off"; d.append(i); }
        if (s.deaf) { const i = document.createElement("span"); i.className = "ic"; i.innerHTML = icon("headphonesOff", 13); i.title = "Deafened"; d.append(i); }
        devs.append(d);
      }
      card.append(devs);
    }
    el.peopleList.append(card);
  }
}

el.ringAllBtn.onclick = async () => {
  if (!requireVerified("ring people")) return;
  const targets = S.participants.filter(u => u !== S.me && !S.ringStates.has(u) && !((S.declined.get(u) || 0) > Date.now()) && !Object.values(S.sessions).some(s => s.uid === u));
  if (!targets.length) return toast("Everyone is already in the call.", "info");
  const ok = await confirmDialog({
    title: "Ring everyone?",
    message: `This rings ${targets.length === 1 ? profileOf(targets[0]).displayName : targets.length + " people"} who ${targets.length === 1 ? "isn't" : "aren't"} in the call yet.`,
    okText: "Ring all"
  });
  if (ok) targets.forEach(u => ringUser(u));
};

// Someone declined: show it in red where "Notification sent" was, and lock ringing them (and "Ring all") for a minute so nobody gets spam-called.
window.__qmDeclined = (chat, by) => {
  if (chat !== chatId || !by) return;
  S.declined.set(by, Date.now() + 60000);
  S.ringStates.delete(by);
  renderPeople(); lockRingAll();
  setTimeout(() => { renderPeople(); lockRingAll(); }, 60500);
};
function lockRingAll() {
  const active = S.participants.filter(u => u !== S.me && (S.declined.get(u) || 0) > Date.now());
  const left = S.participants.filter(u => u !== S.me && !((S.declined.get(u) || 0) > Date.now()));
  el.ringAllBtn.disabled = !!active.length && !left.length;
}

async function ringUser(uid) {
  if (!requireVerified("ring people")) return;
  if ((S.declined.get(uid) || 0) > Date.now()) return toast("They just declined — you can ring them again in a minute.", "info");
  if (S.ringStates.has(uid)) return;
  const say = text => { S.ringStates.set(uid, text); renderPeople(); };
  const done = () => { S.ringStates.delete(uid); renderPeople(); };
  say("Ringing…");
  let ringId = null;
  try {
    ringId = await startRing(chatId, S.me, uid);
    // The push is sent by the notification server (worker/qm_worker.py) the moment the ring is written; it reports back in notifyStatus.
    // Nothing here touches the website's host, so it works the same from an offline copy of the site.
    let why = "";
    const status = await new Promise(res => {
      let off = () => {}, t = setTimeout(() => { off(); res("timeout"); }, 15000);
      off = onValue(ref(db, `calls/${chatId}/ringing/${uid}`), s => {
        const r = s.val() || {};
        if (r.notifyStatus === "sent" || r.notifyStatus === "no_token" || r.notifyStatus === "failed" || r.notifyStatus === "muted") {
          why = r.notifyError || ""; clearTimeout(t); off(); res(r.notifyStatus);
        }
      });
    });
    say(status === "sent" ? "Notification sent" : status === "no_token" ? "No notification device" : status === "muted" ? "Calls muted" : "Notification failed");
    if (status === "sent") toast("Ringing " + (uid === S.me ? "your other devices" : profileOf(uid).displayName), "success");
    else if (status === "no_token") toast("They haven't enabled notifications on any device — they'll only see the ring if the call page is open.", "info", 5000);
    else if (status === "muted") toast(profileOf(uid).displayName + " muted calls from this chat, so their phone won't ring.", "info", 5000);
    else if (status === "timeout") toast("The notification server didn't answer, so they may not be notified. It may be offline (see Status).", "error", 6000);
    else toast("The notification couldn't be sent" + (why ? ": " + why : "."), "error", 7000);
  } catch (err) {
    console.error(err);
    toast("Couldn't ring them.", "error");
    done();
    return;
  }
  setTimeout(() => { done(); clearRing(chatId, uid, ringId); }, 30000);
}

// ---------------------------------------------------------------- incoming rings (lobby or not-yet-joined devices)
function startRingWatch() {
  S.stopRingWatch?.();
  if (QM) return;                                // the app shell shows incoming calls full-screen
  S.stopRingWatch = watchRing(chatId, S.me, async ring => {
    if (!ring || S.joined || S.joining || ring.fromUid === S.me && false) { if (!ring) closeIncoming(); return; }
    if (ring.notifyStatus === "declined") return;
    const caller = S.profiles.get(ring.fromUid) || await getProfile(ring.fromUid);
    S.profiles.set(ring.fromUid, caller);
    S.incomingRing = ring;
    el.incomingProfile.replaceChildren(avatarEl(caller.displayName, caller.pfp, "avatar"));
    const self = ring.fromUid === S.me;
    el.incomingText.textContent = self
      ? "Your other device is calling you."
      : `${caller.displayName} is calling ${S.customName || "this chat"}.`;
    el.accept.disabled = el.decline.disabled = false;
    if (!el.incoming.open) el.incoming.showModal();
  });
}

function closeIncoming() {
  S.incomingRing = null;
  if (el.incoming.open) el.incoming.close();
}

el.accept.onclick = async () => {
  el.accept.disabled = el.decline.disabled = true;
  await clearRing(chatId, S.me);
  closeIncoming();
  join();
};
el.decline.onclick = async () => {
  el.accept.disabled = el.decline.disabled = true;
  await declineRing(chatId, S.me, S.incomingRing);
  closeIncoming();
};

// ---------------------------------------------------------------- wake lock + page lifecycle
async function requestWakeLock() {
  try { if ("wakeLock" in navigator && !S.wakeLock) { S.wakeLock = await navigator.wakeLock.request("screen"); S.wakeLock.addEventListener("release", () => { S.wakeLock = null; }); } }
  catch (_) { /* not allowed / unsupported */ }
}
function releaseWakeLock() { try { S.wakeLock?.release(); } catch (_) { /* ignore */ } S.wakeLock = null; }
document.addEventListener("visibilitychange", () => { if (!document.hidden && S.joined) requestWakeLock(); });
addEventListener("pagehide", () => { S.room?.dispose(); });

// ---------------------------------------------------------------- boot
onAuthStateChanged(auth, async user => {
  if (!user) { toTop("index.html"); return; }
  if (S.me === user.uid) return;
  S.me = user.uid;
  try {
    await loadChat();
    startRingWatch();
    await join();
  } catch (err) {
    console.error(err);
    el.lobbyBack.href = "index.html";            // no access to this chat: the room link would just bounce
    showLobby({ text: err.message || "Couldn't load the call.", canJoin: false });
    toast(err.message || "Couldn't load the call.", "error");
  }
});

if (DEBUG) window.__qm = S;

markReady();   // tells the app shell this frame booted (see frame watchdog in shell.js)
