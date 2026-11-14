// The built-in floating players (top window only): a draggable, resizable window for VIDEO (takes over when a playing video scrolls out of view
// or you leave its chat, and gives it back when it is on screen again), a window for the CALL (opened from the arrow in the "in call" bar), and a
// slim mini player for AUDIO. The video window and the mini player can be minimised to a small tab that can sit on either screen edge (media keeps
// playing). Also: only ONE thing plays at a time (starting something cancels the old one and removes its controls), the Media Session (lock screen,
// iPhone control centre, headset buttons), Android's media notification (QMApp.mediaState), and automatic browser picture-in-picture when the tab
// is switched. Frames reach this through window.top.__qmPip.
import { icon } from "./ui.js";
import { drawWave, videoPlayer } from "./player.js";

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

  // safe areas (status bar / notch / home bar): a window must never rest under them
  const probe = mk("div"); probe.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)"; D.body.append(probe);
  const insets = () => { const c = getComputedStyle(probe); return { t: parseFloat(c.paddingTop) || 0, r: parseFloat(c.paddingRight) || 0, b: parseFloat(c.paddingBottom) || 0, l: parseFloat(c.paddingLeft) || 0 }; };
  // ------------------------------------------------------------ edge tabs: drag them anywhere along either side
  function makeTab(iconName, id, defTop) {
    const tab = mk("button", "qmpip-tab"); tab.id = "qmPipTab" + id; tab.type = "button"; tab.hidden = true; tab.innerHTML = icon(iconName, 18);
    tab.title = "Show again"; tab.setAttribute("aria-label", "Show the floating player again");
    D.body.append(tab);
    const pos = json("qm-pip-tab-" + id) || { side: "right", y: defTop };
    const apply = () => {
      const I = insets(); pos.y = clamp(pos.y, I.t + 6, Math.max(I.t + 6, innerHeight - I.b - 52));
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
    // soft: while dragging the window may be pulled a little past the border; when let go it snaps back inside
    const place = soft => {
      const vw = innerWidth, vh = innerHeight, pw = el.offsetWidth || 240, ph = el.offsetHeight || 160, I = insets(), g = 6, o = soft ? 40 : 0;
      if (w.x == null) { const s = json("qm-pip-pos-" + id); w.x = s ? s.x : vw - pw - 12; w.y = s ? s.y : vh - ph - 90; }
      const minX = I.l + g - o, maxX = vw - I.r - pw - g + o, minY = I.t + g - o, maxY = vh - I.b - ph - g + o;
      w.x = clamp(w.x, minX, Math.max(minX, maxX)); w.y = clamp(w.y, minY, Math.max(minY, maxY));
      el.style.left = w.x + "px"; el.style.top = w.y + "px"; w.onMove && w.onMove();
    };
    w.place = place;
    let drag = null;
    head.addEventListener("pointerdown", e => { if (e.target.closest("button")) return; drag = { dx: e.clientX - w.x, dy: e.clientY - w.y }; head.setPointerCapture(e.pointerId); e.preventDefault(); });
    head.addEventListener("pointermove", e => { if (!drag) return; w.x = e.clientX - drag.dx; w.y = e.clientY - drag.dy; place(true); });
    head.addEventListener("pointerup", () => { if (drag) { drag = null; el.style.transition = "left .16s, top .16s"; place(); setTimeout(() => { el.style.transition = ""; }, 200); store.set("qm-pip-pos-" + id, JSON.stringify({ x: w.x, y: w.y })); } });
    // resize (bottom-right corner), keeps the picture's shape
    let rs = null;
    grip.addEventListener("pointerdown", e => { rs = { x: e.clientX, y: e.clientY, w: el.offsetWidth }; grip.setPointerCapture(e.pointerId); e.preventDefault(); e.stopPropagation(); });
    grip.addEventListener("pointermove", e => { if (rs) w.setWidth(rs.w + Math.max(e.clientX - rs.x, (e.clientY - rs.y) * (w.ratio || 16 / 9)), true); });
    grip.addEventListener("pointerup", () => { if (rs) { rs = null; store.set("qm-pip-w-" + id, String(el.offsetWidth)); } });
    w.setWidth = (px, live) => {
      const wd = clamp(Math.round(px), 180, Math.min(720, innerWidth - 8)), r = w.ratio || 16 / 9;
      el.style.width = wd + "px"; body.style.height = w.auto ? "" : Math.round(clamp(wd / r, 70, innerHeight * 0.7)) + "px";
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

  // ------------------------------------------------------------ the video: ONE element for its whole life
  // The playing <video> lives here in the top window, in a layer that is never moved, reloaded or re-created. A chat's player only holds an
  // empty slot (its controls bind to this element); the layer is placed over the slot, clipped to what is visible. When the slot scrolls out of
  // view (or its page closes) the layer is simply placed over the floating window's slot instead, so nothing is swapped and nothing pauses.
  const videoState = { open: false, src: "", chat: "", key: "", title: "" };
  let V = null, pl = null, vEl = null, idleT = 0, vraf = 0;
  const host = mk("div", "qmvhost"); host.hidden = true; D.body.append(host);
  vw_.bar.hidden = true; vw_.bNative.hidden = true; vw_.auto = true;
  const gotoMsg = (chat, key) => { if (chat && W.QM) { if (key && W.QM.openChatAt) W.QM.openChatAt(chat, key); else if (W.QM.openChat) W.QM.openChat(chat); } };
  vw_.bClose.onclick = () => closeVideo(true);
  vw_.bOpen.onclick = () => gotoMsg(videoState.chat, videoState.key);
  const inBrowserPip = el => { try { return !!el && el.ownerDocument.pictureInPictureElement === el; } catch (_) { return false; } };

  // where a slot (in this window or in a frame) is on screen, in this window's coordinates, and how much of it can be seen
  const cut = (a, b) => ({ l: Math.max(a.l, b.l), t: Math.max(a.t, b.t), r: Math.min(a.r, b.r), b: Math.min(a.b, b.b) });
  function measure(slot) {
    try {
      let w = slot.ownerDocument.defaultView; if (!slot.isConnected || !w) return null;
      const q = slot.getBoundingClientRect(); if (!q.width || !q.height) return null;
      let full = { l: q.left, t: q.top, r: q.right, b: q.bottom }, vis = { ...full };
      for (let e = slot.parentElement; e; e = e.parentElement) {
        const cs = w.getComputedStyle(e);
        if (cs.overflowX !== "visible" || cs.overflowY !== "visible") { const r = e.getBoundingClientRect(); vis = cut(vis, { l: r.left, t: r.top, r: r.right, b: r.bottom }); }
      }
      vis = cut(vis, { l: 0, t: 0, r: w.innerWidth, b: w.innerHeight });
      while (w !== W) {
        const fe = w.frameElement; if (!fe) return null;
        const r = fe.getBoundingClientRect(), ox = r.left + fe.clientLeft, oy = r.top + fe.clientTop;
        full = { l: full.l + ox, t: full.t + oy, r: full.r + ox, b: full.b + oy }; vis = { l: vis.l + ox, t: vis.t + oy, r: vis.r + ox, b: vis.b + oy };
        vis = cut(vis, { l: r.left, t: r.top, r: r.right, b: r.bottom }); w = w.parent;
      }
      const area = Math.max(0, vis.r - vis.l) * Math.max(0, vis.b - vis.t);
      return { full, vis, frac: area / ((full.r - full.l) * (full.b - full.t)) };
    } catch (_) { return null; }
  }
  const putHost = m => {
    if (!m || m.frac <= 0) { host.style.visibility = "hidden"; return; }
    const f = m.full, v = m.vis, s = host.style;
    s.visibility = ""; s.left = f.l + "px"; s.top = f.t + "px"; s.width = (f.r - f.l) + "px"; s.height = (f.b - f.t) + "px";
    s.clipPath = `inset(${Math.max(0, v.t - f.t)}px ${Math.max(0, f.r - v.r)}px ${Math.max(0, f.b - v.b)}px ${Math.max(0, v.l - f.l)}px)`;
  };

  function sizeVideo() { const saved = +store.get("qm-pip-w-video") || 0; vw_.setWidth(saved || clamp(Math.round(innerWidth * (innerWidth < 600 ? 0.62 : 0.3)), 220, 380)); }
  function showFloat() {
    if (!V || V.mode === "float") return;
    V.mode = "float"; videoState.open = true;
    pl = videoPlayer(V.src, { poster: V.meta.poster || "", title: V.meta.title || "", name: V.meta.name || "", floating: true, hostEl: V.el });
    vw_.body.append(pl);
    Object.assign(videoState, { src: V.src, chat: V.meta.chat || "", key: V.meta.key || "", title: V.meta.title || "" });
    vw_.title.textContent = V.meta.title || "Video"; vw_.bOpen.hidden = !videoState.chat;
    vw_.show(); sizeVideo();
  }
  function hideFloat() {
    if (pl) { try { pl.dispose(); pl.remove(); } catch (_) { /* ignore */ } pl = null; }
    if (V) V.mode = "inline";
    videoState.open = false; if (vw_.shown) vw_.hide();
  }
  function tick() {
    vraf = 0; if (!V) return;
    const el = V.el, playing = !el.paused && !el.ended, inl = V.inline ? measure(V.inline.slot) : null;
    let want;
    if (inBrowserPip(el)) want = "native";
    else if (inl && inl.frac >= (V.mode === "float" ? 0.4 : 0.12)) want = "inline";
    else if ((playing || V.mode === "float") && auto() && !V.closed) want = "float";
    else want = "hidden";
    if (want === "inline" && V.mode === "float") hideFloat();
    else if (want === "float" && V.mode !== "float") showFloat();
    else if ((want === "native" || want === "hidden") && V.mode === "float") hideFloat();
    host.hidden = false;
    if (want === "inline") putHost(inl);
    else if (want === "float" && pl && !vw_.min && vw_.shown) putHost(measure(pl.slot));
    else host.style.visibility = "hidden";
    host.classList.toggle("native", want === "native"); host.classList.toggle("fl", want === "float");
    // not playing and nowhere to show: let go of it after a while
    if (!playing && want === "hidden") { if (!idleT) idleT = setTimeout(() => { idleT = 0; if (V && V.el.paused && !V.inline) dropVideo(); }, 60000); } else if (idleT) { clearTimeout(idleT); idleT = 0; }
    start();
  }
  function start() { if (!vraf && V) vraf = requestAnimationFrame(tick); }
  setInterval(() => { if (V && !vraf) vraf = requestAnimationFrame(tick); }, 500);   // also while the tab is in the background (frames are throttled there)

  /** the element for a video that is already hosted (a chat opened again while it plays), or null */
  const existing = src => (V && V.src === src ? V.el : null);
  /** a chat's player starts a video: o = { src, poster, title, name, slot, chat, key, time, rate, volume, muted }; returns the element (not started) */
  function attach(o) {
    if (!auto() && !o.force) return null;
    if (V && V.src === o.src) { setInline(o.src, o.slot, o); return V.el; }
    if (V) dropVideo();
    const el = D.createElement("video"); el.playsInline = true; el.setAttribute("webkit-playsinline", ""); el.preload = "auto"; el.src = o.src; if (o.poster) el.poster = o.poster; if (o.title) el.title = o.title;
    try { el.playbackRate = o.rate || 1; el.volume = typeof o.volume === "number" ? o.volume : 1; el.muted = !!o.muted; } catch (_) { /* ignore */ }
    const t = +o.time || 0; if (t > 0) el.addEventListener("loadedmetadata", () => { try { el.currentTime = t; } catch (_) { /* ignore */ } }, { once: true });
    host.append(el);
    V = { src: o.src, el, meta: { poster: o.poster, title: o.title, name: o.name, chat: o.chat, key: o.key }, inline: { slot: o.slot }, mode: "inline", closed: false };
    vEl = el;
    el.addEventListener("leavepictureinpicture", () => { ignoreLeave > Date.now() || start(); });
    W.__qmCur = { el, title: o.title || o.name || "Video", kind: "video", src: o.src };
    bind(); start();
    return el;
  }
  function setInline(src, slot, o) {
    if (!V || V.src !== src) return;
    V.inline = { slot }; V.closed = false;
    if (o) { V.meta = { ...V.meta, chat: o.chat || V.meta.chat, key: o.key || V.meta.key, title: o.title || V.meta.title }; videoState.chat = V.meta.chat || ""; videoState.key = V.meta.key || ""; }
    start();
  }
  /** the page that held the slot is going away (or the slot was removed): a playing video carries on in the window */
  function slotGone(slot) { if (V && V.inline && V.inline.slot === slot) { V.inline = null; if (V.el.paused) dropVideo(); else start(); } }
  function dropVideo() {
    if (!V) return;
    const el = V.el; ignoreLeave = Date.now() + 1500;
    try { el.pause(); } catch (_) { /* ignore */ }
    if (inBrowserPip(el)) { try { el.ownerDocument.exitPictureInPicture(); } catch (_) { /* ignore */ } }
    hideFloat();
    try { el.removeAttribute("src"); el.load(); el.remove(); } catch (_) { /* ignore */ }
    if (W.__qmCur && W.__qmCur.el === el) W.__qmCur = null;
    V = null; vEl = null; host.hidden = true; clearTimeout(idleT); idleT = 0;
    bind();
  }
  function closeVideo() { dropVideo(); }
  function fullscreen() {
    if (!V) return;
    const el = V.el, on = D.fullscreenElement === host || D.webkitFullscreenElement === host;
    if (on) { (D.exitFullscreen || D.webkitExitFullscreen).call(D); return; }
    el.controls = true; host.style.pointerEvents = "auto";
    const done = () => { if (!(D.fullscreenElement === host)) { el.controls = false; host.style.pointerEvents = ""; D.removeEventListener("fullscreenchange", done); } };
    D.addEventListener("fullscreenchange", done);
    (host.requestFullscreen || host.webkitRequestFullscreen || (() => Promise.reject())).call(host).catch(() => { if (el.webkitEnterFullscreen) el.webkitEnterFullscreen(); });
  }
  vw_.onVis = () => { start(); };
  addEventListener("resize", start);

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
  const aPlace = soft => {
    const vw = innerWidth, vh = innerHeight, pw = aEl.offsetWidth || 340, ph = aEl.offsetHeight || 80, I = insets(), g = 6, o = soft ? 40 : 0;
    if (!aPos) { const s = json("qm-pip-pos-audio"); aPos = s || { x: (vw - pw) / 2, y: vh - ph - 18 - 20 }; }
    aPos.x = clamp(aPos.x, I.l + g - o, Math.max(I.l + g - o, vw - I.r - pw - g + o)); aPos.y = clamp(aPos.y, I.t + g - o, Math.max(I.t + g - o, vh - I.b - ph - g + o));
    aEl.style.left = aPos.x + "px"; aEl.style.top = aPos.y + "px";
  };
  aTop.addEventListener("pointerdown", e => { if (e.target.closest("button")) return; aPlace(); aDrag = { dx: e.clientX - aPos.x, dy: e.clientY - aPos.y }; aTop.setPointerCapture(e.pointerId); e.preventDefault(); });
  aTop.addEventListener("pointermove", e => { if (!aDrag) return; aPos.x = e.clientX - aDrag.dx; aPos.y = e.clientY - aDrag.dy; aPlace(true); });
  aTop.addEventListener("pointerup", () => { if (aDrag) { aDrag = null; aEl.style.transition = "left .16s, top .16s"; aPlace(); setTimeout(() => { aEl.style.transition = ""; }, 200); store.set("qm-pip-pos-audio", JSON.stringify(aPos)); } });
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
  setInterval(() => { lost(); bind(); paintAudio(); nativeState(false); }, 400);
  let raf = 0;
  const loop = () => { raf = 0; const a = audio(); if (!aEl.hidden && a && !a.paused) { paintAudio(); raf = requestAnimationFrame(loop); } };
  setInterval(() => { if (!raf && !aEl.hidden) raf = requestAnimationFrame(loop); }, 400);
    W.__qmPip = { auto, existing, attach, setInline, slotGone, fullscreen, closeVideo, callFloat, callIsFloating: () => cw_.shown, active: () => videoState.open && videoState.src, cancel };
})();
