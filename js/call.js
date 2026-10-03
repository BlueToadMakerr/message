import { auth, db } from "./firebase.js";

import {
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";

import {
  ref,
  get,
  set,
  update,  onValue,
  onChildAdded,
  onDisconnect
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-database.js";

import {
  avatarEl,
  hydrateIcons
} from "./ui.js";


/*
 * ------------------------------------------------------------
 * CONFIG
 * ------------------------------------------------------------
 */

const RTC_CONFIG = {
  iceServers: [
    {
      urls: "stun:stun.l.google.com:19302"
    }
  ]
};


/*
 * ------------------------------------------------------------
 * DOM
 * ------------------------------------------------------------
 */

const remoteVideo = document.getElementById("remoteVideo");
const localVideo = document.getElementById("localVideo");

const remotePlaceholder =
  document.getElementById("remotePlaceholder");

const localPlaceholder =
  document.getElementById("localPlaceholder");

const remoteAvatar =
  document.getElementById("remoteAvatar");

const localAvatar =
  document.getElementById("localAvatar");

const remoteName =
  document.getElementById("remoteName");

const remoteState =
  document.getElementById("remoteState");

const callTitle =
  document.getElementById("callTitle");

const callStatus =
  document.getElementById("callStatus");

const connectionStatus =
  document.getElementById("connectionStatus");

const connectionStatusText =
  document.getElementById("connectionStatusText");

const muteBtn =
  document.getElementById("muteBtn");

const cameraBtn =
  document.getElementById("cameraBtn");

const screenShareBtn =
  document.getElementById("screenBtn");

const switchCameraBtn =
  document.getElementById("switchCameraBtn");

const endCallBtn =
  document.getElementById("endCallBtn");

const audioOnlyToggle =
  document.getElementById("audioOnlyBtn");

const speakerBtn =
  document.getElementById("speakerBtn");


/*
 * ------------------------------------------------------------
 * STATE
 * ------------------------------------------------------------
 */

let currentUser = null;

let callId = null;
let peerUid = null;

let isCaller = false;
let callEnded = false;

let peerConnection = null;

let localStream = null;
let remoteStream = null;

let screenStream = null;
let cameraTrack = null;

let muted = false;
let cameraEnabled = true;
let screenSharing = false;

let remoteCandidateQueue = [];
let remoteDescriptionSet = false;

const cleanupFunctions = [];


/*
 * ------------------------------------------------------------
 * URL
 * ------------------------------------------------------------
 *
 * Expected:
 *
 * call.html?callId=ABC123&peerUid=USER_UID
 *
 */

const params = new URLSearchParams(location.search);

callId = params.get("callId");
peerUid = params.get("peerUid");

isCaller = params.get("caller") === "1";


/*
 * ------------------------------------------------------------
 * BASIC HELPERS
 * ------------------------------------------------------------
 */

function setStatus(text) {
  if (callStatus) {
    callStatus.textContent = text;
  }

  if (connectionStatusText) {
    connectionStatusText.textContent = text;
  }
}


function setRemoteState(text) {
  if (remoteState) {
    remoteState.textContent = text;
  }
}


function showLocalVideo(show) {
  if (localVideo) {
    localVideo.classList.toggle("hidden", !show);
  }

  if (localPlaceholder) {
    localPlaceholder.classList.toggle("hidden", show);
  }
}


function showRemoteVideo(show) {
  if (remoteVideo) {
    remoteVideo.classList.toggle("hidden", !show);
  }

  if (remotePlaceholder) {
    remotePlaceholder.classList.toggle("hidden", show);
  }
}


function stopStream(stream) {
  if (!stream) return;

  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch (_) {}
  }
}


/*
 * ------------------------------------------------------------
 * AUTH
 * ------------------------------------------------------------ */

onAuthStateChanged(auth, async user => {
  if (!user) {
    location.href = "index.html";
    return;
  }

  currentUser = user;

  try {
    await startCall();
  } catch (err) {
    console.error("Failed to start call:", err);

    setStatus("Could not start call");
    setRemoteState(
      err?.message || "An unexpected error occurred."
    );
  }
});


/*
 * ------------------------------------------------------------
 * START
 * ------------------------------------------------------------ */

async function startCall() {
  if (!callId) {
    throw new Error("Missing callId.");
  }

  if (!peerUid) {
    throw new Error("Missing peerUid.");
  }

  if (peerUid === currentUser.uid) {
    throw new Error("You cannot call yourself.");
  }

  setStatus("Starting…");

  /*
   * Get peer information.
   */
  await loadPeerProfile();

  /*
   * Get camera/microphone.
   */
  await setupLocalMedia();

  /*
   * Create WebRTC connection.
   */
  createPeerConnection();

  /*
   * Set up Firebase signaling.
   */
  await setupSignaling();

  /*
   * Caller creates offer.
   */
  if (isCaller) {
    await createCallOffer();
  } else {
    setStatus("Waiting for call…");
    setRemoteState("Connecting…");
  }
}


/*
 * ------------------------------------------------------------
 * PEER PROFILE
 * ------------------------------------------------------------ */

async function loadPeerProfile() {
  try {
    const snap = await get(
      ref(db, `accsettings/${peerUid}/settings`)
    );

    if (!snap.exists()) {
      remoteName.textContent = "User";
      return;
    }

    const settings = snap.val() || {};

    const name =
      typeof settings.displayName === "string" &&
      settings.displayName.trim()
        ? settings.displayName.trim()
        : "User";

    if (remoteName) {
      remoteName.textContent = name;
    }

    if (callTitle) {
      callTitle.textContent = name;
    }

    /*
     * Reuse the existing avatar helper.
     */
    if (remoteAvatar) {
      remoteAvatar.innerHTML = "";

      try {
        remoteAvatar.appendChild(
          avatarEl(name, settings.pfp || "")
        );
      } catch (err) {
        console.warn("Could not create remote avatar:", err);
      }
    }
  } catch (err) {
    console.warn("Could not load peer profile:", err);
  }
}


/*
 * ------------------------------------------------------------
 * LOCAL MEDIA
 * ------------------------------------------------------------ */

async function setupLocalMedia() {
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
  } catch (err) {
    console.warn("Camera/microphone failed:", err);

    /*
     * Try audio-only if camera access failed.
     */
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false
      });

      cameraEnabled = false;

      if (cameraBtn) {
        cameraBtn.disabled = true;
      }
    } catch (audioErr) {
      throw new Error(
        "Could not access your microphone or camera."
      );
    }
  }

  cameraTrack =
    localStream.getVideoTracks()[0] || null;

  if (localVideo) {
    localVideo.srcObject = localStream;
    localVideo.muted = true;
    localVideo.playsInline = true;

    try {
      await localVideo.play();
    } catch (_) {}
  }

  showLocalVideo(!!cameraTrack);

  /*
   * Make sure audio starts enabled.
   */
  for (const track of localStream.getAudioTracks()) {
    track.enabled = true;
  }
}


/*
 * ------------------------------------------------------------
 * PEER CONNECTION
 * ------------------------------------------------------------ */

function createPeerConnection() {
  peerConnection = new RTCPeerConnection(RTC_CONFIG);

  remoteStream = new MediaStream();

  if (remoteVideo) {
    remoteVideo.srcObject = remoteStream;
    remoteVideo.playsInline = true;
  }

  /*
   * Add local tracks.
   */
  for (const track of localStream.getTracks()) {
    peerConnection.addTrack(track, localStream);
  }

  /*
   * Receive remote tracks.
   */
  peerConnection.ontrack = event => {
    const stream = event.streams[0];

    if (stream) {
      for (const track of stream.getTracks()) {
        if (!remoteStream.getTrackById(track.id)) {
          remoteStream.addTrack(track);
        }
      }
    } else {
      if (!remoteStream.getTrackById(event.track.id)) {
        remoteStream.addTrack(event.track);
      }
    }

    showRemoteVideo(
      remoteStream.getVideoTracks().length > 0
    );

    setRemoteState("Connected");
    setStatus("Connected");

    if (remoteVideo) {
      remoteVideo.play().catch(() => {});
    }
  };

  /*
   * ICE candidates are sent through Firebase.
   */
  peerConnection.onicecandidate = async event => {
    if (!event.candidate) {
      return;
    }

    const candidate = event.candidate.toJSON();

    const candidateRef = ref(
      db,
      `calls/${callId}/candidates/${currentUser.uid}/${pushKey()}`
    );

    try {
      await set(candidateRef, candidate);
    } catch (err) {
      console.error(
        "Could not send ICE candidate:",
        err
      );
    }
  };

  /*
   * Connection state.
   */
  peerConnection.onconnectionstatechange = () => {
    const state =
      peerConnection.connectionState;

    console.log(
      "WebRTC connection state:",
      state
    );

    switch (state) {
      case "new":
      case "connecting":
        setStatus("Connecting…");
        setRemoteState("Connecting…");
        break;

      case "connected":
        setStatus("Connected");
        setRemoteState("Connected");
        break;

      case "disconnected":
        setStatus("Disconnected");
        setRemoteState("Disconnected");
        break;

      case "failed":
        setStatus("Connection failed");
        setRemoteState("Connection failed");
        break;

      case "closed":
        setStatus("Call ended");
        break;
    }
  };

  /*
   * ICE connection state.
   */
  peerConnection.oniceconnectionstatechange = () => {
    console.log(
      "ICE state:",
      peerConnection.iceConnectionState
    );
  };
}


/*
 * ------------------------------------------------------------
 * FIREBASE SIGNALING
 * ------------------------------------------------------------ */

async function setupSignaling() {
  const callRef = ref(db, `calls/${callId}`);

  /*
   * Caller creates the call record.
   */
  if (isCaller) {
    const existing = await get(callRef);

    if (!existing.exists()) {
      await set(callRef, {
        fromUid: currentUser.uid,
        toUid: peerUid,
        state: "ringing",
        createdAt: Date.now()
      });
    }
  }

  /*
   * Listen for answer.
   */
  const answerRef = ref(
    db,
    `calls/${callId}/answer`
  );

  const unsubscribeAnswer = onValue(
    answerRef,
    async snapshot => {
      if (!isCaller) return;

      const answer = snapshot.val();

      if (!answer || !peerConnection) {
        return;
      }

      /*
       * Don't apply the answer more than once.
       */
      if (
        peerConnection.currentRemoteDescription
      ) {
        return;
      }

      try {
        await peerConnection.setRemoteDescription(
          new RTCSessionDescription(answer)
        );

        remoteDescriptionSet = true;

        await flushCandidateQueue();

        setStatus("Connecting…");
        setRemoteState("Connecting…");
      } catch (err) {
        console.error(
          "Could not apply answer:",
          err
        );
      }
    }
  );

  cleanupFunctions.push(
    unsubscribeAnswer
  );

  /*
   * Listen for offer.
   */
  const offerRef = ref(
    db,
    `calls/${callId}/offer`
  );

  const unsubscribeOffer = onValue(
    offerRef,
    async snapshot => {
      if (isCaller) return;

      const offer = snapshot.val();

      if (!offer || !peerConnection) {
        return;
      }

      if (
        peerConnection.currentRemoteDescription
      ) {
        return;
      }

      try {
        await peerConnection.setRemoteDescription(
          new RTCSessionDescription(offer)
        );

        remoteDescriptionSet = true;

        await flushCandidateQueue();

        await createCallAnswer();
      } catch (err) {
        console.error(
          "Could not apply offer:",
          err
        );

        setStatus("Could not connect");
      }
    }
  );

  cleanupFunctions.push(
    unsubscribeOffer
  );

  /*
   * Listen for ICE candidates from peer.
   */
  const candidatesRef = ref(
    db,
    `calls/${callId}/candidates/${peerUid}`
  );

  const unsubscribeCandidates = onChildAdded(
    candidatesRef,
    async snapshot => {
      const candidate = snapshot.val();

      if (!candidate || !peerConnection) {
        return;
      }

      try {
        const iceCandidate =
          new RTCIceCandidate(candidate);

        if (
          !peerConnection.remoteDescription
        ) {
          remoteCandidateQueue.push(
            iceCandidate
          );
          return;
        }

        await peerConnection.addIceCandidate(
          iceCandidate
        );
      } catch (err) {
        console.warn(
          "Could not add ICE candidate:",
          err
        );
      }
    }
  );

  cleanupFunctions.push(
    unsubscribeCandidates
  );

  /*
   * Watch call state.
   */
  const stateRef = ref(
    db,
    `calls/${callId}/state`
  );

  const unsubscribeState = onValue(
    stateRef,
    snapshot => {
      const state = snapshot.val();

      if (!state) return;

      if (state === "ended") {
        finishCall(false);
      }
    }
  );

  cleanupFunctions.push(
    unsubscribeState
  );

  /*
   * Caller cleans up if the page disappears.
   */
  if (isCaller) {
    await onDisconnect(stateRef).set("ended");
  }
}


/*
 * ------------------------------------------------------------
 * OFFER
 * ------------------------------------------------------------ */

async function createCallOffer() {
  if (!peerConnection) {
    return;
  }

  setStatus("Calling…");
  setRemoteState("Calling…");

  const offer =
    await peerConnection.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true
    });

  await peerConnection.setLocalDescription(
    offer
  );

  await set(
    ref(db, `calls/${callId}/offer`),
    {
      type: offer.type,
      sdp: offer.sdp
    }
  );

  await update(
    ref(db, `calls/${callId}`),
    {
      state: "ringing"
    }
  );
}


/*
 * ------------------------------------------------------------
 * ANSWER
 * ------------------------------------------------------------ */

async function createCallAnswer() {
  if (!peerConnection) {
    return;
  }

  setStatus("Answering…");
  setRemoteState("Connecting…");

  const answer =
    await peerConnection.createAnswer();

  await peerConnection.setLocalDescription(
    answer
  );

  await set(
    ref(db, `calls/${callId}/answer`),
    {
      type: answer.type,
      sdp: answer.sdp
    }
  );

  await update(
    ref(db, `calls/${callId}`),
    {
      state: "connected"
    }
  );
}


/*
 * ------------------------------------------------------------
 * ICE QUEUE
 * ------------------------------------------------------------ */

async function flushCandidateQueue() {
  if (!peerConnection) {
    return;
  }

  if (!peerConnection.remoteDescription) {
    return;
  }

  const queue =
    remoteCandidateQueue.splice(
      0,
      remoteCandidateQueue.length
    );

  for (const candidate of queue) {
    try {
      await peerConnection.addIceCandidate(
        candidate
      );
    } catch (err) {
      console.warn(
        "Could not add queued ICE candidate:",
        err
      );
    }
  }
}


/*
 * ------------------------------------------------------------
 * BUTTONS
 * ------------------------------------------------------------ */

muteBtn?.addEventListener(
  "click",
  () => {
    if (!localStream) return;

    const audioTracks =
      localStream.getAudioTracks();

    if (!audioTracks.length) {
      return;
    }

    muted = !muted;

    for (const track of audioTracks) {
      track.enabled = !muted;
    }

    muteBtn.classList.toggle(
      "active",
      muted
    );

    muteBtn.setAttribute(
      "aria-label",
      muted ? "Unmute microphone" : "Mute microphone"
    );

    setStatus(
      muted ? "Microphone muted" : "Connected"
    );
  }
);


cameraBtn?.addEventListener(
  "click",
  () => {
    if (!cameraTrack) return;

    cameraEnabled = !cameraEnabled;

    cameraTrack.enabled =
      cameraEnabled;

    cameraBtn.classList.toggle(
      "active",
      !cameraEnabled
    );

    showLocalVideo(
      cameraEnabled
    );
  }
);


screenShareBtn?.addEventListener(
  "click",
  async () => {
    if (screenSharing) {
      await stopScreenShare();
    } else {
      await startScreenShare();
    }
  }
);


switchCameraBtn?.addEventListener(
  "click",
  async () => {
    /*
     * Camera switching is intentionally kept
     * simple for the first version.
     *
     * Mobile browsers generally require replacing
     * the current track with a newly acquired one.
     */
    if (!cameraTrack || !localStream) {
      return;
    }

    try {
      const currentFacing =
        cameraTrack.getSettings().facingMode;

      const nextFacing =
        currentFacing === "environment"
          ? "user"
          : "environment";

      const newStream =
        await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: {
              exact: nextFacing
            }
          }
        });

      const newTrack =
        newStream.getVideoTracks()[0];

      if (!newTrack) {
        return;
      }

      const sender =
        peerConnection
          ?.getSenders()
          .find(
            s =>
              s.track &&
              s.track.kind === "video"
          );

      if (sender) {
        await sender.replaceTrack(
          newTrack
        );
      }

      const oldTrack =
        cameraTrack;

      localStream.removeTrack(
        oldTrack
      );

      oldTrack.stop();

      localStream.addTrack(
        newTrack
      );

      cameraTrack =
        newTrack;

      if (localVideo) {
        localVideo.srcObject =
          localStream;
      }
    } catch (err) {
      console.warn(
        "Could not switch camera:",
        err
      );
    }
  }
);


endCallBtn?.addEventListener(
  "click",
  async () => {
    await finishCall(true);
  }
);


/*
 * ------------------------------------------------------------
 * SCREEN SHARING
 * ------------------------------------------------------------ */

async function startScreenShare() {
  if (!peerConnection) {
    return;
  }

  try {
    screenStream =
      await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false
      });

    const screenTrack =
      screenStream.getVideoTracks()[0];

    if (!screenTrack) {
      return;
    }

    const sender =
      peerConnection
        .getSenders()
        .find(
          s =>
            s.track &&
            s.track.kind === "video"
        );

    if (sender) {
      await sender.replaceTrack(
        screenTrack
      );
    }

    screenSharing = true;

    screenShareBtn?.classList.add(
      "active"
    );

    if (localVideo) {
      localVideo.srcObject =
        screenStream;
    }

    screenTrack.addEventListener(
      "ended",
      () => {
        stopScreenShare();
      },
      { once: true }
    );
  } catch (err) {
    console.warn(
      "Screen sharing was cancelled or failed:",
      err
    );
  }
}


async function stopScreenShare() {
  if (!screenSharing) {
    return;
  }

  const camera =
    cameraTrack;

  const sender =
    peerConnection
      ?.getSenders()
      .find(
        s =>
          s.track &&
          s.track.kind === "video"
      );

  if (sender && camera) {
    await sender.replaceTrack(
      camera
    );
  }

  if (screenStream) {
    stopStream(screenStream);
    screenStream = null;
  }

  screenSharing = false;

  screenShareBtn?.classList.remove(
    "active"
  );

  if (localVideo) {
    localVideo.srcObject =
      localStream;
  }
}


/*
 * ------------------------------------------------------------
 * SPEAKER
 * ------------------------------------------------------------ */

speakerBtn?.addEventListener(
  "click",
  async () => {
    if (!remoteVideo) return;

    /*
     * setSinkId is not available in every
     * browser, especially mobile browsers.
     */
    if (
      typeof remoteVideo.setSinkId !==
      "function"
    ) {
      setStatus(
        "Speaker selection isn't supported here"
      );
      return;
    }

    try {
      const devices =
        await navigator.mediaDevices.enumerateDevices();

      const outputs =
        devices.filter(
          device =>
            device.kind ===
            "audiooutput"
        );

      if (!outputs.length) {
        return;
      }

      /*
       * Prefer the default output.
       */
      await remoteVideo.setSinkId(
        outputs[0].deviceId
      );
    } catch (err) {
      console.warn(
        "Could not change speaker:",
        err
      );
    }
  }
);


/*
 * ------------------------------------------------------------
 * AUDIO ONLY
 * ------------------------------------------------------------ */

audioOnlyToggle?.addEventListener(
  "change",
  () => {
    const enabled =
      audioOnlyToggle.checked;

    if (!cameraTrack) {
      return;
    }

    cameraTrack.enabled =
      !enabled;

    cameraEnabled =
      !enabled;

    showLocalVideo(
      !enabled
    );
  }
);


/*
 * ------------------------------------------------------------
 * END CALL
 * ------------------------------------------------------------ */

async function finishCall(writeState = true) {
  if (callEnded) {
    return;
  }

  callEnded = true;

  setStatus("Ending call…");

  if (writeState && callId) {
    try {
      await set(
        ref(db, `calls/${callId}/state`),
        "ended"
      );
    } catch (err) {
      console.warn(
        "Could not update call state:",
        err
      );
    }
  }

  for (const cleanup of cleanupFunctions) {
    try {
      cleanup();
    } catch (_) {}
  }

  cleanupFunctions.length = 0;

  if (peerConnection) {
    try {
      peerConnection.close();
    } catch (_) {}
  }

  stopStream(localStream);
  stopStream(remoteStream);
  stopStream(screenStream);

  localStream = null;
  remoteStream = null;
  screenStream = null;

  if (remoteVideo) {
    remoteVideo.srcObject = null;
  }

  if (localVideo) {
    localVideo.srcObject = null;
  }

  setStatus("Call ended");

  setTimeout(() => {
    history.back();
  }, 500);
}


/*
 * ------------------------------------------------------------
 * PAGE CLEANUP
 * ------------------------------------------------------------ */

window.addEventListener(
  "beforeunload",
  () => {
    /*
     * Don't await anything here.
     *
     * onDisconnect handles the Firebase
     * cleanup/state notification.
     */
    stopStream(localStream);
    stopStream(screenStream);

    if (peerConnection) {
      try {
        peerConnection.close();
      } catch (_) {}
    }
  }
);


/*
 * ------------------------------------------------------------
 * FIREBASE PUSH-KEY COMPATIBILITY
 * ------------------------------------------------------------
 *
 * We don't need Firebase push() just to generate
 * an ID, so use a Firebase-compatible random key.
 */

function pushKey() {
  const chars =
    "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz";

  let key = "";

  const now =
    Date.now();

  let timestamp =
    now;

  const timeChars = new Array(8);

  for (let i = 7; i >= 0; i--) {
    timeChars[i] =
      chars.charAt(timestamp % 64);

    timestamp =
      Math.floor(timestamp / 64);
  }

  key += timeChars.join("");

  for (let i = 0; i < 12; i++) {
    key += chars.charAt(
      Math.floor(
        Math.random() * 64
      )
    );
  }

  return key;
}


/*
 * ------------------------------------------------------------
 * ICONS
 * ------------------------------------------------------------ */

try {
  hydrateIcons?.();
} catch (_) {}