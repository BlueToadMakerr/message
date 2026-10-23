// Our own audio and video players (the browser's default controls differ everywhere). The audio player draws a waveform.
import { icon } from "./ui.js";
import { downloadMedia } from "./download.js";
const b64 = u8 => { let s = ""; for (const x of u8) s += String.fromCharCode(x); return btoa(s); };
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

const fmt = s => { if (!isFinite(s) || s < 0) s = 0; const m = Math.floor(s / 60), r = Math.floor(s % 60); return m + ":" + String(r).padStart(2, "0"); };
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3];
const rateText = r => (+r.toFixed(2)) + "×";
let openMenu = null;
/** Speed dropdown: the usual speeds plus a box for any specific value (0.1× – 16×). host: where the menu goes (inside the player in fullscreen). */
function speedMenu(anchor, media, host, onChange) {
  if (openMenu) { openMenu(); return; }
  const doc = anchor.ownerDocument, m = doc.createElement("div"); m.className = "qp-menu"; m.setAttribute("role", "menu");
  const set = r => { r = Math.max(0.1, Math.min(16, +r || 1)); media.playbackRate = r; onChange(r); close(); };
  for (const r of SPEEDS) { const b = btn("qp-opt" + (media.playbackRate === r ? " on" : ""), r + "×", r + "×"); b.setAttribute("role", "menuitemradio"); b.onclick = () => set(r); m.append(b); }
  const f = doc.createElement("form"); f.className = "qp-custom";
  const inp = doc.createElement("input"); inp.type = "number"; inp.min = 0.1; inp.max = 16; inp.step = "any"; inp.placeholder = "Custom"; inp.inputMode = "decimal"; inp.setAttribute("aria-label", "Custom speed");
  if (!SPEEDS.includes(media.playbackRate)) inp.value = +media.playbackRate.toFixed(2);
  const ok = btn("qp-opt qp-set", "Set speed", "Set"); ok.type = "submit";
  f.append(inp, ok); f.onsubmit = e => { e.preventDefault(); if (inp.value) set(inp.value); };
  m.append(f);
  host.append(m);
  const r = anchor.getBoundingClientRect(), hr = host === doc.body ? { left: 0, top: 0, right: innerWidth, bottom: innerHeight } : host.getBoundingClientRect();
  m.style.position = host === doc.body ? "fixed" : "absolute";
  m.style.right = Math.max(4, hr.right - r.right) + "px"; m.style.bottom = Math.max(4, hr.bottom - r.top + 6) + "px";
  const away = e => { if (!m.contains(e.target) && e.target !== anchor) close(); };
  const key = e => { if (e.key === "Escape") close(); };
  setTimeout(() => { doc.addEventListener("pointerdown", away, true); doc.addEventListener("keydown", key, true); }, 0);
  function close() { m.remove(); doc.removeEventListener("pointerdown", away, true); doc.removeEventListener("keydown", key, true); openMenu = null; }
  openMenu = close;
}
const mk = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const btn = (cls, label, html) => { const b = mk("button", cls, html); b.type = "button"; b.setAttribute("aria-label", label); b.title = label; return b; };

/** When the controls get squeezed (narrow bubble, small window) the least important ones move into a "⋯" menu.
 *  items: [{ el, label: () => text, run? }] from least to most expendable-last; an item without `run` is just hidden. */
function overflowMenu(root, measureEl, minW, items, more, media, host) {
  more.hidden = true;
  let hiddenItems = [];
  const layout = () => {
    for (const it of items) it.el.hidden = false;
    more.hidden = true; hiddenItems = [];
    if (!root.clientWidth) return;                              // not on screen yet
    for (const it of items) {
      if (measureEl.clientWidth >= minW) break;
      it.el.hidden = true; hiddenItems.push(it);
      more.hidden = !hiddenItems.some(x => x.run);
    }
    root.classList.toggle("qp-squeezed", hiddenItems.length > 0);
  };
  more.onclick = () => {
    if (openMenu) { openMenu(); return; }
    const doc = more.ownerDocument, m = doc.createElement("div"); m.className = "qp-menu"; m.setAttribute("role", "menu");
    for (const it of hiddenItems) {
      if (!it.run) continue;
      const b = btn("qp-opt", it.label(), it.label()); b.setAttribute("role", "menuitem");
      b.onclick = () => { close(); it.run(more); };
      m.append(b);
    }
    const h = host(); h.append(m);
    const r = more.getBoundingClientRect(), hr = h === doc.body ? { left: 0, top: 0, right: innerWidth, bottom: innerHeight } : h.getBoundingClientRect();
    m.style.position = h === doc.body ? "fixed" : "absolute";
    m.style.right = Math.max(4, hr.right - r.right) + "px"; m.style.bottom = Math.max(4, hr.bottom - r.top + 6) + "px";
    const away = e => { if (!m.contains(e.target) && e.target !== more) close(); };
    const key = e => { if (e.key === "Escape") close(); };
    setTimeout(() => { doc.addEventListener("pointerdown", away, true); doc.addEventListener("keydown", key, true); }, 0);
    function close() { m.remove(); doc.removeEventListener("pointerdown", away, true); doc.removeEventListener("keydown", key, true); openMenu = null; }
    openMenu = close;
  };
  new ResizeObserver(layout).observe(root);
  layout();
  return layout;
}

// One media element plays at a time.
let current = null;
function exclusive(m) { if (current && current !== m) { try { current.pause(); } catch (_) { /* ignore */ } } current = m; }

// ------------------------------------------------------------------ waveform
const BINS = 240;                       // the whole file is summed into this many slices; drawing groups them to fit the width
// The waveform is built from the bytes as they stream in: every so often what has arrived so far is decoded and drawn, so the bars
// fill in from the start while the file loads. To keep data use down, small files (≤ 3 MB) start by themselves when they scroll into
// view, bigger ones (≤ 30 MB) when played; at the limit the download stops and the part that was read stays drawn (the rest is flat).
const AUTO_LIMIT = 3e6, PLAY_LIMIT = 30e6;
let peaksQueue = Promise.resolve();                               // one file at a time
const peaksCache = (() => { try { return window.top.__qmPeaks ||= new Map(); } catch (_) { return new Map(); } })();   // only complete results
/** onProgress({ peaks, duration, partial }) is called with the part decoded so far. Resolves with the final result. */
function realPeaks(src, limit, total, onProgress) {
  if (peaksCache.has(src)) return Promise.resolve(peaksCache.get(src));
  const job = peaksQueue.then(async () => { const r = await decodePeaks(src, limit, total, onProgress); if (!r.partial) peaksCache.set(src, r); return r; });
  peaksQueue = job.catch(() => {});
  return job;
}
function binsOf(au, bins) {
  const ch = [...Array(au.numberOfChannels).keys()].map(i => au.getChannelData(i)), n = au.length, out = new Array(bins).fill(0);
  for (let b = 0; b < bins; b++) {                       // every slice looks at (a stride of) ALL of its samples
    const from = Math.floor(b * n / bins), to = Math.floor((b + 1) * n / bins), stride = Math.max(1, Math.floor((to - from) / 400));
    let sum = 0, cnt = 0;
    for (const d of ch) for (let j = from; j < to; j += stride) { sum += d[j] * d[j]; cnt++; }
    out[b] = cnt ? Math.sqrt(sum / cnt) : 0;             // loudness (RMS) of the slice
  }
  const top = Math.max(...out, 1e-4);
  return out.map(v => Math.max(0.06, Math.pow(v / top, 0.7)));
}
async function decodePeaks(src, limit, total, onProgress) {
  if (navigator.connection && navigator.connection.saveData && !/^(data|blob):/.test(src)) throw new Error("data saver");
  const ctl = new AbortController();
  const r = await fetch(src, { signal: ctl.signal }); if (!r.ok) throw new Error("fetch");
  const len = +r.headers.get("content-length") || 0;
  const AC = window.AudioContext || window.webkitAudioContext, ctx = new AC();
  const parts = []; let n = 0, partial = false, nextTry = 96e3, busy = false;
  const join = () => { const all = new Uint8Array(n); let o = 0; for (const p of parts) { all.set(p, o); o += p.length; } return all.buffer; };
  // a truncated file often still decodes (mp3 / aac / wav / ogg); where it can't yet (e.g. an mp4 with its index at the end) the attempt is just ignored
  const tryPartial = async () => {
    if (busy || !onProgress) return; busy = true;
    try {
      const got = n, au = await ctx.decodeAudioData(join());
      const t = total() || (len ? au.duration * len / got : 0);
      if (t > au.duration * 1.02) {
        const k = Math.max(1, Math.min(BINS - 1, Math.round(BINS * au.duration / t)));
        onProgress({ peaks: binsOf(au, k).concat(new Array(BINS - k).fill(0.06)), duration: 0, partial: true });
      }
    } catch (_) { /* not decodable yet */ }
    busy = false;
  };
  try {
    if (r.body && r.body.getReader) {
      const rd = r.body.getReader();
      for (;;) {
        const { done, value } = await rd.read(); if (done) break;
        n += value.length; parts.push(value);
        if (n >= nextTry) { nextTry = n * 2; tryPartial(); }
        if (n > limit || len > limit && n > limit) { partial = true; ctl.abort(); break; }
      }
    } else { parts.push(new Uint8Array(await r.arrayBuffer())); n = parts[0].length; if (n > limit) partial = true; }
    while (busy) await new Promise(x => setTimeout(x, 30));
    // the final decode: everything that was read (a cut-off file decodes as far as it goes)
    let au;
    try { au = await ctx.decodeAudioData(join()); } catch (e) { if (partial) return { peaks: null, duration: 0, partial: true }; throw e; }
    if (!partial) return { peaks: binsOf(au, BINS), duration: au.duration, partial: false };
    const t = total() || (len ? au.duration * len / n : 0), k = t > au.duration * 1.02 ? Math.max(1, Math.min(BINS - 1, Math.round(BINS * au.duration / t))) : BINS;
    return { peaks: binsOf(au, k).concat(new Array(BINS - k).fill(0.06)), duration: 0, partial: true };
  } finally { try { ctx.close(); } catch (_) { /* ignore */ } }
}

const STORE_BINS = 128;
/** Waveform of a local file, small enough to travel with the message (128 bytes, base64) plus its exact length in seconds. null when it can't be read. */
export async function waveFromFile(file) {
  if (!file || file.size > 40e6) return null;
  const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null;
  const ctx = new AC();
  try {
    const au = await ctx.decodeAudioData(await file.arrayBuffer());
    const pk = binsOf(au, STORE_BINS);
    return { wave: b64(Uint8Array.from(pk, v => Math.round(Math.min(1, v) * 255))), duration: Math.round(au.duration * 100) / 100 };
  } catch (_) { return null; } finally { try { ctx.close(); } catch (_) { /* ignore */ } }
}
const decodeWave = str => { try { const u = unb64(str); return u.length >= 8 && u.length <= 1024 ? Array.from(u, v => Math.max(0.06, v / 255)) : null; } catch (_) { return null; } };

function drawWave(cv, peaks, frac) {
  const dpr = devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  const cs = getComputedStyle(cv), on = cs.getPropertyValue("--qp-on").trim() || "#fff", off = cs.getPropertyValue("--qp-off").trim() || "#ffffff55";
  const gap = 2, bw = 3, n = Math.max(8, Math.floor((w + gap) / (bw + gap))), step = (w + gap) / n - gap;
  for (let i = 0; i < n; i++) {
    let v = 0.2;
    if (peaks) { const a = Math.floor(i * peaks.length / n), b = Math.max(a + 1, Math.floor((i + 1) * peaks.length / n)); v = 0; for (let k = a; k < b; k++) v = Math.max(v, peaks[k]); }
    const bh = Math.max(3, v * h), x = i * (step + gap);
    g.fillStyle = (i + 0.5) / n <= frac ? on : off;
    g.beginPath(); (g.roundRect || g.rect).call(g, x, (h - bh) / 2, step, bh, 2); g.fill();
  }
}

const TOP = (() => { try { void window.top.document; return window.top; } catch (_) { return window; } })();

/** Audio plays from an element that lives in the top window, so it keeps going when you leave the chat (and in the background). */
function topAudio(src) {
  const cur = TOP.__qmAudio;
  if (cur && cur.dataset.src === src) return cur;
  const a = new TOP.Audio(); a.preload = "metadata"; a.dataset.src = src; a.src = src;
  return a;
}
function mediaSession(a, title) {
  try {
    const ms = TOP.navigator.mediaSession; if (!ms) return;
    ms.metadata = new TOP.MediaMetadata({ title: title || "Audio message", artist: "QuickMessage", artwork: [{ src: new URL("icons/icon-192.png", TOP.location.href).href, sizes: "192x192", type: "image/png" }] });
    const set = (n, f) => { try { ms.setActionHandler(n, f); } catch (_) { /* not supported */ } };
    set("play", () => a.play()); set("pause", () => a.pause());
    set("seekbackward", d => { a.currentTime = Math.max(0, a.currentTime - ((d && d.seekOffset) || 10)); });
    set("seekforward", d => { a.currentTime = Math.min(a.duration || 1e9, a.currentTime + ((d && d.seekOffset) || 10)); });
    set("seekto", d => { if (d && typeof d.seekTime === "number") a.currentTime = d.seekTime; });
  } catch (_) { /* ignore */ }
}

export function audioPlayer(src, { title = "", name = "", wave: waveData = "", duration = 0 } = {}) {
  const root = mk("div", "qp qp-audio");
  const a = topAudio(src);
  const play = btn("qp-btn qp-play", "Play", icon("play", 20));
  const wave = mk("canvas", "qp-wave"); wave.setAttribute("role", "slider"); wave.setAttribute("aria-label", "Seek"); wave.tabIndex = 0;
  const time = mk("span", "qp-time", "0:00");
  const spd = btn("qp-btn qp-speed", "Playback speed", rateText(a.playbackRate || 1));
  const dl = btn("qp-btn qp-dl", "Download", icon("download", 18));
  dl.onclick = () => downloadMedia(src, name || title);
  const more = btn("qp-btn qp-more", "More", icon("more", 18));
  root.append(play, wave, time, spd, dl, more);
  if (title) root.title = title;
  let peaks = null, frac = 0, dur = 0, decDur = 0, raf = 0;
  const paint = () => drawWave(wave, peaks, frac);
  // the decoded length is exact; the element's estimate can be off for VBR files
  const upd = () => { dur = decDur || (isFinite(a.duration) && a.duration > 0 ? a.duration : 0); frac = dur ? Math.min(1, a.currentTime / dur) : 0; time.textContent = a.paused && !a.currentTime ? fmt(dur) : fmt(a.currentTime) + " / " + fmt(dur); paint(); };
  const tick = () => { upd(); raf = a.paused ? 0 : requestAnimationFrame(tick); };   // smooth progress while playing
  const uiPlaying = () => { if (!a.paused && !raf) raf = requestAnimationFrame(tick); play.innerHTML = icon(a.paused ? "play" : "pause", 20); play.title = a.paused ? "Play" : "Pause"; };
  const on = {
    loadedmetadata: upd, durationchange: upd, timeupdate: upd, ratechange: () => { spd.textContent = rateText(a.playbackRate); },
    play: () => { if (TOP.__qmAudio && TOP.__qmAudio !== a) { try { TOP.__qmAudio.pause(); } catch (_) { /* ignore */ } } TOP.__qmAudio = a; exclusive(a); mediaSession(a, title); uiPlaying(); },
    pause: uiPlaying,
    ended: () => { a.currentTime = 0; upd(); },
    error: () => { time.textContent = "Can't play"; },
  };
  for (const [k, f] of Object.entries(on)) a.addEventListener(k, f);
  // when this page goes away the audio keeps playing; only our listeners (which belong to this page) are removed
  addEventListener("pagehide", () => { cancelAnimationFrame(raf); for (const [k, f] of Object.entries(on)) a.removeEventListener(k, f); });
  if (a.readyState >= 1) upd(); uiPlaying();
  play.onclick = () => (a.paused ? a.play().catch(() => {}) : a.pause());
  spd.onclick = () => speedMenu(spd, a, document.body, () => {});
  const seekTo = e => { const r = wave.getBoundingClientRect(); const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); if (dur) { a.currentTime = Math.min(f * dur, (isFinite(a.duration) && a.duration) || 1e9); upd(); } };
  let dragging = false;
  wave.addEventListener("pointerdown", e => { dragging = true; wave.setPointerCapture(e.pointerId); seekTo(e); });
  wave.addEventListener("pointermove", e => { if (dragging) seekTo(e); });
  wave.addEventListener("pointerup", () => { dragging = false; });
  wave.addEventListener("keydown", e => { if (e.key === "ArrowRight") a.currentTime += 5; else if (e.key === "ArrowLeft") a.currentTime -= 5; else if (e.key === " ") { e.preventDefault(); play.click(); } });
  // real waveform once the bubble is on screen (falls back to the generated one if the file can't be read, e.g. no CORS)
  let tried = 0;
  let full = false;
  const sent = typeof waveData === "string" && waveData ? decodeWave(waveData) : null;
  if (sent) { peaks = sent; full = true; if (duration > 0) decDur = duration; upd(); }     // the sender's waveform came with the message: nothing to download
  const go = limit => {
    if (full || tried >= limit) return; tried = limit;
    realPeaks(src, limit, () => (isFinite(a.duration) && a.duration > 0 ? a.duration : 0), r => { if (!full) { peaks = r.peaks; paint(); } })
      .then(r => { if (r.peaks) peaks = r.peaks; if (!r.partial) { full = true; decDur = r.duration; } upd(); }).catch(() => {});
  };
  a.addEventListener("play", () => go(PLAY_LIMIT));      // bigger files: only once someone plays them
  if ("IntersectionObserver" in window) { const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { io.disconnect(); go(AUTO_LIMIT); paint(); } }); io.observe(root); } else go(AUTO_LIMIT);
  new ResizeObserver(paint).observe(wave);
  overflowMenu(root, wave, 90, [
    { el: spd, label: () => "Speed (" + rateText(a.playbackRate || 1) + ")", run: m => speedMenu(m, a, document.body, () => {}) },
    { el: dl, label: () => "Download", run: () => dl.click() },
  ], more, a, () => document.body);
  root.audio = a;
  return root;
}

// ------------------------------------------------------------------ video
export function videoPlayer(src, { poster = "", onLayout, autoplay = false, title = "", name = "" } = {}) {
  const root = mk("div", "qp qp-video paused");
  root.tabIndex = 0;
  const v = document.createElement("video"); v.playsInline = true; v.preload = "metadata"; v.src = src; if (poster) v.poster = poster; if (title) v.title = title;
  v.setAttribute("webkit-playsinline", "");
  const big = btn("qp-big", "Play", icon("play", 34));
  const bar = mk("div", "qp-bar");
  const play = btn("qp-btn qp-play", "Play", icon("play", 18));
  const cur = mk("span", "qp-time", "0:00");
  const seek = mk("div", "qp-seek"); const buf = mk("div", "qp-buf"); const fill = mk("div", "qp-fill"); const knob = mk("div", "qp-knob");
  seek.append(buf, fill, knob); seek.setAttribute("role", "slider"); seek.setAttribute("aria-label", "Seek"); seek.tabIndex = 0;
  const dur = mk("span", "qp-time", "0:00");
  const mute = btn("qp-btn", "Mute", icon("volume", 18));
  const vol = document.createElement("input"); vol.type = "range"; vol.min = 0; vol.max = 1; vol.step = 0.05; vol.value = 1; vol.className = "qp-vol"; vol.setAttribute("aria-label", "Volume");
  const spd = btn("qp-btn qp-speed", "Playback speed", "1×");
  const inApp = !!(window.QMApp && window.QMApp.enterVideoPip);                                            // the Android app: its own picture-in-picture
  const safariPip = !!(v.webkitSupportsPresentationMode && v.webkitSupportsPresentationMode("picture-in-picture"));
  const canPip = inApp || safariPip || !!(document.pictureInPictureEnabled && !v.disablePictureInPicture && v.requestPictureInPicture);
  const pip = canPip ? btn("qp-btn", "Picture in picture", icon("pip", 18)) : null;
  const fs = btn("qp-btn", "Full screen", icon("maximize", 18));
  const dl = btn("qp-btn", "Download", icon("download", 18)); dl.onclick = () => downloadMedia(src, name || title);
  const more = btn("qp-btn qp-more", "More", icon("more", 18));
  bar.append(play, cur, seek, dur, mute, vol, spd, ...(pip ? [pip] : []), dl, more, fs);
  root.append(v, big, bar);

  const setPlaying = p => { root.classList.toggle("paused", !p); play.innerHTML = icon(p ? "pause" : "play", 18); big.innerHTML = icon("play", 34); play.title = p ? "Pause" : "Play"; };
  v.addEventListener("play", () => { exclusive(v); setPlaying(true); wake(); });
  v.addEventListener("pause", () => { setPlaying(false); root.classList.add("show"); });
  v.addEventListener("ended", () => { root.classList.add("show"); });
  const upd = () => { const d = v.duration || 0; fill.style.width = knob.style.left = (d ? v.currentTime / d * 100 : 0) + "%"; cur.textContent = fmt(v.currentTime); dur.textContent = fmt(d); if (v.buffered.length && d) buf.style.width = v.buffered.end(v.buffered.length - 1) / d * 100 + "%"; };
  v.addEventListener("timeupdate", upd); v.addEventListener("progress", upd); v.addEventListener("durationchange", upd);
  v.addEventListener("loadedmetadata", () => { upd(); onLayout && onLayout(v); });
  v.addEventListener("error", () => { root.classList.add("failed"); cur.textContent = "Can't play"; });
  v.addEventListener("volumechange", () => { mute.innerHTML = icon(v.muted || v.volume === 0 ? "volumeX" : "volume", 18); vol.value = v.muted ? 0 : v.volume; });
  const toggle = () => (v.paused ? v.play().catch(() => {}) : v.pause());
  play.onclick = toggle; big.onclick = toggle;
  v.addEventListener("click", () => { toggle(); });
  v.addEventListener("dblclick", () => fs.click());
  mute.onclick = () => { v.muted = !v.muted; };
  vol.oninput = () => { v.muted = false; v.volume = +vol.value; };
  spd.onclick = () => speedMenu(spd, v, document.fullscreenElement === root ? root : document.body, r => { spd.textContent = rateText(r); });
  const doPip = async () => {
    try {
      if (inApp) {                                           // Android shows the whole window: only this video is left in it, with play/pause + ±10 s buttons
        if (root.classList.contains("vpip")) return;
        const tops = [[document.documentElement, "qm-vpip-in"]]; try { if (TOP !== window) tops.push([TOP.document.documentElement, "qm-vpip"]); else tops.push([document.documentElement, "qm-vpip"]); } catch (_) { /* ignore */ }
        let ph = null;      // the player is moved out of the message into <body>, so nothing of the chat can show around it in the small window
        const set = on => { if (on && !ph) { ph = document.createComment("pip"); root.replaceWith(ph); document.body.append(root); } else if (!on && ph) { ph.replaceWith(root); ph = null; } root.classList.toggle("vpip", on); for (const [h, c] of tops) h.classList.toggle(c, on); };
        set(true);
        const sync = () => { try { window.QMApp.setPipPlaying(!v.paused); } catch (_) { /* ignore */ } };
        const ratio = () => { try { window.QMApp.setPipRatio(v.videoWidth || 16, v.videoHeight || 9); } catch (_) { /* ignore */ } };
        const end = () => { set(false); v.removeEventListener("play", sync); v.removeEventListener("pause", sync); v.removeEventListener("resize", ratio); try { delete TOP.__qmPipCtl; delete TOP.__qmPipEnded; } catch (_) { /* ignore */ } };
        TOP.__qmPipCtl = op => { if (op === "toggle") (v.paused ? v.play().catch(() => {}) : v.pause()); else v.currentTime = Math.max(0, Math.min(v.duration || 1e9, v.currentTime + (op === "back" ? -10 : 10))); };
        TOP.__qmPipEnded = end;
        v.addEventListener("play", sync); v.addEventListener("pause", sync); v.addEventListener("resize", ratio);
        if (v.paused) await v.play().catch(() => {});
        window.QMApp.enterVideoPip(v.videoWidth || 16, v.videoHeight || 9, !v.paused); setTimeout(ratio, 400);
        setTimeout(() => { let on = false; try { on = !!window.QMApp.inPip(); } catch (_) { /* ignore */ } if (!on) end(); }, 3000);   // Android refused: undo
        return;
      }
      if (v.readyState < 1) await new Promise(r => { v.addEventListener("loadedmetadata", r, { once: true }); setTimeout(r, 4000); });
      if (safariPip && !v.requestPictureInPicture) { v.webkitSetPresentationMode(v.webkitPresentationMode === "picture-in-picture" ? "inline" : "picture-in-picture"); return; }
      if (document.pictureInPictureElement === v) await document.exitPictureInPicture(); else await v.requestPictureInPicture();
    } catch (_) { /* this video can't be popped out right now */ }
  };
  if (pip) pip.onclick = doPip;
  overflowMenu(root, seek, 70, [
    { el: vol, label: () => "Volume" },
    { el: spd, label: () => "Speed (" + rateText(v.playbackRate) + ")", run: m => speedMenu(m, v, document.fullscreenElement === root ? root : document.body, r => { spd.textContent = rateText(r); }) },
    { el: dl, label: () => "Download", run: () => dl.click() },
    ...(pip ? [{ el: pip, label: () => "Picture in picture", run: doPip }] : []),
    { el: mute, label: () => (v.muted ? "Unmute" : "Mute"), run: () => mute.click() },
    { el: dur },
  ], more, v, () => (document.fullscreenElement === root ? root : document.body));
  fs.onclick = () => {
    const on = document.fullscreenElement || document.webkitFullscreenElement;
    if (on) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else if (root.requestFullscreen) root.requestFullscreen().catch(() => {});
    else if (v.webkitEnterFullscreen) v.webkitEnterFullscreen();
  };
  document.addEventListener("fullscreenchange", () => { const on = document.fullscreenElement === root; root.classList.toggle("fullscreen", on); fs.innerHTML = icon(on ? "minimize" : "maximize", 18); });
  let dragging = false;
  const seekTo = e => { const r = seek.getBoundingClientRect(), f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); if (v.duration) { v.currentTime = f * v.duration; upd(); } };
  seek.addEventListener("pointerdown", e => { dragging = true; seek.setPointerCapture(e.pointerId); seekTo(e); });
  seek.addEventListener("pointermove", e => { if (dragging) seekTo(e); });
  seek.addEventListener("pointerup", () => { dragging = false; });
  seek.addEventListener("keydown", e => { if (e.key === "ArrowRight") v.currentTime += 5; else if (e.key === "ArrowLeft") v.currentTime -= 5; });
  root.addEventListener("keydown", e => {
    if (e.target !== root) return;
    if (e.key === " " || e.key === "k") { e.preventDefault(); toggle(); } else if (e.key === "ArrowRight") v.currentTime += 5; else if (e.key === "ArrowLeft") v.currentTime -= 5;
    else if (e.key === "f") fs.click(); else if (e.key === "m") mute.click();
  });
  // controls fade out while playing
  let hideT = null;
  function wake() { root.classList.add("show"); clearTimeout(hideT); if (!v.paused) hideT = setTimeout(() => root.classList.remove("show"), 2500); }
  root.addEventListener("pointermove", wake); root.addEventListener("pointerdown", wake); root.addEventListener("focusin", wake);
  if (autoplay) v.play().catch(() => {});
  root.video = v;
  return root;
}
