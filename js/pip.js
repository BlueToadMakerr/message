// The built-in floating players (top window only): a small draggable window for VIDEO (takes over when a playing video scrolls out of view
// or you leave its chat, and gives it back when it is on screen again), one for the CALL (instead of hiding the call while you browse),
// and a slim mini player for AUDIO. Each can be minimised to a small tab at the screen edge (media keeps playing), and the video window has
// a button for the browser's / Android's own picture-in-picture. Also drives Android's media notification (QMApp.mediaState) and the
// Media Session (lock screen / headset buttons) for whatever audio or video plays. Frames reach this through window.top.__qmPip.
import { icon } from "./ui.js";

(function () {
  if (window.top !== window || window.__qmPip) return;
  const W = window, D = document, KEY = "qm-pip";
  const store = { get: k => { try { return localStorage.getItem(k); } catch (_) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* ignore */ } } };
  /** Floating players on or off (Account → Audio and video). On by default. */
  const auto = () => store.get(KEY) !== "off";
  const app = () => W.QMApp && W.QMApp.mediaState ? W.QMApp : null;
  const mk = (tag, cls, html) => { const e = D.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const ib = (label, ic, size = 18) => { const b = mk("button", "qmpip-b", icon(ic, size)); b.type = "button"; b.title = label; b.setAttribute("aria-label", label); return b; };
  const fmt = s => { if (!isFinite(s) || s < 0) s = 0; return Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0"); };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ------------------------------------------------------------ small windows (video, call) and their edge tabs
  const wins = [];
  function makeWin(id, tabIconName, tabTopPct) {
    const el = mk("div", "qmpip qmpip-" + id); el.id = "qmPip" + id; el.hidden = true;
    const head = mk("div", "qmpip-head"), title = mk("span", "qmpip-title");
    const bOpen = ib("Open", "popout", 16), bNative = ib("Picture in picture", "pip", 16), bMin = ib("Minimise", "down", 16), bClose = ib("Close", "close", 16);
    head.append(title, bOpen, bNative, bMin, bClose);
    const body = mk("div", "qmpip-body"), bar = mk("div", "qmpip-bar");
    el.append(head, body, bar);
    const tab = mk("button", "qmpip-tab"); tab.type = "button"; tab.hidden = true; tab.title = "Show again"; tab.setAttribute("aria-label", "Show the floating player again");
    tab.innerHTML = icon(tabIconName, 18); tab.style.top = tabTopPct + "%";
    D.body.append(el, tab);
    const w = { id, el, head, title, body, bar, tab, bOpen, bNative, bMin, bClose, min: false, shown: false, x: null, y: null, ratio: 16 / 9, onMove: null, w: 0 };
    const place = () => {
      const vw = innerWidth, vh = innerHeight, pw = el.offsetWidth || 240, ph = el.offsetHeight || 160;
      if (w.x == null) { const s = JSON.parse(store.get("qm-pip-pos-" + id) || "null"); w.x = s ? s.x : vw - pw - 12; w.y = s ? s.y : vh - ph - 90 - (id === "call" ? ph + 12 : 0); }
      w.x = clamp(w.x, 4, Math.max(4, vw - pw - 4)); w.y = clamp(w.y, 4, Math.max(4, vh - ph - 4));
      el.style.left = w.x + "px"; el.style.top = w.y + "px"; w.onMove && w.onMove();
    };
    w.place = place;
    let drag = null;
    head.addEventListener("pointerdown", e => { if (e.target.closest("button")) return; drag = { dx: e.clientX - w.x, dy: e.clientY - w.y }; head.setPointerCapture(e.pointerId); e.preventDefault(); });
    head.addEventListener("pointermove", e => { if (!drag) return; w.x = e.clientX - drag.dx; w.y = e.clientY - drag.dy; place(); });
    head.addEventListener("pointerup", () => { if (drag) { drag = null; store.set("qm-pip-pos-" + id, JSON.stringify({ x: w.x, y: w.y })); } });
    addEventListener("resize", () => { if (w.shown) place(); });
    const sync = () => { el.hidden = !w.shown || w.min; el.classList.toggle("min", w.min); tab.hidden = !w.shown || !w.min; if (!el.hidden) place(); w.onMove && w.onMove(); w.onVis && w.onVis(); };
    w.sync = sync;
    w.show = () => { w.shown = true; w.min = false; sync(); };
    w.hide = () => { w.shown = false; sync(); };
    w.minimise = on => { w.min = on; sync(); };
    bMin.onclick = () => w.minimise(true); tab.onclick = () => w.minimise(false);
    wins.push(w);
    return w;
  }
  const vw_ = makeWin("video", "pip", 40), cw_ = makeWin("call", "phone", 48);

  // ------------------------------------------------------------ current media (what the notification / lock screen / the mini player control)
  let cur = null, curBound = null;
  const curEl = () => (W.__qmCur && W.__qmCur.el) || null;
  const ctl = (op, arg) => {
    const m = curEl(); if (!m) return;
    if (op === "toggle") (m.paused ? m.play().catch(() => {}) : m.pause());
    else if (op === "back") m.currentTime = Math.max(0, m.currentTime - 10);
    else if (op === "fwd") m.currentTime = Math.min(m.duration || 1e9, m.currentTime + 10);
    else if (op === "seek") { if (typeof arg === "number" && isFinite(arg)) m.currentTime = arg; }
    else if (op === "stop") { m.pause(); if (videoState.open && m === vEl) closeVideo(true); }
  };
  W.__qmMediaCtl = ctl;
  let lastSent = "", lastAt = 0;
  function nativeState(force) {
    const m = curEl(), a = app();
    if (!m || !m.isConnected && !m.ownerDocument.defaultView) { if (a && lastSent) { try { a.mediaClear(); } catch (_) { /* ignore */ } } lastSent = ""; return; }
    if (!a) return;
    const playing = !m.paused && !m.ended, key = (W.__qmCur.title || "") + "|" + playing + "|" + Math.round(m.duration || 0), now = Date.now();
    if (!force && key === lastSent && now - lastAt < 4000) return;
    if (!playing && !m.currentTime && !m.duration) return;
    lastSent = key; lastAt = now;
    try { a.mediaState(W.__qmCur.title || "", playing, Math.round((m.currentTime || 0) * 1000), Math.round((m.duration || 0) * 1000), W.__qmCur.kind === "video"); } catch (_) { /* ignore */ }
  }
  function sessionFor(m) {
    try {
      const ms = navigator.mediaSession; if (!ms) return;
      ms.metadata = new MediaMetadata({ title: W.__qmCur.title || (W.__qmCur.kind === "video" ? "Video" : "Audio message"), artist: "QuickMessage", artwork: [{ src: new URL("icons/icon-192.png", location.href).href, sizes: "192x192", type: "image/png" }] });
      const set = (n, f) => { try { ms.setActionHandler(n, f); } catch (_) { /* unsupported */ } };
      set("play", () => ctl("toggle")); set("pause", () => ctl("toggle")); set("seekbackward", () => ctl("back")); set("seekforward", () => ctl("fwd"));
      set("seekto", d => d && ctl("seek", d.seekTime));
    } catch (_) { /* ignore */ }
  }
  const evs = ["play", "pause", "ended", "seeked", "durationchange"];
  const onEv = () => { nativeState(true); paintAudio(); };
  function bind() {
    const m = curEl();
    if (m === curBound) return;
    try { if (curBound && m && !curBound.paused) curBound.pause(); } catch (_) { /* one media at a time */ }
    if (curBound) for (const e of evs) { try { curBound.removeEventListener(e, onEv); } catch (_) { /* dead frame */ } }
    curBound = m;
    if (m) { for (const e of evs) m.addEventListener(e, onEv); sessionFor(m); lastSent = ""; nativeState(true); }
    else if (app()) { try { app().mediaClear(); } catch (_) { /* ignore */ } }
  }
  // the element of a page that has gone away can't play on: forget it
  function lost() {
    const m = curEl(); if (!m) return;
    let gone = false; try { gone = !m.ownerDocument.defaultView || (!m.isConnected && m.tagName === "VIDEO" && m !== vEl); } catch (_) { gone = true; }
    if (gone) { W.__qmCur = null; }
  }

  // ------------------------------------------------------------ the video window
  const videoState = { open: false, src: "", chat: "", title: "", poster: "", auto: true };
  let vEl = null;
  const vPlay = ib("Play", "play"), vBack = ib("Back 10 seconds", "rew"), vFwd = ib("Forward 10 seconds", "ff"), vMute = ib("Mute", "volume");
  vBack.innerHTML = "−10"; vFwd.innerHTML = "+10"; vBack.classList.add("txt"); vFwd.classList.add("txt");
  const vSeek = mk("input", "qmpip-seek"); vSeek.type = "range"; vSeek.min = 0; vSeek.max = 1000; vSeek.value = 0; vSeek.setAttribute("aria-label", "Seek");
  const vTime = mk("span", "qmpip-time", "0:00");
  vw_.bar.append(vPlay, vBack, vSeek, vFwd, vTime, vMute);
  const vPaint = () => {
    if (!vEl) return; const d = vEl.duration || 0;
    vPlay.innerHTML = icon(vEl.paused ? "play" : "pause", 18); vPlay.title = vEl.paused ? "Play" : "Pause";
    if (!seeking) vSeek.value = d ? Math.round(vEl.currentTime / d * 1000) : 0;
    vTime.textContent = fmt(vEl.currentTime) + " / " + fmt(d); vMute.innerHTML = icon(vEl.muted || !vEl.volume ? "volumeX" : "volume", 18);
  };
  let seeking = false;
  vSeek.oninput = () => { seeking = true; if (vEl && vEl.duration) vEl.currentTime = vSeek.value / 1000 * vEl.duration; };
  vSeek.onchange = () => { seeking = false; };
  vPlay.onclick = () => vEl && (vEl.paused ? vEl.play().catch(() => {}) : vEl.pause());
  vBack.onclick = () => vEl && (vEl.currentTime = Math.max(0, vEl.currentTime - 10));
  vFwd.onclick = () => vEl && (vEl.currentTime = Math.min(vEl.duration || 1e9, vEl.currentTime + 10));
  vMute.onclick = () => { if (vEl) vEl.muted = !vEl.muted; };
  vw_.bClose.onclick = () => closeVideo(true);
  vw_.bOpen.onclick = () => { if (videoState.chat && W.QM && W.QM.openChat) { W.QM.openChat(videoState.chat); } };
  vw_.bNative.onclick = () => nativePip();
  vw_.body.addEventListener("click", () => vPlay.onclick());

  function openVideo(s) {
    if (!auto()) return false;
    if (!vEl) {
      vEl = D.createElement("video"); vEl.playsInline = true; vEl.setAttribute("webkit-playsinline", ""); vEl.preload = "auto";
      for (const e of ["play", "pause", "timeupdate", "durationchange", "volumechange", "ended"]) vEl.addEventListener(e, vPaint);
      vEl.addEventListener("loadedmetadata", () => { if (vEl.videoWidth) { vw_.ratio = vEl.videoWidth / vEl.videoHeight; sizeVideo(); } });
      vEl.addEventListener("ended", () => { vEl.currentTime = 0; });
      vw_.body.append(vEl);
    }
    Object.assign(videoState, { open: true, src: s.src, chat: s.chat || "", title: s.title || "", poster: s.poster || "", auto: true });
    vEl.src = s.src; if (s.poster) vEl.poster = s.poster; else vEl.removeAttribute("poster");
    vEl.playbackRate = s.rate || 1; vEl.volume = typeof s.volume === "number" ? s.volume : 1; vEl.muted = !!s.muted;
    vw_.title.textContent = s.title || "Video"; vw_.bOpen.hidden = !videoState.chat;
    const t = +s.time || 0;
    const go = () => { try { vEl.currentTime = t; } catch (_) { /* ignore */ } if (s.playing) vEl.play().catch(() => {}); };
    if (vEl.readyState >= 1) go(); else vEl.addEventListener("loadedmetadata", go, { once: true });
    W.__qmCur = { el: vEl, title: s.title || "Video", kind: "video", src: s.src };
    vw_.show(); sizeVideo(); vPaint(); bind();
    return true;
  }
  function sizeVideo() {
    const w = clamp(Math.round(innerWidth * (innerWidth < 600 ? 0.62 : 0.3)), 200, 360), r = vw_.ratio || 16 / 9;
    vw_.el.style.width = w + "px"; vw_.body.style.height = Math.round(clamp(w / r, 80, innerHeight * 0.45)) + "px";
    vw_.place();
  }
  function closeVideo(userClosed) {
    if (!vEl) return;
    try { vEl.pause(); } catch (_) { /* ignore */ }
    vEl.removeAttribute("src"); try { vEl.load(); } catch (_) { /* ignore */ }
    videoState.open = false; videoState.auto = !userClosed; vw_.hide();
    if (W.__qmCur && W.__qmCur.el === vEl) W.__qmCur = null;
    bind();
  }
  /** a page's video scrolled away / the page is closing while it plays */
  function handoff(s) { try { return openVideo(JSON.parse(typeof s === "string" ? s : JSON.stringify(s))); } catch (_) { return false; } }
  /** the same video is on screen again: takes it back (state returned as JSON, window closed) */
  function take(src) {
    if (!videoState.open || videoState.src !== src || !vEl) return null;
    const s = { time: vEl.currentTime, playing: !vEl.paused, rate: vEl.playbackRate, volume: vEl.volume, muted: vEl.muted };
    closeVideo(false); return JSON.stringify(s);
  }
  // the browser's / Android's own picture-in-picture for the floating video
  async function nativePip() {
    if (!vEl) return;
    try {
      const ap = W.QMApp && W.QMApp.enterVideoPip ? W.QMApp : null;
      if (ap) {
        const root = D.documentElement; root.classList.add("qm-bpip-native");
        const end = () => { root.classList.remove("qm-bpip-native"); vEl.removeEventListener("play", sync); vEl.removeEventListener("pause", sync); vEl.removeEventListener("resize", ratio); delete W.__qmPipCtl; delete W.__qmPipEnded; };
        const sync = () => { try { ap.setPipPlaying(!vEl.paused); } catch (_) { /* ignore */ } };
        const ratio = () => { try { ap.setPipRatio(vEl.videoWidth || 16, vEl.videoHeight || 9); } catch (_) { /* ignore */ } };
        W.__qmPipCtl = op => ctl(op); W.__qmPipEnded = end;
        vEl.addEventListener("play", sync); vEl.addEventListener("pause", sync); vEl.addEventListener("resize", ratio);
        if (vEl.paused) await vEl.play().catch(() => {});
        ap.enterVideoPip(vEl.videoWidth || 16, vEl.videoHeight || 9, !vEl.paused); setTimeout(ratio, 400);
        setTimeout(() => { let on = false; try { on = !!ap.inPip(); } catch (_) { /* ignore */ } if (!on) end(); }, 3000);
        return;
      }
      if (vEl.webkitSupportsPresentationMode && vEl.webkitSupportsPresentationMode("picture-in-picture") && !vEl.requestPictureInPicture) { vEl.webkitSetPresentationMode(vEl.webkitPresentationMode === "picture-in-picture" ? "inline" : "picture-in-picture"); return; }
      if (D.pictureInPictureElement === vEl) await D.exitPictureInPicture();
      else { await vEl.requestPictureInPicture(); vw_.el.classList.add("hold"); vEl.addEventListener("leavepictureinpicture", () => vw_.el.classList.remove("hold"), { once: true }); }
    } catch (_) { /* can't be popped out now */ }
  }
  vw_.onVis = () => { vw_.bNative.hidden = !(D.pictureInPictureEnabled || (W.QMApp && W.QMApp.enterVideoPip) || (vEl && vEl.webkitSupportsPresentationMode)); };

  // ------------------------------------------------------------ the call window
  // The call page stays one persistent iframe; while the call is minimised and floating, that iframe's layer is simply placed over this window.
  let layer = null, callOps = null;
  const cMic = ib("Mute", "mic"), cLeave = ib("Leave call", "phoneOff"), cTime = mk("span", "qmpip-time", "");
  cLeave.classList.add("danger"); cw_.bar.append(cMic, cTime, cLeave); cw_.bNative.hidden = true;
  cw_.bClose.hidden = true;
  const frameOf = () => (layer ? layer.querySelector("iframe") : null);
  const setPipClass = on => { try { const f = frameOf(); f && f.contentDocument && f.contentDocument.documentElement.classList.toggle("bpip-in", on); } catch (_) { /* ignore */ } };
  cw_.onMove = () => {
    if (!layer || !cw_.shown) return;
    if (cw_.min || !cw_.shown) { layer.style.cssText = ""; layer.classList.remove("bpip"); layer.classList.add("min"); return; }
    const r = cw_.body.getBoundingClientRect(); if (!r.width) return;
    layer.classList.remove("min"); layer.classList.add("bpip");
    layer.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;inset:${r.top}px auto auto ${r.left}px;`;
    setPipClass(true);
  };
  cw_.onVis = () => { if (!cw_.shown && layer) { layer.style.cssText = ""; layer.classList.remove("bpip"); setPipClass(false); } };
  cMic.onclick = () => callOps && callOps.mic && callOps.mic();
  cLeave.onclick = () => callOps && callOps.leave && callOps.leave();
  cw_.bOpen.onclick = () => callOps && callOps.expand && callOps.expand();
  cw_.bMin.onclick = () => cw_.minimise(true);
  setInterval(() => { if (cw_.shown && callOps && callOps.time) cTime.textContent = callOps.time(); }, 1000);
  /** shell.js: the call is joined but not on screen */
  function callFloat(on, ops) {
    if (!on || !auto()) { if (cw_.shown) { cw_.hide(); } return false; }
    layer = ops.layer; callOps = ops; cw_.title.textContent = ops.title || "Call";
    cw_.el.style.width = clamp(Math.round(innerWidth * (innerWidth < 600 ? 0.7 : 0.3)), 220, 380) + "px"; cw_.body.style.height = Math.round(clamp(parseFloat(cw_.el.style.width) * 0.66, 140, innerHeight * 0.45)) + "px";
    if (!cw_.shown) cw_.show(); else cw_.sync();
    return true;
  }

  // ------------------------------------------------------------ the mini audio player (a third, audio-only one; not for video or calls)
  const aEl = mk("div", "qmpip-audio"); aEl.hidden = true;
  const aTitle = mk("span", "qmpip-atitle"), aPlay = ib("Play", "play"), aBack = ib("Back 10 seconds", "rew"), aFwd = ib("Forward 10 seconds", "ff"), aMin = ib("Minimise", "down", 16), aClose = ib("Close", "close", 16);
  aBack.innerHTML = "−10"; aFwd.innerHTML = "+10"; aBack.classList.add("txt"); aFwd.classList.add("txt");
  const aSeek = mk("input", "qmpip-seek"); aSeek.type = "range"; aSeek.min = 0; aSeek.max = 1000; aSeek.value = 0; aSeek.setAttribute("aria-label", "Seek");
  const aTime = mk("span", "qmpip-time", "");
  const aTop = mk("div", "qmpip-arow"); aTop.append(aTitle, aMin, aClose);
  const aBot = mk("div", "qmpip-arow"); aBot.append(aPlay, aBack, aSeek, aFwd, aTime);
  aEl.append(aTop, aBot);
  const aTab = mk("button", "qmpip-tab"); aTab.type = "button"; aTab.hidden = true; aTab.innerHTML = icon("headphones", 18); aTab.style.top = "56%"; aTab.title = "Show the audio player"; aTab.setAttribute("aria-label", "Show the audio player");
  D.body.append(aEl, aTab);
  let aMinimised = false, aDismissed = null, aSeeking = false;
  const audio = () => { const a = W.__qmAudio; return a && a.dataset && a.dataset.src ? a : null; };
  const inView = a => !!(W.__qmInView && W.__qmInView[a.dataset.src]);
  function paintAudio() {
    const a = audio();
    // shown while this audio has been started, isn't on screen in a chat, and wasn't closed here
    if (a && !a.paused && aDismissed === a) aDismissed = null;
    const show = auto() && !!a && (a.currentTime > 0 || !a.paused) && !a.ended && !inView(a) && aDismissed !== a;
    aEl.hidden = !show || aMinimised; aTab.hidden = !show || !aMinimised;
    if (!show || !a) return;
    aTitle.textContent = (W.__qmCur && W.__qmCur.el === a && W.__qmCur.title) || a.dataset.title || "Audio message";
    aPlay.innerHTML = icon(a.paused ? "play" : "pause", 18); aPlay.title = a.paused ? "Play" : "Pause";
    const d = a.duration || 0; if (!aSeeking) aSeek.value = d ? Math.round(a.currentTime / d * 1000) : 0;
    aTime.textContent = fmt(a.currentTime) + (d ? " / " + fmt(d) : "");
  }
  aPlay.onclick = () => ctl("toggle"); aBack.onclick = () => { const a = audio(); a && (a.currentTime = Math.max(0, a.currentTime - 10)); }; aFwd.onclick = () => { const a = audio(); a && (a.currentTime = Math.min(a.duration || 1e9, a.currentTime + 10)); };
  aSeek.oninput = () => { aSeeking = true; const a = audio(); if (a && a.duration) a.currentTime = aSeek.value / 1000 * a.duration; }; aSeek.onchange = () => { aSeeking = false; };
  aMin.onclick = () => { aMinimised = true; paintAudio(); }; aTab.onclick = () => { aMinimised = false; paintAudio(); };
  aClose.onclick = () => { const a = audio(); if (a) { a.pause(); aDismissed = a; } paintAudio(); if (app()) { try { app().mediaClear(); } catch (_) { /* ignore */ } } };
  W.addEventListener("pointerdown", () => {}, { passive: true });

  // ------------------------------------------------------------ housekeeping
  setInterval(() => { lost(); bind(); paintAudio(); nativeState(false); if (vEl && videoState.open) vPaint(); }, 500);
  addEventListener("resize", () => { if (videoState.open) sizeVideo(); });
  W.__qmPip = { auto, handoff, take, open: openVideo, closeVideo, callFloat, active: () => videoState.open && videoState.src };
})();
