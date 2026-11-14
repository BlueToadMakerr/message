// The built-in floating players (top window only): a draggable, resizable window for VIDEO (takes over when a playing video scrolls out of view
// or you leave its chat, and gives it back when it is on screen again), a window for the CALL (opened from the arrow in the "in call" bar), and a
// slim mini player for AUDIO. The video window and the mini player can be minimised to a small tab that can sit on either screen edge (media keeps
// playing). Also: only ONE thing plays at a time (starting something cancels the old one and removes its controls), the Media Session (lock screen,
// iPhone control centre, headset buttons), Android's media notification (QMApp.mediaState), and automatic browser picture-in-picture when the tab
// is switched. Frames reach this through window.top.__qmPip.
import { icon } from "./ui.js";
import { drawWave } from "./player.js";

(function () {
  if (window.top !== window || window.__qmPip) return;
  const W = window, D = document, KEY = "qm-pip";
  const store = { get: k => { try { return localStorage.getItem(k); } catch (_) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* ignore */ } } };
  const json = k => { try { return JSON.parse(store.get(k) || "null"); } catch (_) { return null; } };
  /** Floating players on or off (Account → Floating players). On by default. */
  const auto = () => store.get(KEY) !== "off";
  const app = () => (W.QMApp && W.QMApp.mediaState ? W.QMApp : null);
  const mk = (tag, cls, html) => { const e = D.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const ib = (label, ic, size = 18) => { const b = mk("button", "qmpip-b", icon(ic, size)); b.type = "button"; b.title = label; b.setAttribute("aria-label", label); return b; };
  const fmt = s => { if (!isFinite(s) || s < 0) s = 0; return Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0"); };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const iosMedia = on => { try { W.webkit.messageHandlers.qmNotify.postMessage({ op: "media", on: !!on }); } catch (_) { /* not the iPhone app */ } };

  // ------------------------------------------------------------ edge tabs: drag them anywhere along either side
  function makeTab(iconName, id, defTop) {
    const tab = mk("button", "qmpip-tab"); tab.id = "qmPipTab" + id; tab.type = "button"; tab.hidden = true; tab.innerHTML = icon(iconName, 18);
    tab.title = "Show again"; tab.setAttribute("aria-label", "Show the floating player again");
    D.body.append(tab);
    const pos = json("qm-pip-tab-" + id) || { side: "right", y: defTop };
    const apply = () => {
      pos.y = clamp(pos.y, 4, Math.max(4, innerHeight - 52));
      tab.style.top = pos.y + "px"; tab.classList.toggle("left", pos.side === "left");
      tab.style.left = pos.side === "left" ? "0" : "auto"; tab.style.right = pos.side === "left" ? "auto" : "0";
    };
    apply(); addEventListener("resize", apply);
    let d = null, moved = false;
    tab.addEventListener("pointerdown", e => { d = { x: e.clientX, y: e.clientY, oy: pos.y }; moved = false; tab.setPointerCapture(e.pointerId); });
    tab.addEventListener("pointermove", e => {
      if (!d) return;
      if (!moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) moved = true;
      if (!moved) return;
      tab.classList.add("drag");
      tab.style.left = clamp(e.clientX - 17, 0, innerWidth - 34) + "px"; tab.style.right = "auto"; tab.style.top = clamp(e.clientY - 22, 4, innerHeight - 52) + "px";
    });
    tab.addEventListener("pointerup", e => {
      if (!d) return; const was = moved; d = null; tab.classList.remove("drag");
      if (was) { pos.side = e.clientX < innerWidth / 2 ? "left" : "right"; pos.y = clamp(e.clientY - 22, 4, innerHeight - 52); store.set("qm-pip-tab-" + id, JSON.stringify(pos)); apply(); }
    });
    tab.addEventListener("click", e => { if (moved) { e.stopImmediatePropagation(); moved = false; } }, true);
    return tab;
  }

  // ------------------------------------------------------------ small draggable windows (video, call)
  function makeWin(id, tabIconName, tabTop) {
    const el = mk("div", "qmpip qmpip-" + id); el.id = "qmPip" + id; el.hidden = true;
    const head = mk("div", "qmpip-head"), title = mk("span", "qmpip-title");
    const bOpen = ib("Go to the message", "popout", 16), bNative = ib("Picture in picture", "pip", 16), bMin = ib("Minimise", "down", 16), bClose = ib("Close", "close", 16);
    head.append(title, bOpen, bNative, bMin, bClose);
    const body = mk("div", "qmpip-body"), bar = mk("div", "qmpip-bar"), grip = mk("div", "qmpip-grip");
    el.append(head, body, bar, grip);
    D.body.append(el);
    const tab = makeTab(tabIconName, id, tabTop);
    const w = { id, el, head, title, body, bar, tab, bOpen, bNative, bMin, bClose, min: false, shown: false, x: null, y: null, ratio: 16 / 9, onMove: null, onVis: null };
    const place = () => {
      const vw = innerWidth, vh = innerHeight, pw = el.offsetWidth || 240, ph = el.offsetHeight || 160;
      if (w.x == null) { const s = json("qm-pip-pos-" + id); w.x = s ? s.x : vw - pw - 12; w.y = s ? s.y : vh - ph - 90; }
      w.x = clamp(w.x, 4, Math.max(4, vw - pw - 4)); w.y = clamp(w.y, 4, Math.max(4, vh - ph - 4));
      el.style.left = w.x + "px"; el.style.top = w.y + "px"; w.onMove && w.onMove();
    };
    w.place = place;
    let drag = null;
    head.addEventListener("pointerdown", e => { if (e.target.closest("button")) return; drag = { dx: e.clientX - w.x, dy: e.clientY - w.y }; head.setPointerCapture(e.pointerId); e.preventDefault(); });
    head.addEventListener("pointermove", e => { if (!drag) return; w.x = e.clientX - drag.dx; w.y = e.clientY - drag.dy; place(); });
    head.addEventListener("pointerup", () => { if (drag) { drag = null; store.set("qm-pip-pos-" + id, JSON.stringify({ x: w.x, y: w.y })); } });
    // resize (bottom-right corner), keeps the picture's shape
    let rs = null;
    grip.addEventListener("pointerdown", e => { rs = { x: e.clientX, w: el.offsetWidth }; grip.setPointerCapture(e.pointerId); e.preventDefault(); e.stopPropagation(); });
    grip.addEventListener("pointermove", e => { if (rs) w.setWidth(rs.w + (e.clientX - rs.x), true); });
    grip.addEventListener("pointerup", () => { if (rs) { rs = null; store.set("qm-pip-w-" + id, String(el.offsetWidth)); } });
    w.setWidth = (px, live) => {
      const wd = clamp(Math.round(px), 180, Math.min(720, innerWidth - 8)), r = w.ratio || 16 / 9;
      el.style.width = wd + "px"; body.style.height = Math.round(clamp(wd / r, 70, innerHeight * 0.7)) + "px";
      if (live || w.shown) place();
    };
    addEventListener("resize", () => { if (w.shown) place(); });
    const sync = () => { el.hidden = !w.shown || w.min; el.classList.toggle("min", w.min); tab.hidden = !w.shown || !w.min || !w.hasTab; if (!el.hidden) place(); w.onMove && w.onMove(); w.onVis && w.onVis(); };
    w.hasTab = true; w.sync = sync;
    w.show = () => { w.shown = true; w.min = false; sync(); };
    w.hide = () => { w.shown = false; sync(); };
    w.minimise = on => { w.min = on; sync(); };
    bMin.onclick = () => w.minimise(true); tab.onclick = () => w.minimise(false);
    wins.push(w);
    return w;
  }
  const wins = [];
  const vw_ = makeWin("video", "pip", 300), cw_ = makeWin("call", "phone", 360);

  // ------------------------------------------------------------ one thing plays at a time; its controls are the notification / lock screen / iPhone control centre
  let curBound = null, ignoreLeave = 0, lastSent = "", lastAt = 0, iosOn = false;
  const curEl = () => (W.__qmCur && W.__qmCur.el) || null;
  const ctl = (op, arg) => {
    const m = curEl(); if (!m) return;
    if (op === "toggle") (m.paused ? m.play().catch(() => {}) : m.pause());
    else if (op === "back") m.currentTime = Math.max(0, m.currentTime - 10);
    else if (op === "fwd") m.currentTime = Math.min(m.duration || 1e9, m.currentTime + 10);
    else if (op === "seek") { if (typeof arg === "number" && isFinite(arg)) m.currentTime = arg; }
    else if (op === "stop") cancel(m);
  };
  W.__qmMediaCtl = ctl;
  const clearControls = () => {
    if (app()) { try { app().mediaClear(); } catch (_) { /* ignore */ } }
    try { const ms = navigator.mediaSession; if (ms) { ms.metadata = null; ms.playbackState = "none"; for (const n of ["play", "pause", "seekbackward", "seekforward", "seekto", "previoustrack", "nexttrack"]) { try { ms.setActionHandler(n, null); } catch (_) { /* ignore */ } } setAutoPipHandler(); } } catch (_) { /* ignore */ }
    lastSent = "";
    if (iosOn) { iosOn = false; iosMedia(false); }
  };
  /** the old media is cancelled: stopped, its floating player closed, its controls removed */
  function cancel(m) {
    try { m.pause(); } catch (_) { /* ignore */ }
    if (m === vEl) closeVideo(true);
    else if (m === audio()) aDismissed = m;
    if (W.__qmCur && W.__qmCur.el === m) W.__qmCur = null;
    clearControls(); paintAudio();
  }
  function nativeState(force) {
    const m = curEl(); if (!m) return;
    const playing = !m.paused && !m.ended, key = (W.__qmCur.title || "") + "|" + playing + "|" + Math.round(m.duration || 0), now = Date.now();
    if (playing && !iosOn) { iosOn = true; iosMedia(true); }
    const a = app(); if (!a) return;
    if (!force && key === lastSent && now - lastAt < 4000) return;
    if (!playing && !m.currentTime && !m.duration) return;
    lastSent = key; lastAt = now;
    try { a.mediaState(W.__qmCur.title || "", playing, Math.round((m.currentTime || 0) * 1000), Math.round((m.duration || 0) * 1000), W.__qmCur.kind === "video"); } catch (_) { /* ignore */ }
  }
  function sessionFor() {
    try {
      const ms = navigator.mediaSession; if (!ms) return;
      const c = W.__qmCur;
      ms.metadata = new MediaMetadata({ title: c.title || (c.kind === "video" ? "Video" : "Audio message"), artist: "QuickMessage", artwork: [{ src: new URL("icons/icon-192.png", location.href).href, sizes: "192x192", type: "image/png" }] });
      const set = (n, f) => { try { ms.setActionHandler(n, f); } catch (_) { /* unsupported */ } };
      set("play", () => ctl("toggle")); set("pause", () => ctl("toggle")); set("seekbackward", () => ctl("back")); set("seekforward", () => ctl("fwd"));
      set("seekto", d => d && ctl("seek", d.seekTime));
      setAutoPipHandler();
    } catch (_) { /* ignore */ }
  }
  const evs = ["play", "pause", "ended", "seeked", "durationchange"];
  const onEv = () => { nativeState(true); paintAudio(); try { navigator.mediaSession.playbackState = curBound && !curBound.paused ? "playing" : "paused"; } catch (_) { /* ignore */ } };
  function bind() {
    const m = curEl();
    if (m === curBound) return;
    const prev = curBound;
    if (prev) { for (const e of evs) { try { prev.removeEventListener(e, onEv); } catch (_) { /* dead frame */ } } }
    curBound = m;
    if (prev && m && prev !== m) { try { if (!prev.paused || prev === vEl || prev === audio()) cancel2(prev); } catch (_) { /* ignore */ } }
    if (m) { for (const e of evs) m.addEventListener(e, onEv); sessionFor(); lastSent = ""; nativeState(true); onEv(); }
    else clearControls();
  }
  // the previous one is stopped for good (its controls were already replaced by the new one's)
  function cancel2(prev) {
    try { prev.pause(); } catch (_) { /* ignore */ }
    if (prev === vEl) closeVideo(true); else if (prev === audio()) aDismissed = prev;
  }
  function lost() {
    const m = curEl(); if (!m) return;
    let gone = false; try { gone = !m.ownerDocument.defaultView; } catch (_) { gone = true; }
    if (gone) W.__qmCur = null;
  }

  // ------------------------------------------------------------ the video window (the player's own <video> element is moved in, so playback just carries on)
  const videoState = { open: false, src: "", chat: "", key: "", title: "" };
  let vEl = null, vOwn = false, vRestore = null;
  const vPlay = ib("Play", "play"), vBack = ib("Back 10 seconds", "rew"), vFwd = ib("Forward 10 seconds", "ff"), vMute = ib("Mute", "volume");
  vBack.innerHTML = "−10"; vFwd.innerHTML = "+10"; vBack.classList.add("txt"); vFwd.classList.add("txt");
  const vSeek = mk("input", "qmpip-seek"); vSeek.type = "range"; vSeek.min = 0; vSeek.max = 1000; vSeek.value = 0; vSeek.setAttribute("aria-label", "Seek");
  const vTime = mk("span", "qmpip-time", "0:00");
  vw_.bar.append(vPlay, vBack, vSeek, vFwd, vTime, vMute);
  let seeking = false;
  const vPaint = () => {
    if (!vEl) return; const d = vEl.duration || 0;
    vPlay.innerHTML = icon(vEl.paused ? "play" : "pause", 18); vPlay.title = vEl.paused ? "Play" : "Pause";
    if (!seeking) vSeek.value = d ? Math.round(vEl.currentTime / d * 1000) : 0;
    vTime.textContent = fmt(vEl.currentTime) + " / " + fmt(d); vMute.innerHTML = icon(vEl.muted || !vEl.volume ? "volumeX" : "volume", 18);
  };
  vSeek.oninput = () => { seeking = true; if (vEl && vEl.duration) vEl.currentTime = vSeek.value / 1000 * vEl.duration; };
  vSeek.onchange = () => { seeking = false; };
  vPlay.onclick = () => vEl && (vEl.paused ? vEl.play().catch(() => {}) : vEl.pause());
  vBack.onclick = () => vEl && (vEl.currentTime = Math.max(0, vEl.currentTime - 10));
  vFwd.onclick = () => vEl && (vEl.currentTime = Math.min(vEl.duration || 1e9, vEl.currentTime + 10));
  vMute.onclick = () => { if (vEl) vEl.muted = !vEl.muted; };
  vw_.bClose.onclick = () => closeVideo(true);
  const gotoMsg = (chat, key) => { if (chat && W.QM) { if (key && W.QM.openChatAt) W.QM.openChatAt(chat, key); else if (W.QM.openChat) W.QM.openChat(chat); } };
  vw_.bOpen.onclick = () => gotoMsg(videoState.chat, videoState.key);
  vw_.bNative.onclick = () => nativePip();
  vw_.body.addEventListener("click", () => vPlay.onclick());
  const vEvents = ["play", "pause", "timeupdate", "durationchange", "volumechange", "ended"];
  const onLeavePip = () => {          // the browser's own picture-in-picture was closed: this window takes over, so it keeps playing on the site
    if (ignoreLeave > Date.now()) return;
    if (videoState.open && vEl && !vw_.shown) { vw_.show(); }
  };
  function attachV(el) {
    vEl = el;
    for (const e of vEvents) el.addEventListener(e, vPaint);
    el.addEventListener("loadedmetadata", onMeta); el.addEventListener("leavepictureinpicture", onLeavePip);
  }
  function detachV() {
    if (!vEl) return;
    for (const e of vEvents) { try { vEl.removeEventListener(e, vPaint); } catch (_) { /* ignore */ } }
    try { vEl.removeEventListener("loadedmetadata", onMeta); vEl.removeEventListener("leavepictureinpicture", onLeavePip); } catch (_) { /* ignore */ }
  }
  const onMeta = () => { if (vEl && vEl.videoWidth) { vw_.ratio = vEl.videoWidth / vEl.videoHeight; sizeVideo(); } };
  const inBrowserPip = el => { try { return !!el && el.ownerDocument.pictureInPictureElement === el; } catch (_) { return false; } };

  /** s: { src, time, playing, rate, volume, muted, title, poster, chat, key, nativePip }, el: the player's <video> (moved here: no new element). */
  function openVideo(s, el, restore) {
    if (!auto() || !el) return false;
    if (vEl && vEl !== el) closeVideo(true);
    const t = +s.time || 0, wasPip = inBrowserPip(el);
    ignoreLeave = Date.now() + 1500;
    try { D.adoptNode(el); } catch (_) { /* same realm already */ }
    el.classList.add("qmpip-video"); el.controls = false; vw_.body.append(el);
    attachV(el); vOwn = true; vRestore = typeof restore === "function" ? restore : null;
    Object.assign(videoState, { open: true, src: s.src, chat: s.chat || "", key: s.key || "", title: s.title || "" });
    // moving a video makes the browser reload it: put it back where it was
    const go = () => { try { el.currentTime = t; el.playbackRate = s.rate || 1; el.volume = typeof s.volume === "number" ? s.volume : 1; el.muted = !!s.muted; } catch (_) { /* ignore */ } if (s.playing) el.play().catch(() => {}); };
    try { el.currentTime = t; } catch (_) { /* ignore */ }
    if (el.readyState >= 1) go(); else el.addEventListener("loadedmetadata", go, { once: true });
    vw_.title.textContent = s.title || "Video"; vw_.bOpen.hidden = !videoState.chat;
    W.__qmCur = { el, title: s.title || "Video", kind: "video", src: s.src };
    vw_.ratio = el.videoWidth ? el.videoWidth / el.videoHeight : 16 / 9;
    const wasNative = !!s.nativePip || wasPip;
    if (wasNative) {               // it was in the browser's picture-in-picture: put it back there and keep this window out of the way until that is closed
      vw_.shown = false; vw_.sync(); sizeVideo();
      const again = () => el.requestPictureInPicture().catch(() => { vw_.show(); });
      if (el.readyState >= 1) again(); else el.addEventListener("loadedmetadata", again, { once: true });
    } else { vw_.show(); sizeVideo(); }
    vPaint(); bind();
    return true;
  }
  function sizeVideo() { const saved = +store.get("qm-pip-w-video") || 0; vw_.setWidth(saved || clamp(Math.round(innerWidth * (innerWidth < 600 ? 0.62 : 0.3)), 200, 360)); }
  function release(pause) {
    if (!vEl) return null;
    const el = vEl; detachV(); vEl = null; vOwn = false;
    if (pause) { try { el.pause(); } catch (_) { /* ignore */ } }
    el.classList.remove("qmpip-video");
    return el;
  }
  function closeVideo(userClosed) {
    if (!vEl) return;
    const back = vRestore; vRestore = null;
    const el = release(true);
    try { if (back) back(el); else el.remove(); } catch (_) { try { el.remove(); } catch (__) { /* ignore */ } }   // the page that owns it gets its video back (paused)
    videoState.open = false; ignoreLeave = Date.now() + 1500;
    if (inBrowserPip(el)) { try { el.ownerDocument.exitPictureInPicture(); } catch (_) { /* ignore */ } }
    vw_.hide();
    if (W.__qmCur && W.__qmCur.el === el) W.__qmCur = null;
    bind();
  }
  /** a page's video scrolled away / the page is closing while it plays */
  function handoff(s, el, restore) { try { return openVideo(typeof s === "string" ? JSON.parse(s) : s, el, restore); } catch (_) { return false; } }
  /** the same video is on screen again: the player takes its element back (state returned, window closed) */
  function take(src, el) {
    if (!videoState.open || videoState.src !== src || !vEl) return null;
    const mine = el && vEl === el;
    const s = { time: vEl.currentTime, playing: !vEl.paused, rate: vEl.playbackRate, volume: vEl.volume, muted: vEl.muted, same: !!mine, nativePip: inBrowserPip(vEl) };
    if (mine) { ignoreLeave = Date.now() + 1500; vRestore = null; release(false); videoState.open = false; vw_.hide(); if (W.__qmCur && W.__qmCur.el === el) W.__qmCur = null; }
    else closeVideo(false);
    return JSON.stringify(s);
  }
  // the browser's / Android's own picture-in-picture for the floating video (Android: unchanged)
  async function nativePip() {
    if (!vEl) return;
    try {
      const ap = W.QMApp && W.QMApp.enterVideoPip ? W.QMApp : null;
      if (ap) {
        const root = D.documentElement; root.classList.add("qm-bpip-native");
        const el = vEl;
        const end = () => { root.classList.remove("qm-bpip-native"); el.removeEventListener("play", sync); el.removeEventListener("pause", sync); el.removeEventListener("resize", ratio); delete W.__qmPipCtl; delete W.__qmPipEnded; };
        const sync = () => { try { ap.setPipPlaying(!el.paused); } catch (_) { /* ignore */ } };
        const ratio = () => { try { ap.setPipRatio(el.videoWidth || 16, el.videoHeight || 9); } catch (_) { /* ignore */ } };
        W.__qmPipCtl = op => ctl(op); W.__qmPipEnded = end;
        el.addEventListener("play", sync); el.addEventListener("pause", sync); el.addEventListener("resize", ratio);
        if (el.paused) await el.play().catch(() => {});
        ap.enterVideoPip(el.videoWidth || 16, el.videoHeight || 9, !el.paused); setTimeout(ratio, 400);
        setTimeout(() => { let on = false; try { on = !!ap.inPip(); } catch (_) { /* ignore */ } if (!on) end(); }, 3000);
        return;
      }
      if (vEl.webkitSupportsPresentationMode && vEl.webkitSupportsPresentationMode("picture-in-picture") && !vEl.requestPictureInPicture) { vEl.webkitSetPresentationMode(vEl.webkitPresentationMode === "picture-in-picture" ? "inline" : "picture-in-picture"); return; }
      if (D.pictureInPictureElement === vEl) await D.exitPictureInPicture();
      else { await vEl.requestPictureInPicture(); vw_.hide(); videoState.open = true; }
    } catch (_) { /* can't be popped out now */ }
  }
  vw_.onVis = () => { vw_.bNative.hidden = !(D.pictureInPictureEnabled || (W.QMApp && W.QMApp.enterVideoPip) || (vEl && vEl.webkitSupportsPresentationMode)); };

  // browsers switch to their own picture-in-picture by themselves when the tab is left (a playing video; else the call's window)
  function setAutoPipHandler() {
    try {
      navigator.mediaSession.setActionHandler("enterpictureinpicture", async () => {
        const m = curEl();
        if (m && m.tagName === "VIDEO" && !m.paused && !inBrowserPip(m)) { try { await m.requestPictureInPicture(); } catch (_) { /* not allowed */ } return; }
        try { if (W.QM && W.QM.state && W.QM.state.call.joined && W.QM.autoPopCall) await W.QM.autoPopCall(); } catch (_) { /* ignore */ }
      });
    } catch (_) { /* not supported */ }
  }
  setAutoPipHandler();

  // ------------------------------------------------------------ the call window (opened from the arrow in the "in call" bar; the browser's own window is used where it exists)
  // The call page stays one persistent iframe; its layer is simply placed over this window. The window is just the group name and an up arrow.
  let layer = null, callOps = null;
  cw_.hasTab = false; cw_.bOpen.hidden = true; cw_.bNative.hidden = true; cw_.bClose.hidden = true; cw_.bar.hidden = true; cw_.el.querySelector(".qmpip-grip").hidden = true;
  cw_.bMin.innerHTML = icon("up", 16); cw_.bMin.title = "Hide the call window"; cw_.bMin.setAttribute("aria-label", "Hide the call window");
  const frameOf = () => (layer ? layer.querySelector("iframe") : null);
  const setPipClass = on => { try { const f = frameOf(); f && f.contentDocument && f.contentDocument.documentElement.classList.toggle("bpip-in", on); } catch (_) { /* ignore */ } };
  cw_.onMove = () => {
    if (!layer || !cw_.shown) return;
    const r = cw_.body.getBoundingClientRect(); if (!r.width) return;
    layer.classList.remove("min"); layer.classList.add("bpip");
    layer.style.cssText = `width:${r.width}px;height:${r.height}px;inset:${r.top}px auto auto ${r.left}px;`;
    setPipClass(true);
  };
  cw_.onVis = () => { if (!cw_.shown && layer) { layer.style.cssText = ""; layer.classList.remove("bpip"); setPipClass(false); } };
  cw_.bMin.onclick = () => { callFloat(false); if (layer) layer.classList.add("min"); try { callOps && callOps.onHide && callOps.onHide(); } catch (_) { /* ignore */ } };
  function callFloat(on, ops) {
    if (!on) { if (cw_.shown) cw_.hide(); return false; }
    layer = ops.layer; callOps = ops; cw_.title.textContent = ops.title || "Call";
    cw_.ratio = 16 / 10; cw_.setWidth(clamp(Math.round(innerWidth * (innerWidth < 600 ? 0.8 : 0.3)), 240, 420));
    cw_.show();
    return true;
  }

  // ------------------------------------------------------------ the mini audio player (audio only; a third kind of player that is not a picture-in-picture)
  const aEl = mk("div", "qmpip-audio"); aEl.hidden = true;
  const aTitle = mk("span", "qmpip-atitle"), aPlay = ib("Play", "play"), aBack = ib("Back 10 seconds", "rew"), aFwd = ib("Forward 10 seconds", "ff");
  const aGo = ib("Go to the message", "popout", 16), aMin = ib("Minimise", "down", 16), aClose = ib("Close", "close", 16);
  aBack.innerHTML = "−10"; aFwd.innerHTML = "+10"; aBack.classList.add("txt"); aFwd.classList.add("txt");
  const aWave = mk("canvas", "qmpip-wave"); aWave.setAttribute("role", "slider"); aWave.setAttribute("aria-label", "Seek"); aWave.tabIndex = 0;
  const aTime = mk("span", "qmpip-time", "");
  const aTop = mk("div", "qmpip-arow qmpip-adrag"); aTop.append(aTitle, aGo, aMin, aClose);
  const aBot = mk("div", "qmpip-arow"); aBot.append(aPlay, aBack, aWave, aFwd, aTime);
  aEl.append(aTop, aBot);
  D.body.append(aEl);
  const aTab = makeTab("headphones", "audio", 420);
  let aMinimised = false, aDismissed = null, aPos = null, aDrag = null;
  const audio = () => { const a = W.__qmAudio; return a && a.dataset && a.dataset.src ? a : null; };
  const inView = a => !!(W.__qmInView && W.__qmInView[a.dataset.src]);
  const aPlace = () => {
    const vw = innerWidth, vh = innerHeight, pw = aEl.offsetWidth || 340, ph = aEl.offsetHeight || 80;
    if (!aPos) { const s = json("qm-pip-pos-audio"); aPos = s || { x: (vw - pw) / 2, y: vh - ph - 18 - 20 }; }
    aPos.x = clamp(aPos.x, 4, Math.max(4, vw - pw - 4)); aPos.y = clamp(aPos.y, 4, Math.max(4, vh - ph - 4));
    aEl.style.left = aPos.x + "px"; aEl.style.top = aPos.y + "px";
  };
  aTop.addEventListener("pointerdown", e => { if (e.target.closest("button")) return; aPlace(); aDrag = { dx: e.clientX - aPos.x, dy: e.clientY - aPos.y }; aTop.setPointerCapture(e.pointerId); e.preventDefault(); });
  aTop.addEventListener("pointermove", e => { if (!aDrag) return; aPos.x = e.clientX - aDrag.dx; aPos.y = e.clientY - aDrag.dy; aPlace(); });
  aTop.addEventListener("pointerup", () => { if (aDrag) { aDrag = null; store.set("qm-pip-pos-audio", JSON.stringify(aPos)); } });
  addEventListener("resize", () => { if (!aEl.hidden) aPlace(); });
  function paintAudio() {
    const a = audio();
    if (a && !a.paused && aDismissed === a) aDismissed = null;
    // shown while this audio has been started, isn't on screen in a chat, and wasn't closed here
    const show = auto() && !!a && (a.currentTime > 0 || !a.paused) && !a.ended && !inView(a) && aDismissed !== a;
    aEl.hidden = !show || aMinimised; aTab.hidden = !show || !aMinimised;
    if (!show || !a) return;
    aPlace();
    aTitle.textContent = (W.__qmCur && W.__qmCur.el === a && W.__qmCur.title) || a.dataset.title || "Audio message";
    aGo.hidden = !a.dataset.chat;
    aPlay.innerHTML = icon(a.paused ? "play" : "pause", 18); aPlay.title = a.paused ? "Play" : "Pause";
    const d = a.duration || 0; aTime.textContent = fmt(a.currentTime) + (d ? " / " + fmt(d) : "");
    drawWave(aWave, (W.__qmWave && W.__qmWave[a.dataset.src]) || null, d ? a.currentTime / d : 0);
  }
  aPlay.onclick = () => ctl("toggle");
  aBack.onclick = () => { const a = audio(); a && (a.currentTime = Math.max(0, a.currentTime - 10)); };
  aFwd.onclick = () => { const a = audio(); a && (a.currentTime = Math.min(a.duration || 1e9, a.currentTime + 10)); };
  const aSeekTo = e => { const a = audio(), r = aWave.getBoundingClientRect(); if (a && a.duration) { a.currentTime = clamp((e.clientX - r.left) / r.width, 0, 1) * a.duration; paintAudio(); } };
  let aSeeking = false;
  aWave.addEventListener("pointerdown", e => { aSeeking = true; aWave.setPointerCapture(e.pointerId); aSeekTo(e); });
  aWave.addEventListener("pointermove", e => { if (aSeeking) aSeekTo(e); });
  aWave.addEventListener("pointerup", () => { aSeeking = false; });
  aWave.addEventListener("keydown", e => { const a = audio(); if (!a) return; if (e.key === "ArrowRight") a.currentTime += 5; else if (e.key === "ArrowLeft") a.currentTime -= 5; else if (e.key === " ") { e.preventDefault(); aPlay.click(); } });
  aMin.onclick = () => { aMinimised = true; paintAudio(); }; aTab.onclick = () => { aMinimised = false; paintAudio(); };
  aGo.onclick = () => { const a = audio(); if (a) gotoMsg(a.dataset.chat, a.dataset.msg || ""); };
  aClose.onclick = () => { const a = audio(); if (a) { cancel(a); } };

  // ------------------------------------------------------------ housekeeping
  setInterval(() => { lost(); bind(); paintAudio(); nativeState(false); if (vEl && videoState.open) vPaint(); }, 400);
  let raf = 0;
  const loop = () => { raf = 0; const a = audio(); if (!aEl.hidden && a && !a.paused) { paintAudio(); raf = requestAnimationFrame(loop); } };
  setInterval(() => { if (!raf && !aEl.hidden) raf = requestAnimationFrame(loop); }, 400);
  addEventListener("resize", () => { if (videoState.open) sizeVideo(); });
  W.__qmPip = { auto, handoff, take, closeVideo, callFloat, callIsFloating: () => cw_.shown, active: () => videoState.open && videoState.src, cancel };
})();
