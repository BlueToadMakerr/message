import { auth, db } from "./firebase.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";
import {
  ref, push, set, get, update, remove, onValue, onChildAdded, onDisconnect
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-database.js";
import { avatarEl, hydrateIcons, toast } from "./ui.js";
import { getProfile } from "./users.js";

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

const callLobby = $("callLobby");
const callStage = $("callStage");
const callControls = $("callControls");
const participantsEl = $("callParticipants");
const callTitle = $("callTitle");
const callStatus = $("callStatus");
const headAvatar = $("headAvatar");
const localVideo = $("localVideo");
const localPlaceholder = $("localPlaceholder");
const localAvatar = $("localAvatar");
const connectionStatusText = $("connectionStatusText");
const incomingDialog = $("incomingDialog");
const incomingProfile = $("incomingProfile");
const incomingText = $("incomingText");
const acceptCallBtn = $("acceptCallBtn");
const declineCallBtn = $("declineCallBtn");
const muteBtn = $("muteBtn");
const cameraBtn = $("cameraBtn");
const screenShareBtn = $("screenBtn");
const switchCameraBtn = $("switchCameraBtn");
const endCallBtn = $("endCallBtn");
const remoteGrid = $("remoteGrid");
const ringBtn = $("ringBtn");
const ringMenu = $("ringMenu");
const closeRingBtn = $("closeRingBtn");

const RTC_CONFIG = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};

let me = null;
let participants = [];
let profiles = new Map();
let customName = "";
let joined = false;
let localStream = null;
let cameraTrack = null;
let screenStream = null;
let screenSharing = false;
let muted = false;
let cameraEnabled = true;
let ended = false;
let roomUnsubs = [];
let incomingRingId = null;

const peers = new Map();

function setStatus(text) {
  callStatus.textContent = text;
  connectionStatusText.textContent = text;
}

function stopStream(stream) {
  stream?.getTracks().forEach(track => {
    try { track.stop(); } catch (_) {}
  });
}

function pushKey() {
  return push(ref(db, "_callKeys")).key;
}

function pair(a, b) {
  return a < b ? [a, b] : [b, a];
}

function pairPath(a, b) {
  const [from, to] = pair(a, b);
  return `${callPath}/peers/${from}/${to}`;
}

function isInitiator(uid) {
  return me < uid;
}

function showCall(show) {
  callLobby.classList.toggle("hidden", show);
  callStage.classList.toggle("hidden", !show);
  callControls.classList.toggle("hidden", !show);
  if (!show) ringMenu?.classList.add("hidden");
}

ringBtn?.addEventListener("click", () => {
  ringMenu?.classList.toggle("hidden");
});

closeRingBtn?.addEventListener("click", () => {
  ringMenu?.classList.add("hidden");
});

document.addEventListener("click", event => {
  if (!ringMenu || ringMenu.classList.contains("hidden")) return;
  if (ringMenu.contains(event.target) || ringBtn?.contains(event.target)) return;
  ringMenu.classList.add("hidden");
});

function makeTile(uid, profile) {
  const tile = document.createElement("div");
  tile.className = "call-tile";
  tile.dataset.uid = uid;

  const video = document.createElement("video");
  video.autoplay = true;
  video.volume = 1;
  video.controls = false;
  video.playsInline = true;
  video.className = "call-tile-video hidden";

  const placeholder = document.createElement("div");
  placeholder.className = "call-tile-placeholder";
  placeholder.append(avatarEl(profile.displayName, profile.pfp, "avatar-lg"));

  const label = document.createElement("div");
  label.className = "call-tile-label";

  const tileControls = document.createElement("div");
  tileControls.className = "call-tile-controls";

  const volume = document.createElement("input");
  volume.type = "range";
  volume.min = "0";
  volume.max = "1";
  volume.step = "0.01";
  volume.value = "1";
  volume.className = "call-tile-volume";
  volume.title = "Volume";
  volume.addEventListener("input", () => {
    video.volume = Number(volume.value);
  });

  const fullscreen = document.createElement("button");
  fullscreen.type = "button";
  fullscreen.className = "call-tile-action";
  fullscreen.textContent = "⛶";
  fullscreen.title = "Fullscreen";
  fullscreen.addEventListener("click", async () => {
    try {
      if (document.fullscreenElement === tile) {
        await document.exitFullscreen();
      } else {
        await tile.requestFullscreen();
      }
    } catch (_) {}
  });

  tileControls.append(volume, fullscreen);
  label.textContent = uid === me ? "You" : profile.displayName;

  tile.append(video, placeholder, label, tileControls);
  remoteGrid.append(tile);

  return { tile, video, placeholder, label };
}

function getTile(uid) {
  return remoteGrid.querySelector(`.call-tile[data-uid="${CSS.escape(uid)}"]`);
}

function ensureTile(uid) {
  let tile = getTile(uid);
  if (tile) return {
    tile,
    video: tile.querySelector("video"),
    placeholder: tile.querySelector(".call-tile-placeholder"),
    label: tile.querySelector(".call-tile-label")
  };
  return makeTile(uid, profiles.get(uid) || { displayName: "User", pfp: "" });
}

function removeTile(uid) {
  getTile(uid)?.remove();
}

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

  const title = customName.trim() || participants
    .filter(uid => uid !== me)
    .map(uid => profiles.get(uid)?.displayName || "User")
    .join(", ") || "Call";

  callTitle.textContent = title;
  document.title = `${title} · QuickMessage`;

  const own = profiles.get(me) || { displayName: "You", pfp: "" };
  headAvatar.replaceChildren(avatarEl(title, own.pfp, "avatar sm"));
  localAvatar.replaceChildren(avatarEl(own.displayName, own.pfp, "avatar"));

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
    info.append(name, status);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn primary small";
    button.textContent = uid === me ? "You" : "Ring";
    button.disabled = uid === me || isMemberInCall(uid);
    button.addEventListener("click", () => ringParticipant(uid, button, status));

    status.textContent = uid === me
      ? "You are in this call"
      : isMemberInCall(uid)
        ? "In call"
        : "Not in call";

    row.append(info, button);
    participantsEl.append(row);
  }
}

function isMemberInCall(uid) {
  return !!document.querySelector(`.call-tile[data-uid="${CSS.escape(uid)}"]`);
}

function renderRoomMembers(members) {
  const active = Object.keys(members || {});
  for (const uid of active) {
    if (uid === me) continue;
    ensureTile(uid);
  }

  for (const uid of participants) {
    if (uid !== me && !active.includes(uid)) removeTile(uid);
  }

  renderParticipants();

  const count = active.length;
  setStatus(count > 1 ? `${count} people connected` : "You're the only person in the call");
}

async function ringParticipant(uid, button, statusEl) {
  if (uid === me || isMemberInCall(uid)) return;

  button.disabled = true;
  statusEl.textContent = "Sending notification…";

  const ringId = push(ref(db, `${callPath}/rings`)).key;
  const now = Date.now();

  try {
    await set(ref(db, `${callPath}/ringing/${uid}`), {
      ringId,
      fromUid: me,
      createdAt: now,
      notifyStatus: "sending"
    });

    let result = null;

    try {
      const idToken = await auth.currentUser.getIdToken();
      const response = await fetch("call-notify.php", {
        method: "POST",
        body: new URLSearchParams({
          chatId,
          targetUid: uid,
          sessionId: ringId,
          idToken
        })
      });
      result = await response.json().catch(() => null);
    } catch (err) {
      console.warn("Call notification request failed", err);
    }

    const notifyStatus =
      result?.status === "sent" ? "sent" :
      result?.status === "no_token" ? "no_token" : "failed";

    await update(ref(db), {
      [`${callPath}/ringing/${uid}/notifyStatus`]: notifyStatus
    }).catch(() => {});

    statusEl.textContent =
      notifyStatus === "sent" ? "Notification sent" :
      notifyStatus === "no_token" ? "No notification device" :
      "Notification failed";

    if (notifyStatus === "sent") {
      toast("Notification sent to their device.", "success");
    } else if (notifyStatus === "no_token") {
      toast("They have no notification device registered.", "info");
    } else {
      toast("The notification could not be sent.", "error");
    }
  } catch (err) {
    button.disabled = false;
    statusEl.textContent = "Could not ring";
    toast(err.message || "Couldn't ring them.", "error");
  }
}

async function listenForIncomingRings() {
  const off = onValue(ref(db, `${callPath}/ringing/${me}`), async snap => {
    const ring = snap.val();
    if (!ring || ring.fromUid === me) return;
    if (ring.notifyStatus === "declined" || ring.notifyStatus === "ended") return;

    const caller = profiles.get(ring.fromUid) || await getProfile(ring.fromUid);
    profiles.set(ring.fromUid, caller);

    incomingRingId = ring.ringId;
    incomingProfile.replaceChildren(
      avatarEl(caller.displayName, caller.pfp, "avatar")
    );
    incomingText.textContent = `${caller.displayName} is calling ${customName || "this chat"}.`;
    acceptCallBtn.disabled = false;
    declineCallBtn.disabled = false;

    if (!incomingDialog.open) incomingDialog.showModal();
  });

  roomUnsubs.push(off);
}

async function acceptIncoming() {
  if (!incomingRingId) return;

  acceptCallBtn.disabled = true;
  declineCallBtn.disabled = true;

  await remove(ref(db, `${callPath}/ringing/${me}`)).catch(() => {});
  incomingRingId = null;
  incomingDialog.close();

  if (!joined) await joinCall();
}

async function declineIncoming() {
  await remove(ref(db, `${callPath}/ringing/${me}`)).catch(() => {});
  incomingRingId = null;
  incomingDialog.close();
}

acceptCallBtn.addEventListener("click", acceptIncoming);
declineCallBtn.addEventListener("click", declineIncoming);

async function setupLocalMedia() {
  if (localStream) return;

  setStatus("Requesting camera…");

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        facingMode: "user"
      }
    });
  } catch (_) {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false
    });
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

function createPeer(uid) {
  if (peers.has(uid)) return peers.get(uid);

  const base = pairPath(me, uid);
  const initiator = isInitiator(uid);

  const pc = new RTCPeerConnection(RTC_CONFIG);
  const entry = {
    uid,
    pc,
    remoteStream: new MediaStream(),
    remoteStreams: new Map(),
    cameraRemoteStreamId: null,
    remoteCandidates: [],
    initializedRemote: false,
    offerListener: null,
    answerListener: null,
    candidateListener: null
  };

  peers.set(uid, entry);

  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  let primaryTile = ensureTile(uid);
  const cameraStream = entry.remoteStream;

  pc.ontrack = event => {
    const stream = event.streams[0] || cameraStream;
    if (!entry.cameraRemoteStreamId) entry.cameraRemoteStreamId = stream.id;
    let targetStream = entry.remoteStreams.get(stream.id);

    if (!targetStream) {
      targetStream = new MediaStream();
      entry.remoteStreams.set(stream.id, targetStream);
    }

    if (!targetStream.getTrackById(event.track.id)) {
      targetStream.addTrack(event.track);
    }

    const isScreen = stream.id !== entry.cameraRemoteStreamId;
    let tile = primaryTile;

    if (isScreen) {
      const screenKey = uid + ":screen:" + stream.id;
      let screenTile = remoteGrid.querySelector('.call-tile[data-stream-id="' + CSS.escape(screenKey) + '"]');

      if (!screenTile) {
        screenTile = makeTile(uid, profiles.get(uid) || { displayName: "User", pfp: "" }).tile;
        screenTile.dataset.streamId = screenKey;
        screenTile.classList.add("screen-share");
        screenTile.querySelector(".call-tile-label").textContent =
          (profiles.get(uid)?.displayName || "User") + " — Screen";
      }

      tile = {
        tile: screenTile,
        video: screenTile.querySelector("video"),
        placeholder: screenTile.querySelector(".call-tile-placeholder"),
        label: screenTile.querySelector(".call-tile-label")
      };
    }

    tile.video.srcObject = targetStream;
    tile.video.classList.remove("hidden");
    tile.placeholder.classList.add("hidden");
    tile.video.play().catch(() => {});
    renderParticipants();
  };

  pc.onicecandidate = async event => {
    if (!event.candidate) return;

    try {
      await set(
        ref(db, `${base}/candidates/${me}/${pushKey()}`),
        event.candidate.toJSON()
      );
    } catch (err) {
      console.warn("Could not send ICE candidate", err);
    }
  };

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;

    if (state === "failed" || state === "closed") {
      removePeer(uid);
      return;
    }

    if (state === "connected") {
      tile.label.textContent = `${profiles.get(uid)?.displayName || "User"} · Connected`;
      renderParticipants();
    }
  };

  entry.candidateListener = onChildAdded(
    ref(db, `${base}/candidates/${uid}`),
    async snap => {
      const candidate = snap.val();
      if (!candidate) return;

      try {
        const ice = new RTCIceCandidate(candidate);
        if (!pc.remoteDescription) entry.remoteCandidates.push(ice);
        else await pc.addIceCandidate(ice);
      } catch (err) {
        console.warn("Could not add ICE candidate", err);
      }
    }
  );

  if (initiator) {
    entry.answerListener = onValue(
      ref(db, `${base}/answer`),
      async snap => {
        const answer = snap.val();
        if (!answer || pc.currentRemoteDescription) return;

        try {
          await pc.setRemoteDescription(new RTCSessionDescription(answer));
          await flushPeerCandidates(entry);
        } catch (err) {
          console.error("Could not apply answer", err);
        }
      }
    );

    const offerSnap = await get(ref(db, `${base}/offer`));
    if (!offerSnap.exists()) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await set(ref(db, `${base}/offer`), {
        type: offer.type,
        sdp: offer.sdp,
        fromUid: me
      });
    }
  } else {
    entry.offerListener = onValue(
      ref(db, `${base}/offer`),
      async snap => {
        const offer = snap.val();
        if (!offer || pc.currentRemoteDescription) return;

        try {
          await pc.setRemoteDescription(new RTCSessionDescription(offer));
          await flushPeerCandidates(entry);

          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await set(ref(db, `${base}/answer`), {
            type: answer.type,
            sdp: answer.sdp,
            fromUid: me
          });
        } catch (err) {
          console.error("Could not create answer", err);
        }
      }
    );
  }

  return entry;
}

async function flushPeerCandidates(entry) {
  if (!entry.pc.remoteDescription) return;

  const queued = entry.remoteCandidates.splice(0);
  for (const candidate of queued) {
    try {
      await entry.pc.addIceCandidate(candidate);
    } catch (_) {}
  }
}

function removePeer(uid) {
  const entry = peers.get(uid);
  if (!entry) return;

  try { entry.offerListener?.(); } catch (_) {}
  try { entry.answerListener?.(); } catch (_) {}
  try { entry.candidateListener?.(); } catch (_) {}

  entry.pc.close();
  peers.delete(uid);
  removeTile(uid);
  renderParticipants();
}

async function connectToMember(uid) {
  if (uid === me || !joined || peers.has(uid)) return;

  const p = profiles.get(uid) || await getProfile(uid);
  profiles.set(uid, p);
  ensureTile(uid);
  createPeer(uid);
}

async function disconnectFromMember(uid) {
  removePeer(uid);
}

async function watchCallRoom() {
  const membersRef = ref(db, `${callPath}/members`);

  const off = onValue(membersRef, async snap => {
    const members = snap.val() || {};
    renderRoomMembers(members);

    const active = Object.keys(members).filter(uid => uid !== me);

    for (const uid of active) {
      await connectToMember(uid);
    }

    for (const uid of [...peers.keys()]) {
      if (!active.includes(uid)) disconnectFromMember(uid);
    }
  });

  roomUnsubs.push(off);
}

async function joinCall() {
  if (joined) return;

  joined = true;
  showCall(true);

  await setupLocalMedia();

  const memberRef = ref(db, `${callPath}/members/${me}`);
  await set(memberRef, {
    uid: me,
    joinedAt: Date.now()
  });
  onDisconnect(memberRef).remove();

  setStatus("Joining call…");
  await watchCallRoom();
  renderParticipants();
}

async function leaveCall() {
  if (!joined || ended) return;
  ended = true;

  for (const uid of [...peers.keys()]) removePeer(uid);

  try {
    await remove(ref(db, `${callPath}/members/${me}`));
  } catch (_) {}

  for (const off of roomUnsubs) {
    try { off(); } catch (_) {}
  }
  roomUnsubs = [];

  stopStream(screenStream);
  stopStream(localStream);

  localStream = null;
  cameraTrack = null;
  screenStream = null;
  joined = false;

  showCall(false);
  setStatus("Ready");
  renderParticipants();
  ended = false;
}

async function startScreenShare() {
  if (!peers.size) return;

  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false
    });

    const track = screenStream.getVideoTracks()[0];

    for (const entry of peers.values()) {
      entry.pc.addTrack(track, screenStream);
    }

    screenSharing = true;
    $("screenShareBadge").classList.remove("hidden");
    track.addEventListener("ended", stopScreenShare, { once: true });
  } catch (err) {
    console.warn("Screen share failed", err);
  }
}

async function stopScreenShare() {
  if (!screenSharing) return;

  for (const entry of peers.values()) {
    for (const sender of entry.pc.getSenders()) {
      if (sender.track === screenStream?.getVideoTracks()[0]) {
        try { entry.pc.removeTrack(sender); } catch (_) {}
      }
    }
  }

  stopStream(screenStream);
  screenStream = null;
  screenSharing = false;
  $("screenShareBadge").classList.add("hidden");
}

muteBtn.addEventListener("click", () => {
  if (!localStream) return;

  muted = !muted;
  localStream.getAudioTracks().forEach(track => {
    track.enabled = !muted;
  });

  muteBtn.classList.toggle("active", muted);
  muteBtn.setAttribute(
    "aria-label",
    muted ? "Unmute microphone" : "Mute microphone"
  );
});

cameraBtn.addEventListener("click", () => {
  if (!cameraTrack) return;

  cameraEnabled = !cameraEnabled;
  cameraTrack.enabled = cameraEnabled;

  cameraBtn.classList.toggle("active", !cameraEnabled);
  localVideo.classList.toggle("hidden", !cameraEnabled);
  localPlaceholder.classList.toggle("hidden", cameraEnabled);
});

screenShareBtn.addEventListener(
  "click",
  () => screenSharing ? stopScreenShare() : startScreenShare()
);

switchCameraBtn.addEventListener("click", async () => {
  if (!cameraTrack || !localStream) return;

  const current = cameraTrack.getSettings().facingMode || "user";
  const next = current === "user" ? "environment" : "user";

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { exact: next } }
    });

    const nextTrack = stream.getVideoTracks()[0];

    for (const entry of peers.values()) {
      const sender = entry.pc.getSenders().find(s => s.track?.kind === "video");
      if (sender) await sender.replaceTrack(nextTrack);
    }

    const oldTrack = localStream.getVideoTracks()[0];
    oldTrack?.stop();
    if (oldTrack) localStream.removeTrack(oldTrack);

    localStream.addTrack(nextTrack);
    cameraTrack = nextTrack;
    localVideo.srcObject = localStream;
  } catch (err) {
    console.warn("Could not switch camera", err);
  }
});

endCallBtn.addEventListener("click", leaveCall);

async function init() {
  try {
    await loadChat();
    await listenForIncomingRings();
    await joinCall();
  } catch (err) {
    console.error(err);
    setStatus(err.message || "Could not load the call.");
    toast(err.message || "Could not load the call.", "error");
  }
}

onAuthStateChanged(auth, async user => {
  if (!user) {
    location.replace("index.html");
    return;
  }

  if (me === user.uid) return;
  me = user.uid;
  await init();
});
