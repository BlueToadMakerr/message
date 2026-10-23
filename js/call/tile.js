// Tile — one video/screen tile. Overlay controls live in four fixed zones so they can never stack:
//   top-left: connection status      top-right: tools (pin / fullscreen / move-self)
//   bottom-left: name + indicators   bottom-right: volume
import { icon, avatarEl } from "../ui.js";
import { LevelMeter, Booster } from "./audio.js";
import { registerSink, unregisterSink } from "./devices.js";

const HTML = `
<video playsinline autoplay></video>
<div class="t-avatar"></div>
<div class="t-top">
  <div class="t-status" hidden><span class="t-status-text"></span><button type="button" class="t-retry" hidden>Retry</button></div>
  <div class="t-tools">
    <button type="button" class="t-btn t-self" hidden></button>
    <button type="button" class="t-btn t-pop" hidden></button>
    <button type="button" class="t-btn t-pin"></button>
    <button type="button" class="t-btn t-fs"></button>
  </div>
</div>
<div class="t-bottom">
  <div class="t-popped" hidden><div><span class="t-popped-ic"></span><strong>Popped out</strong><span class="t-popped-sub">Playing in its own window</span><button type="button" class="btn t-popped-back">Bring back</button></div></div>
  <div class="t-name"><span class="nm"></span><span class="tag" hidden></span><span class="ic ic-mic" hidden></span><span class="ic ic-cam" hidden></span><span class="ic ic-spk" hidden></span><span class="ic ic-deaf" hidden></span></div>
  <div class="t-vol"><button type="button" class="t-btn t-mute"></button><input class="t-range" type="range" min="0" max="2" step="0.01" value="1" aria-label="Volume (up to 200%)"><span class="t-pct">100%</span></div>
</div>`;

const STATUS_TEXT = { connecting: "Connecting…", reconnecting: "Reconnecting…", failed: "Connection failed" };

export class Tile {
  constructor({ key, kind = "cam", isSelf = false, onPin, onRetry, onSelfToggle, onBlocked }) {
    this.key = key;
    this.kind = kind;
    this.isSelf = isSelf;
    this.onPin = onPin;
    this.onRetry = onRetry;
    this.onSelfToggle = onSelfToggle;
    this.onBlocked = onBlocked;
    this.hasFrame = false;
    this.wantVideo = false;
    this.stream = null;
    this.vol = 1;                 // 0 … 2 (100 % default, up to 200 %)
    this.userMuted = false;
    this.booster = new Booster();
    this.meter = kind === "screen" ? null : new LevelMeter(on => this.el.classList.toggle("speaking", on));

    const el = (this.el = document.createElement("div"));
    el.className = "tile" + (kind === "screen" ? " is-screen" : "") + (isSelf ? " is-self" : "");
    el.dataset.key = key;
    el.tabIndex = 0;
    el.innerHTML = HTML;
    const $ = s => el.querySelector(s);
    this.video = $("video");
    if (!isSelf) registerSink(this.video);
    this.avatarHost = $(".t-avatar");
    this.statusEl = $(".t-status");
    this.statusText = $(".t-status-text");
    this.retryBtn = $(".t-retry");
    this.nameEl = $(".nm");
    this.tagEl = $(".tag");
    this.micIc = $(".ic-mic");
    this.camIc = $(".ic-cam");
    this.spkIc = $(".ic-spk");
    this.pinBtn = $(".t-pin");
    this.fsBtn = $(".t-fs");
    this.popBtn = $(".t-pop");
    this.selfBtn = $(".t-self");
    this.muteBtn = $(".t-mute");
    this.range = $(".t-range");
    this.pct = $(".t-pct");

    this.deafIc = $(".ic-deaf"); this.deafIc.innerHTML = icon("headphonesOff", 14); this.deafIc.title = "Deafened (can't hear the call)";
    this.forceMute = false;
    this.micIc.innerHTML = icon("micOff", 14);
    this.camIc.innerHTML = icon("cameraOff", 14);
    this.spkIc.innerHTML = icon("volumeX", 14);
    this.micIc.title = "Microphone off";
    this.camIc.title = "Camera off";
    this.spkIc.title = "Muted on your device";
    this.popBtn.innerHTML = icon("popout", 16);
    this.popBtn.title = "Pop out (picture-in-picture)";
    this.popBtn.setAttribute("aria-label", "Pop out video");
    this.pinBtn.innerHTML = icon("pin", 16);
    this.fsBtn.innerHTML = icon("maximize", 16);
    this.pinBtn.setAttribute("aria-label", "Pin");
    this.pinBtn.title = "Pin (spotlight)";
    this.fsBtn.setAttribute("aria-label", "Fullscreen");
    this.fsBtn.title = "Fullscreen";
    this.muteBtn.setAttribute("aria-label", "Mute on this device");
    this.muteBtn.title = "Mute / unmute on this device";

    this.video.muted = isSelf;                        // never play our own audio back
    this.userMuted = false;
    if (isSelf) {
      this.el.querySelector(".t-vol").hidden = true;
      this.selfBtn.hidden = kind === "screen";
      this.selfBtn.innerHTML = icon("grid", 16);
    }

    this.video.addEventListener("playing", () => { this.hasFrame = true; this._paint(); });
    this.video.addEventListener("resize", () => { this.hasFrame = true; this._paint(); });
    this.video.addEventListener("emptied", () => { this.hasFrame = false; this._paint(); });

    // No browser context menu on the video (save / copy / loop …) — use the buttons instead.
    el.addEventListener("contextmenu", e => e.preventDefault());
    this.video.disableRemotePlayback = true;
    this.poppedEl = $(".t-popped");
    $(".t-popped-ic").innerHTML = icon("popout", 22);
    const setPopped = on => { el.classList.toggle("popped", on); this.poppedEl.hidden = !on; };
    this.video.addEventListener("enterpictureinpicture", () => setPopped(true));
    this.video.addEventListener("leavepictureinpicture", () => setPopped(false));
    $(".t-popped-back").addEventListener("click", async e => { e.stopPropagation(); try { await document.exitPictureInPicture(); } catch (_) { setPopped(false); } });
    this.popBtn.addEventListener("click", async e => {
      e.stopPropagation();
      try {
        if (window.QMApp && window.QMApp.enterPipSized) {   // the app uses Android's own picture-in-picture, showing just this video
          document.querySelectorAll(".tile.pip-target").forEach(t => t.classList.remove("pip-target"));
          this.el.classList.add("pip-target"); document.documentElement.classList.add("pip-tile");
          const v = this.video, ratio = () => window.QMApp.setPipRatio(v.videoWidth || 16, v.videoHeight || 9);
          v.addEventListener("resize", ratio);          // the window follows the camera / screen size
          window.QMApp.enterPipSized(v.videoWidth || 16, v.videoHeight || 9);
          setTimeout(ratio, 400); setTimeout(ratio, 1500);
          // if Android refused to enter PiP, don't leave the page stuck in "single tile" mode
          setTimeout(() => { try { if (!window.QMApp.inPip()) { document.documentElement.classList.remove("pip-tile"); this.el.classList.remove("pip-target"); } } catch (_) { /* ignore */ } }, 3000);
          return;
        }
        if (document.pictureInPictureElement === this.video) await document.exitPictureInPicture();
        else await this.video.requestPictureInPicture();
      } catch (_) { /* not available for this video right now */ }
    });
    this.pinBtn.addEventListener("click", e => { e.stopPropagation(); this.onPin && this.onPin(this.key); });
    this.fsBtn.addEventListener("click", e => { e.stopPropagation(); this.toggleFullscreen(); });
    this.selfBtn.addEventListener("click", e => { e.stopPropagation(); this.onSelfToggle && this.onSelfToggle(); });
    this.retryBtn.addEventListener("click", e => { e.stopPropagation(); this.onRetry && this.onRetry(this.key); });
    this.muteBtn.addEventListener("click", e => { e.stopPropagation(); this.userMuted = !this.userMuted; if (!this.userMuted && this.vol === 0) this.vol = 1; this._syncVolume(); });
    this.range.addEventListener("input", () => { this.vol = Number(this.range.value); this.userMuted = false; this._syncVolume(); });
    el.addEventListener("dblclick", e => { if (!e.target.closest("button,input")) this.toggleFullscreen(); });

    // Mouse: controls show while the pointer moves over the tile and fade (with the cursor) once it rests.
    let idleTimer = null, holding = false;
    const wake = () => {
      el.classList.add("active"); el.classList.remove("idle");
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (holding) return wake();                 // still dragging the slider
        el.classList.remove("active"); el.classList.add("idle");
      }, 2500);
    };
    el.addEventListener("pointermove", e => { if (e.pointerType !== "touch") wake(); });
    el.addEventListener("pointerdown", e => { if (e.pointerType !== "touch") { holding = true; wake(); } });
    addEventListener("pointerup", () => { holding = false; }, { passive: true });
    el.addEventListener("pointerleave", () => { clearTimeout(idleTimer); el.classList.remove("active", "idle"); });
    this._clearIdle = () => clearTimeout(idleTimer);

    // touch: first tap reveals the tools for a few seconds
    let timer = null;
    el.addEventListener("pointerdown", e => {
      if (e.pointerType !== "touch" || e.target.closest("button,input")) return;
      el.classList.toggle("show-tools");
      clearTimeout(timer);
      if (el.classList.contains("show-tools")) timer = setTimeout(() => el.classList.remove("show-tools"), 3500);
    });

    this._syncVolume();
    this._paint();
  }

  // ------------------------------------------------------------------ state setters
  setStream(stream, force = false) {
    if (!force && this.stream === stream) return;
    this.stream = stream;
    this.video.srcObject = stream || null;
    this.hasFrame = false;
    this._paint();
    if (stream) this.play();
    if (!this.isSelf && this.meter) this.meter.setStream(stream);
    this._applyVolume();
  }

  /** The audio to watch for speaking (own mic for the self tile; remote tiles use their stream). */
  setAudioSource(stream) { if (this.meter) this.meter.setStream(stream); }

  play() {
    const p = this.video.play();
    if (p && p.catch) p.catch(err => { if (err && err.name === "NotAllowedError" && this.onBlocked) this.onBlocked(); });
  }

  setName(name, tag) {
    this.nameEl.textContent = name;
    this.tagEl.textContent = tag || "";
    this.tagEl.hidden = !tag;
  }

  setAvatar(profile) {
    const key = (profile.displayName || "") + "|" + (profile.pfp || "");
    if (this._avatarKey === key) return;
    this._avatarKey = key;
    this.avatarHost.replaceChildren(avatarEl(profile.displayName, profile.pfp, "avatar-lg"));
  }

  /** audio/video = what the participant reports (mic on / camera on). */
  setMedia({ audio, video, mirror = false, deaf = false }) {
    this.deafIc.hidden = this.kind === "screen" || !deaf;
    this.micIc.hidden = this.kind === "screen" || !!audio;
    this.wantVideo = this.kind === "screen" ? true : !!video;
    if (!this.wantVideo) this.hasFrame = false;
    this.camIc.hidden = this.kind === "screen" || !!video;
    this.el.classList.toggle("mirror", !!mirror && this.kind !== "screen");
    this._paint();
  }

  setLinkState(state, canRetry = true) {
    const text = STATUS_TEXT[state];
    this.statusEl.hidden = !text;
    this.statusText.textContent = text || "";
    this.statusEl.dataset.state = state || "";
    this.retryBtn.hidden = state !== "failed" || !canRetry;
  }

  setPinned(on) {
    this.el.classList.toggle("pinned", on);
    this.pinBtn.classList.toggle("on", on);
    this.pinBtn.setAttribute("aria-pressed", String(on));
    this.pinBtn.title = on ? "Unpin" : "Pin (spotlight)";
  }

  setVolume(v) {
    this.vol = Math.max(0, Math.min(2, v));
    this._syncVolume();
  }

  setHasAudio(has) { this.el.querySelector(".t-vol").hidden = this.isSelf || !has; }

  // ------------------------------------------------------------------ helpers
  _paint() {
    this.el.classList.toggle("no-video", !(this.wantVideo && this.hasFrame));
    this.popBtn.hidden = !((document.pictureInPictureEnabled || (window.QMApp && window.QMApp.enterPip)) && this.wantVideo && this.hasFrame);
  }

  // ≤ 100 %: plain element volume. > 100 %: the element is muted and the audio runs through a GainNode instead.
  _applyVolume() {
    if (this.isSelf) return;
    const mutedNow = this.userMuted || this.forceMute, v = mutedNow ? 0 : this.vol;
    if (v > 1 && this.stream && this.booster.apply(this.stream, v)) {
      this.video.muted = true;
    } else {
      this.booster.release();
      this.video.muted = mutedNow;
      this.video.volume = Math.min(1, v);
    }
  }

  /** Deafen: nothing from this tile is played on this device (its own volume setting is kept for when deafen ends). */
  setDeafened(on) { this.forceMute = !!on; this._applyVolume(); }

  _syncVolume() {
    const silent = this.userMuted || this.vol === 0;
    this.range.value = String(this.userMuted ? 0 : this.vol);
    const pct = Math.round((this.userMuted ? 0 : this.vol) * 100);
    this.pct.textContent = pct + "%";
    this.pct.classList.toggle("boost", pct > 100);
    this.range.title = pct + "%";
    this.muteBtn.innerHTML = icon(silent ? "volumeX" : "volume", 16);
    this.spkIc.hidden = this.isSelf || !silent;
    this._applyVolume();
  }

  async toggleFullscreen() {
    try {
      if (document.fullscreenElement === this.el) await document.exitFullscreen();
      else if (this.el.requestFullscreen) await this.el.requestFullscreen();
      else if (this.video.webkitEnterFullscreen) this.video.webkitEnterFullscreen(); // iOS Safari
    } catch (_) { /* denied */ }
  }

  destroy() {
    this.meter?.destroy();
    unregisterSink(this.video);
    this.booster.release();
    this._clearIdle?.();
    try { this.video.srcObject = null; } catch (_) { /* ignore */ }
    this.el.remove();
  }
}
