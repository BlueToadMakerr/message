import { auth, db } from "./firebase.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";
import {
  ref, push, set, get, update, remove, onValue, onChildAdded, onDisconnect
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-database.js";
import { avatarEl, hydrateIcons, toast } from "./ui.js";
import { getProfile, ensureProfile } from "./users.js";

hydrateIcons();

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const chatId = params.get("chatId");
if (!chatId || !/^[\w-]{1,64}$/.test(chatId)) {
  location.replace("index.html");
  throw new Error("Missing or invalid chatId");
}

const chatPath = `privateChats/${chatId}`;
const callPath = `calls/${chatId}`;
const callLobby = $("callLobby"), callStage = $("callStage"), callControls = $("callControls");
const participantsEl = $("callParticipants"), callTitle = $("callTitle"), callStatus = $("callStatus");
const headAvatar = $("headAvatar"), remoteVideo = $("remoteVideo"), localVideo = $("localVideo");
const remotePlaceholder = $("remotePlaceholder"), localPlaceholder = $("localPlaceholder");
const remoteAvatar = $("remoteAvatar"), localAvatar = $("localAvatar"), remoteName = $("remoteName"), remoteState = $("remoteState");
const connectionStatusText = $("connectionStatusText");
const incomingDialog = $("incomingDialog"), incomingProfile = $("incomingProfile"), incomingText = $("incomingText");
const acceptCallBtn = $("acceptCallBtn"), declineCallBtn = $("declineCallBtn");
const muteBtn = $("muteBtn"), cameraBtn = $("cameraBtn"), screenShareBtn = $("screenBtn");
const switchCameraBtn = $("switchCameraBtn"), endCallBtn = $("endCallBtn");

const RTC_CONFIG = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

let me = null, participants = [], profiles = new Map(), customName = "";
let activeSessionId = null, activePeerUid = null, isCaller = false, ended = false;
let peerConnection = null, localStream = null, remoteStream = null, cameraTrack = null, screenStream = null;
let screenSharing = false, muted = false, cameraEnabled = true, remoteCandidateQueue = [];
let incomingSessionId = null, incomingCallerUid = null, unsubs = [];

function setStatus(text) {
  callStatus.textContent = text;
  connectionStatusText.textContent = text;
}
function setRemoteState(text) { remoteState.textContent = text; }
function showLobby(show) {
  callLobby.classList.toggle("hidden", !show);
  callStage.classList.toggle("hidden", show);
  callControls.classList.toggle("hidden", show);
}
function stopStream(stream) {
  stream?.getTracks().forEach(track => { try { track.stop(); } catch (_) {} });
}
function pushKey() { return push(ref(db, "_callKeys")).key; }

async function loadChat() {
  const [pSnap, nSnap] = await Promise.all([
    get(ref(db, `${chatPath}/participants`)),
    get(ref(db, `${chatPath}/chatData/name`))
  ]);
  const value = pSnap.val() || {};
  if (!value[me]) throw new Error("You are no longer in this chat.");
  participants = Object.keys(value);
  customName = nSnap.val() || "";

  const loaded = await Promise.all(participants.map(getProfile));
  profiles = new Map(loaded.map(p => [p.uid, p]));

  const others = participants.filter(uid => uid !== me);
  const title = customName.trim() || others.map(uid => profiles.get(uid)?.displayName || "User").join(", ") || "Call";
  callTitle.textContent = title;
  document.title = `${title} · QuickMessage`;
  const own = profiles.get(me);
  headAvatar.replaceChildren(avatarEl(title, others.length === 1 ? profiles.get(others[0])?.pfp || "" : own?.pfp || "", "avatar sm"));
  localAvatar.replaceChildren(avatarEl(own?.displayName || "You", own?.pfp || "", "avatar"));
  renderParticipants();
}

function renderParticipants() {
  participantsEl.replaceChildren();
  for (const uid of participants) {
    const p = profiles.get(uid) || { uid, displayName: "User", pfp: "" };
    const row = document.createElement("div");
    row.className = "call-participant";
    row.append(avatarEl(p.displayName, p.pfp, "avatar"));

    const info = document.createElement("div");
    info.className = "call-participant-info";
    const name = document.createElement("strong");
    name.textContent = p.displayName;
    const status = document.createElement("div");
    status.className = "call-participant-status muted";
    status.textContent = uid === me ? "You" : "Ready to ring";
    info.append(name, status);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn primary small";
    button.textContent = uid === me ? "You" : "Ring";
    button.disabled = uid === me;
    button.addEventListener("click", () => ringParticipant(uid, button, status));
    row.append(info, button);
    participantsEl.append(row);
  }
}

async function ringParticipant(uid, button, statusEl) {
  if (activeSessionId) return toast("Finish the current call before ringing someone else.", "error");
  button.disabled = true;
  statusEl.textContent = "Creating call…";

  const sessionRef = push(ref(db, `${callPath}/sessions`));
  const sessionId = sessionRef.key;
  const now = Date.now();

  try {
    await set(sessionRef, { fromUid: me, toUid: uid, state: "ringing", createdAt: now });
    await set(ref(db, `${callPath}/ringing/${uid}`), {
      sessionId, fromUid: me, createdAt: now, notifyStatus: "sending"
    });

    statusEl.textContent = "Sending notification…";
    let result = null;
    try {
      const idToken = await auth.currentUser.getIdToken();
      const response = await fetch("call-notify.php", {
        method: "POST",
        body: new URLSearchParams({ chatId, targetUid: uid, sessionId, idToken })
      });
      result = await response.json().catch(() => null);
    } catch (err) {
      console.warn("Call notification request failed", err);
    }

    const notifyStatus = result?.status === "sent" ? "sent" : result?.status === "no_token" ? "no_token" : "failed";
    await update(ref(db), { [`${callPath}/ringing/${uid}/notifyStatus`]: notifyStatus }).catch(() => {});

    statusEl.textContent = notifyStatus === "sent"
      ? "Notification sent"
      : notifyStatus === "no_token"
        ? "No notification device"
        : "Notification failed";

    activeSessionId = sessionId;
    activePeerUid = uid;
    isCaller = true;
    await startWebRTC();
  } catch (err) {
    console.error(err);
    await remove(sessionRef).catch(() => {});
    await remove(ref(db, `${callPath}/ringing/${uid}`)).catch(() => {});
    button.disabled = false;
    statusEl.textContent = "Could not ring";
    toast(err.message || "Couldn't start the call.", "error");
  }
}

function listenForIncoming() {
  const off = onValue(ref(db, `${callPath}/ringing/${me}`), async snap => {
    const ring = snap.val();
    if (!ring || ring.notifyStatus === "declined" || ring.notifyStatus === "ended") return;
    if (activeSessionId || incomingSessionId === ring.sessionId) return;

    incomingSessionId = ring.sessionId;
    incomingCallerUid = ring.fromUid;
    const p = profiles.get(ring.fromUid) || await getProfile(ring.fromUid);
    profiles.set(ring.fromUid, p);
    incomingProfile.replaceChildren(avatarEl(p.displayName, p.pfp, "avatar"));
    incomingText.textContent = `${p.displayName} is calling you.`;
    acceptCallBtn.disabled = false;
    declineCallBtn.disabled = false;
    if (!incomingDialog.open) incomingDialog.showModal();
  });
  unsubs.push(off);
}

async function acceptIncoming() {
  if (!incomingSessionId || !incomingCallerUid) return;
  const sessionId = incomingSessionId, callerUid = incomingCallerUid;
  acceptCallBtn.disabled = true; declineCallBtn.disabled = true;

  try {
    const snap = await get(ref(db, `${callPath}/sessions/${sessionId}`));
    const session = snap.val();
    if (!session || session.toUid !== me || session.fromUid !== callerUid || session.state !== "ringing") {
      throw new Error("That call is no longer available.");
    }
    await update(ref(db, `${callPath}/sessions/${sessionId}`), { state: "accepted", acceptedAt: Date.now() });
    await remove(ref(db, `${callPath}/ringing/${me}`));

    activeSessionId = sessionId;
    activePeerUid = callerUid;
    isCaller = false;
    incomingSessionId = null; incomingCallerUid = null;
    incomingDialog.close();
    await startWebRTC();
  } catch (err) {
    console.error(err);
    toast(err.message || "Couldn't answer the call.", "error");
    acceptCallBtn.disabled = false; declineCallBtn.disabled = false;
  }
}

async function declineIncoming() {
  if (!incomingSessionId) return;
  const sessionId = incomingSessionId;
  incomingSessionId = null; incomingCallerUid = null;
  await update(ref(db, `${callPath}/sessions/${sessionId}`), { state: "declined", endedAt: Date.now() }).catch(() => {});
  await remove(ref(db, `${callPath}/ringing/${me}`)).catch(() => {});
  incomingDialog.close();
}
acceptCallBtn.addEventListener("click", acceptIncoming);
declineCallBtn.addEventListener("click", declineIncoming);

async function setupLocalMedia() {
  setStatus("Requesting camera…");
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" }
    });
  } catch (_) {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    cameraEnabled = false;
    cameraBtn.disabled = true;
  }
  cameraTrack = localStream.getVideoTracks()[0] || null;
  localVideo.srcObject = localStream;
  localVideo.muted = true;
  localVideo.play().catch(() => {});
  localPlaceholder.classList.toggle("hidden", !!cameraTrack);
  localVideo.classList.toggle("hidden", !cameraTrack);
}

function createPeerConnection() {
  peerConnection = new RTCPeerConnection(RTC_CONFIG);
  remoteStream = new MediaStream();
  remoteVideo.srcObject = remoteStream;

  localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

  peerConnection.ontrack = event => {
    const stream = event.streams[0];
    if (stream) stream.getTracks().forEach(track => {
      if (!remoteStream.getTrackById(track.id)) remoteStream.addTrack(track);
    });
    if (!stream && !remoteStream.getTrackById(event.track.id)) remoteStream.addTrack(event.track);
    const hasVideo = remoteStream.getVideoTracks().length > 0;
    remoteVideo.classList.toggle("hidden", !hasVideo);
    remotePlaceholder.classList.toggle("hidden", hasVideo);
    setRemoteState("Connected");
    setStatus("Connected");
    remoteVideo.play().catch(() => {});
  };

  peerConnection.onicecandidate = async event => {
    if (!event.candidate || !activeSessionId) return;
    try {
      await set(ref(db, `${callPath}/sessions/${activeSessionId}/candidates/${me}/${pushKey()}`), event.candidate.toJSON());
    } catch (err) { console.warn("Could not send ICE candidate", err); }
  };

  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection.connectionState;
    if (state === "connected") {
      setStatus("Connected"); setRemoteState("Connected");
    } else if (state === "connecting" || state === "new") {
      setStatus(isCaller ? "Calling…" : "Connecting…"); setRemoteState("Connecting…");
    } else if (state === "disconnected") {
      setStatus("Disconnected"); setRemoteState("Disconnected");
    } else if (state === "failed") {
      setStatus("Connection failed"); setRemoteState("Connection failed");
    }
  };
}

async function setupSignaling() {
  const base = `${callPath}/sessions/${activeSessionId}`;
  const offerRef = ref(db, `${base}/offer`);
  const answerRef = ref(db, `${base}/answer`);
  const peerCandidatesRef = ref(db, `${base}/candidates/${activePeerUid}`);
  const stateRef = ref(db, `${base}/state`);

  unsubs.push(onValue(answerRef, async snap => {
    if (!isCaller || peerConnection?.currentRemoteDescription) return;
    const answer = snap.val();
    if (!answer) return;
    try {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
      await flushCandidates();
    } catch (err) { console.error("Could not apply answer", err); }
  }));

  unsubs.push(onValue(offerRef, async snap => {
    if (isCaller || peerConnection?.currentRemoteDescription) return;
    const offer = snap.val();
    if (!offer) return;
    try {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
      await flushCandidates();
      await createAnswer();
    } catch (err) {
      console.error("Could not apply offer", err);
      setStatus("Could not connect");
    }
  }));

  unsubs.push(onChildAdded(peerCandidatesRef, async snap => {
    const candidate = snap.val();
    if (!candidate || !peerConnection) return;
    try {
      const ice = new RTCIceCandidate(candidate);
      if (!peerConnection.remoteDescription) remoteCandidateQueue.push(ice);
      else await peerConnection.addIceCandidate(ice);
    } catch (err) { console.warn("Could not add ICE candidate", err); }
  }));

  unsubs.push(onValue(stateRef, snap => {
    const state = snap.val();
    if (state === "declined") {
      toast("The call was declined.", "error");
      finishCall(false);
    } else if (state === "ended") {
      finishCall(false);
    }
  }));

  if (isCaller) await onDisconnect(stateRef).set("ended");
}

async function startWebRTC() {
  if (!activeSessionId || !activePeerUid) throw new Error("Missing call session.");
  showLobby(false);
  setStatus(isCaller ? "Calling…" : "Connecting…");
  const p = profiles.get(activePeerUid) || await getProfile(activePeerUid);
  profiles.set(activePeerUid, p);
  remoteName.textContent = p.displayName;
  callTitle.textContent = p.displayName;
  remoteAvatar.replaceChildren(avatarEl(p.displayName, p.pfp, "avatar"));

  try {
    await setupLocalMedia();
    createPeerConnection();
    await setupSignaling();
    if (isCaller) await createOffer();
  } catch (err) {
    await finishCall(false);
    throw err;
  }
}

async function createOffer() {
  const offer = await peerConnection.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
  await peerConnection.setLocalDescription(offer);
  await set(ref(db, `${callPath}/sessions/${activeSessionId}/offer`), { type: offer.type, sdp: offer.sdp });
}

async function createAnswer() {
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  await set(ref(db, `${callPath}/sessions/${activeSessionId}/answer`), { type: answer.type, sdp: answer.sdp });
  await update(ref(db, `${callPath}/sessions/${activeSessionId}`), { state: "connected" });
}

async function flushCandidates() {
  if (!peerConnection?.remoteDescription) return;
  const queued = remoteCandidateQueue.splice(0);
  for (const ice of queued) {
    try { await peerConnection.addIceCandidate(ice); } catch (_) {}
  }
}

async function startScreenShare() {
  if (!peerConnection) return;
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const track = screenStream.getVideoTracks()[0];
    const sender = peerConnection.getSenders().find(s => s.track?.kind === "video");
    if (sender && track) {
      await sender.replaceTrack(track);
      screenSharing = true;
      $("screenShareBadge").classList.remove("hidden");
      track.addEventListener("ended", stopScreenShare, { once: true });
    }
  } catch (err) { console.warn("Screen share failed", err); }
}

async function stopScreenShare() {
  if (!screenSharing) return;
  const sender = peerConnection?.getSenders().find(s => s.track?.kind === "video");
  try { if (sender && cameraTrack) await sender.replaceTrack(cameraTrack); } catch (_) {}
  stopStream(screenStream);
  screenStream = null;
  screenSharing = false;
  $("screenShareBadge").classList.add("hidden");
}

muteBtn.addEventListener("click", () => {
  if (!localStream) return;
  muted = !muted;
  localStream.getAudioTracks().forEach(track => track.enabled = !muted);
  muteBtn.classList.toggle("active", muted);
  muteBtn.setAttribute("aria-label", muted ? "Unmute microphone" : "Mute microphone");
});

cameraBtn.addEventListener("click", () => {
  if (!cameraTrack) return;
  cameraEnabled = !cameraEnabled;
  cameraTrack.enabled = cameraEnabled;
  cameraBtn.classList.toggle("active", !cameraEnabled);
  localVideo.classList.toggle("hidden", !cameraEnabled);
  localPlaceholder.classList.toggle("hidden", cameraEnabled);
});

screenShareBtn.addEventListener("click", () => screenSharing ? stopScreenShare() : startScreenShare());

switchCameraBtn.addEventListener("click", async () => {
  if (!cameraTrack || !localStream) return;
  const current = cameraTrack.getSettings().facingMode || "user";
  const next = current === "user" ? "environment" : "user";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { exact: next } } });
    const nextTrack = stream.getVideoTracks()[0];
    const sender = peerConnection?.getSenders().find(s => s.track?.kind === "video");
    if (sender) await sender.replaceTrack(nextTrack);
    const oldTrack = localStream.getVideoTracks()[0];
    oldTrack?.stop();
    if (oldTrack) localStream.removeTrack(oldTrack);
    localStream.addTrack(nextTrack);
    cameraTrack = nextTrack;
    localVideo.srcObject = localStream;
  } catch (err) { console.warn("Could not switch camera", err); }
});

endCallBtn.addEventListener("click", () => finishCall(true));

async function finishCall(writeState) {
  if (ended) return;
  ended = true;

  if (writeState && activeSessionId) {
    await update(ref(db, `${callPath}/sessions/${activeSessionId}`), { state: "ended", endedAt: Date.now() }).catch(() => {});
  }
  if (activePeerUid) await remove(ref(db, `${callPath}/ringing/${activePeerUid}`)).catch(() => {});
  await remove(ref(db, `${callPath}/ringing/${me}`)).catch(() => {});

  unsubs.forEach(fn => { try { fn(); } catch (_) {} });
  unsubs = [];
  stopStream(screenStream); stopStream(localStream);
  peerConnection?.close();

  activeSessionId = null; activePeerUid = null; peerConnection = null; localStream = null; remoteStream = null;
  screenStream = null; cameraTrack = null; remoteCandidateQueue = [];
  showLobby(true);
  setStatus("Ready");
  renderParticipants();
  ended = false;
}

$("callOptionsBtn")?.addEventListener("click", () => {});
