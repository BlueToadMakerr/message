// LocalMedia — microphone, camera, camera switching and screen sharing for one session.
// It owns the real MediaStreamTracks and reports changes through `onSlot(slot, track, stream)` so the
// caller can hand them to every peer link ("mic" | "cam" | "screen" | "screenAudio").
//
// Camera "off" really releases the camera (light goes off): the track is stopped and the senders are
// emptied; turning it back on re-acquires it. The microphone is muted with track.enabled so un-muting is instant.

import { getScreenPrefs, webVideoConstraints, androidParams, clearScreenOverride } from "../screenprefs.js";
import { audioPrefs, nativeAudio } from "./devices.js";
import { audioCtx } from "./audio.js";
import { nativeScreen } from "../native.js";
const AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const VIDEO = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } };

// Remember the user's mic / camera on-off choice in this browser.
const PREF = { mic: "qm-call-mic", cam: "qm-call-cam" };
const readPref = k => { try { return localStorage.getItem(PREF[k]); } catch (_) { return null; } };
const writePref = (k, on) => { try { localStorage.setItem(PREF[k], on ? "1" : "0"); } catch (_) { /* storage blocked */ } };

const gum = c => navigator.mediaDevices.getUserMedia(c);
/** Audio constraints with the microphone chosen in the audio settings (falls back to the default one when it is gone). */
const audioC = () => { const id = nativeAudio() ? "" : audioPrefs().mic;       // the Android app routes the microphone itself
   return id ? { ...AUDIO, deviceId: { ideal: id } } : AUDIO; };

export class LocalMedia {
  constructor({ onSlot, onChange, log }) {
    this.onSlot = onSlot || (() => {});
    this.onChange = onChange || (() => {});
    this.log = log || (() => {});

    this.camStream = new MediaStream();     // only its id matters: every camera/mic track is attached to it
    this.preview = new MediaStream();       // what the local <video> shows (camera only, never audio)
    this.mic = null;
    this.cam = null;
    this.micOn = false;
    this.camOn = false;
    this.screen = null;                     // { video, audio, stream }
    this.cameraCount = 0;
    this.camDeviceId = null;
    this.micError = null;                   // "denied" | "missing" | null
    this.camError = null;
    this.canScreen = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) || !!nativeScreen();
    this._busy = false;
    this.micSource = "local";              // "local" | "phone": which device the mic / camera tracks come from
    this.camSource = "local";
    this.onExternal = () => {};             // called when a mute/unmute must also reach the phone

    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener("devicechange", () => this.refreshDevices());
    }
  }

  get canMic() { return !!this.mic; }
  get canCam() { return !!this.cam || (this.camError !== "denied" && this.cameraCount > 0); }
  get canSwitch() { return this.camSource === "local" && this.camOn && !!this.cam && this.cameraCount > 1; }

  _errKind(err) {
    return err && (err.name === "NotAllowedError" || err.name === "SecurityError") ? "denied" : "missing";
  }

  async init() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this.micError = this.camError = "missing";
      return;
    }
    let stream = null;
    const wantCam = readPref("cam") !== "0";        // camera was left off last time → don't even switch it on
    const wantMic = readPref("mic") !== "0";
    try {
      stream = await gum({ audio: audioC(), video: wantCam ? VIDEO : false });
    } catch (err) {
      this.log("combined getUserMedia failed", err);
      // Maybe only one of the two devices exists, or one was blocked — try them separately.
      const a = await gum({ audio: audioC() }).catch(e => { this.micError = this._errKind(e); return null; });
      const v = wantCam ? await gum({ video: VIDEO }).catch(e => { this.camError = this._errKind(e); return null; }) : null;
      stream = new MediaStream([...(a ? a.getAudioTracks() : []), ...(v ? v.getVideoTracks() : [])]);
    }

    const rawMic = stream.getAudioTracks()[0] || null;
    this.mic = rawMic ? this._wireMic(rawMic) : null;
    this.cam = stream.getVideoTracks()[0] || null;
    if (!this.mic && !this.micError) this.micError = "missing";
    if (!this.cam && !this.camError && wantCam) this.camError = "missing";
    this.micOn = !!this.mic && wantMic;
    if (this.mic) this.mic.enabled = this.micOn;
    this.camOn = !!this.cam;
    if (this.cam) {
      this.camDeviceId = this.cam.getSettings().deviceId || null;
      this.preview.addTrack(this.cam);
      this.cam.addEventListener("ended", () => this._camEnded(this.cam));
    }
    if (rawMic) this._watchMic(rawMic);
    await this.refreshDevices();
    this.onChange();
  }

  // ---- microphone: device choice + volume. At 100 % the raw track is sent as is; otherwise it goes through a gain stage.
  _wireMic(raw) {
    this._rawMic = raw;
    this._dropGraph();
    const vol = audioPrefs().micVol;
    if (Math.abs(vol - 1) < 0.01) return raw;
    const c = audioCtx();
    if (!c) return raw;
    try {
      const src = c.createMediaStreamSource(new MediaStream([raw])), gain = c.createGain(), dest = c.createMediaStreamDestination();
      gain.gain.value = vol; src.connect(gain); gain.connect(dest);
      this._graph = { src, gain, dest };
      return dest.stream.getAudioTracks()[0] || raw;
    } catch (_) { return raw; }
  }
  _dropGraph() { try { this._graph && (this._graph.src.disconnect(), this._graph.gain.disconnect()); } catch (_) { /* ignore */ } this._graph = null; }
  _watchMic(raw) {
    raw.addEventListener("ended", () => { if (this._rawMic !== raw) return; this.mic = null; this._rawMic = null; this._dropGraph(); this.micOn = false; this.micError = "missing"; this.onSlot("mic", null); this.onChange(); });
  }
  /** Use another microphone (deviceId "" = the system default) without leaving the call. */
  async setMicDevice(id) {
    if (this.micSource !== "local") return;
    let stream;
    try { stream = await gum({ audio: id ? { ...AUDIO, deviceId: { exact: id } } : AUDIO }); }
    catch (err) { this.log("mic switch failed", err); throw err; }
    const raw = stream.getAudioTracks()[0];
    if (!raw) return;
    const old = this._rawMic, wasOn = this.mic ? this.micOn : readPref("mic") !== "0";
    this._rawMic = null; this._dropGraph();
    try { old && old.stop(); } catch (_) { /* ignore */ }
    this.mic = this._wireMic(raw); this.micError = null; this.micOn = wasOn; this.mic.enabled = wasOn;
    this._watchMic(raw);
    this.onSlot("mic", this.mic); this.onChange();
  }
  /** Re-apply the saved microphone volume to the running call. */
  setMicVolume() {
    if (this.micSource !== "local" || !this._rawMic) return;
    this.mic = this._wireMic(this._rawMic); this.mic.enabled = this.micOn;
    this.onSlot("mic", this.mic); this.onChange();
  }

  async refreshDevices() {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      this.cameraCount = devs.filter(d => d.kind === "videoinput").length;
    } catch (_) { /* leave as is */ }
    this.onChange();
  }

  _camEnded(track) {
    if (this.cam !== track) return;          // we stopped it ourselves
    this.preview.removeTrack(track);
    this.cam = null;
    this.camOn = false;
    this.onSlot("cam", null);
    this.onChange();
  }

  // ------------------------------------------------------------------ microphone
  toggleMic() {
    if (!this.mic) return;
    this.micOn = !this.micOn;
    this.mic.enabled = this.micOn;
    if (this.micSource === "phone") this.onExternal("mic", this.micOn);
    else writePref("mic", this.micOn);
    this.onChange();
  }

  // ------------------------------------------------------------------ phone (companion) sources
  /** Take the microphone from the phone's track, or go back to this device (stays muted unless `unmute`). */
  async useMicSource(src, ext, { unmute = false } = {}) {
    if (src === "phone") {
      if (this.micSource === "local" && this.mic) { const old = this.mic; this.mic = null; try { old.stop(); } catch (_) { /* ignore */ } }
      this.micSource = "phone"; this.mic = ext; this.micOn = true; this.micError = null; ext.enabled = true;
      this.onSlot("mic", ext); this.onChange();
      return;
    }
    if (this.micSource === "local" && this.mic) { if (unmute) { this.micOn = true; this.mic.enabled = true; this.onChange(); } return; }
    this.mic = null; this.micSource = "local";
    let track = null;
    let raw = null;
    try { raw = (await gum({ audio: audioC() })).getAudioTracks()[0] || null; this.micError = null; }
    catch (err) { this.micError = this._errKind(err); this.log("local mic failed", err); }
    track = raw ? this._wireMic(raw) : null;
    this.mic = track; this.micOn = !!track && unmute;
    if (track) { track.enabled = this.micOn; this._watchMic(raw); }
    this.onSlot("mic", track); this.onChange();
  }

  setMicOn(on) { if (this.mic) { this.micOn = !!on; this.mic.enabled = this.micOn; this.onChange(); } }

  /** Take the camera from the phone's track, or go back to this device's camera (may throw if blocked). */
  async useCamSource(src, ext) {
    if (src === "phone") {
      const old = this.cam;
      if (old && this.camSource === "local") { this.cam = null; try { old.stop(); } catch (_) { /* ignore */ } }
      this.preview.getTracks().forEach(t => this.preview.removeTrack(t));
      this.camSource = "phone"; this.cam = ext; this.camOn = true; this.camError = null;
      this.preview.addTrack(ext);
      this.onSlot("cam", ext); this.onChange();
      return;
    }
    if (this.camSource === "phone") this.phoneCamOff();
    this.camSource = "local";
    if (!this.cam) await this._openCamera(this.camDeviceId);
  }

  /** The phone's camera stopped: drop its track (the camera is then simply off). */
  phoneCamOff() {
    if (this.camSource !== "phone") return;
    this.preview.getTracks().forEach(t => this.preview.removeTrack(t));
    this.cam = null; this.camOn = false; this.camSource = "local";
    this.onSlot("cam", null); this.onChange();
  }

  // ------------------------------------------------------------------ camera
  async toggleCam() {
    if (this._busy || this.camSource === "phone") return;     // the phone's camera is switched through the Phone panel
    this._busy = true;
    try {
      if (this.camOn && this.cam) {
        const old = this.cam;
        this.cam = null;
        this.camOn = false;
        this.preview.removeTrack(old);
        old.stop();
        this.onSlot("cam", null);
      } else {
        await this._openCamera(this.camDeviceId);
      }
    } catch (err) {
      this.camError = this._errKind(err);
      this.log("camera toggle failed", err);
      throw err;
    } finally {
      this._busy = false;
      writePref("cam", this.camOn);
      this.onChange();
    }
  }

  async _openCamera(deviceId) {
    const video = deviceId ? { ...VIDEO, deviceId: { exact: deviceId } } : VIDEO;
    let stream;
    try { stream = await gum({ video }); }
    catch (err) {
      if (!deviceId) throw err;
      stream = await gum({ video: VIDEO });  // that device vanished — take whatever is available
    }
    const track = stream.getVideoTracks()[0];
    this.cam = track;
    this.camSource = "local";
    this.camOn = true;
    this.camError = null;
    this.camDeviceId = track.getSettings().deviceId || deviceId || null;
    this.preview.getTracks().forEach(t => this.preview.removeTrack(t));
    this.preview.addTrack(track);
    track.addEventListener("ended", () => this._camEnded(track));
    this.onSlot("cam", track);
    await this.refreshDevices();
  }

  async switchCamera() {
    if (this._busy || !this.canSwitch) return;
    this._busy = true;
    try {
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "videoinput");
      if (devs.length < 2) return;
      const idx = Math.max(0, devs.findIndex(d => d.deviceId === this.camDeviceId));
      const next = devs[(idx + 1) % devs.length];
      const old = this.cam;
      // Release first: many phones can't open two cameras at once.
      old.stop();
      this.preview.removeTrack(old);
      this.cam = null;
      try {
        await this._openCamera(next.deviceId);
      } catch (err) {
        this.log("switch failed, reopening previous camera", err);
        await this._openCamera(this.camDeviceId).catch(() => {
          this.camOn = false; this.onSlot("cam", null);
        });
        throw err;
      }
    } finally {
      this._busy = false;
      this.onChange();
    }
  }

  // ------------------------------------------------------------------ screen share
  // Inside the Android app the WebView can't capture the screen itself, so the app captures it natively and streams frames
  // into a canvas (window.__qmScreenFrame); the canvas stream is the screen track.
  async _startNativeScreen() {
    const nat = nativeScreen();
    const canvas = document.createElement("canvas");
    canvas.width = 640; canvas.height = 360;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    const stream = canvas.captureStream(0);
    const video = stream.getVideoTracks()[0];
    const img = new Image();
    let busy = false;
    window.__qmScreenFrame = b64 => {
      if (busy) return;
      busy = true;
      img.onload = () => {
        if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) { canvas.width = img.naturalWidth; canvas.height = img.naturalHeight; }
        ctx.drawImage(img, 0, 0);
        try { video.requestFrame(); } catch (_) { /* ignore */ }
        busy = false;
      };
      img.onerror = () => { busy = false; };
      img.src = "data:image/jpeg;base64," + b64;
    };
    // sound from other apps: 24 kHz mono PCM chunks from the app, played into a MediaStream destination → the "screen audio" track
    let actx = null, dest = null, cursor = 0, audioTrack = null;
    window.__qmScreenAudio = b64 => {
      try {
        if (!actx) { actx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 }); dest = actx.createMediaStreamDestination(); audioTrack = dest.stream.getAudioTracks()[0]; this._screenAudioReady && this._screenAudioReady(audioTrack); }
        if (actx.state === "suspended") actx.resume().catch(() => {});
        const bin = atob(b64), n = bin.length >> 1, buf = actx.createBuffer(1, n, 24000), ch = buf.getChannelData(0);
        for (let i = 0; i < n; i++) { let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8); if (v & 0x8000) v -= 0x10000; ch[i] = v / 32768; }
        const src = actx.createBufferSource(); src.buffer = buf; src.connect(dest);
        const now = actx.currentTime;
        if (cursor < now + 0.02 || cursor > now + 0.6) cursor = now + 0.15;      // (re)start with a little cushion
        src.start(cursor); cursor += buf.duration;
      } catch (_) { /* ignore */ }
    };
    const keep = setInterval(() => { try { video.requestFrame(); } catch (_) { /* ignore */ } }, 700);   // static screens still need frames
    const result = await new Promise(res => {
      window.__qmScreenState = st => { if (st === "started" || st === "denied") res(st); else if (st === "stopped") this.stopScreen(); };
      setTimeout(() => res("denied"), 60000);
      try { try { const [edge, q, f] = androidParams(); nat.setQuality(edge, q, f); } catch (_) { /* older app */ } nat.start(); } catch (_) { res("denied"); }
    });
    if (result !== "started") { clearInterval(keep); window.__qmScreenFrame = null; return null; }
    video.stop = (orig => function () { clearInterval(keep); window.__qmScreenFrame = null; window.__qmScreenAudio = null; try { actx && actx.close(); } catch (_) { /* ignore */ } try { nat.stop(); } catch (_) { /* ignore */ } orig.call(this); })(video.stop);
    // The audio track exists once the first chunk arrives; wait briefly so it can be published together with the video.
    let aTrack = null;
    await new Promise(res => { this._screenAudioReady = t => { aTrack = t; res(); }; setTimeout(res, 800); });
    this._screenAudioReady = null;
    if (aTrack) stream.addTrack(aTrack);
    this.screen = { video, audio: aTrack, stream };
    video.contentHint = "detail";
    this.onChange();
    return this.screen;
  }

  async startScreen() {
    if (!this.canScreen || this.screen) return null;
    if (nativeScreen() && !(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia)) return this._startNativeScreen();
    if (window.QMApp && window.QMApp.startScreen) return this._startNativeScreen();
    let stream;
    const prefs = getScreenPrefs();
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: webVideoConstraints(prefs),
        audio: prefs.audio,
        systemAudio: "exclude",          // don't loop everyone's voices back (Chromium hint)
        suppressLocalAudioPlayback: true
      });
    } catch (err) {
      if (err && (err.name === "NotAllowedError" || err.name === "AbortError")) return null; // user cancelled
      try { stream = await navigator.mediaDevices.getDisplayMedia({ video: true }); }
      catch (e) { if (e && (e.name === "NotAllowedError" || e.name === "AbortError")) return null; throw e; }
    }
    const video = stream.getVideoTracks()[0];
    const audio = stream.getAudioTracks()[0] || null;
    if ("contentHint" in video && prefs.hint !== "auto") video.contentHint = prefs.hint;   // detail = sharp text, motion = smooth video
    this.screen = { video, audio, stream };
    video.addEventListener("ended", () => this.stopScreen());
    this.onChange();
    return this.screen;
  }

  stopScreen() {
    const s = this.screen;
    if (!s) return;
    this.screen = null;
    this.onChange();                               // publish "screen: false" first so tiles vanish at once
    this.onSlot("screen", null);
    this.onSlot("screenAudio", null);
    s.stream.getTracks().forEach(t => { try { t.stop(); } catch (_) { /* ignore */ } });
    clearScreenOverride();                          // settings picked for this one share are forgotten
  }

  destroy() {
    this.stopScreen();
    [this.mic, this._rawMic, this.cam].forEach(t => { try { t && t.stop(); } catch (_) { /* ignore */ } });   // (a phone track just stops receiving)
    this._dropGraph(); this._rawMic = null;
    this.mic = this.cam = null;
    this.preview.getTracks().forEach(t => this.preview.removeTrack(t));
  }
}
