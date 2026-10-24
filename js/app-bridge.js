// Android app only: hands the signed-in account to the app (so it can show message / incoming-call notifications natively,
// even when the page isn't open) and forgets it on sign-out. Does nothing in a normal browser.
import { auth } from "./firebase.js";
import { onIdTokenChanged } from "./sdk.js";
import { activeDbUrl } from "./dburl.js";
if (window.top === window && window.QMApp && window.QMApp.setSession) {
  onIdTokenChanged(auth, user => {
    try { window.QMApp.setDbUrl && window.QMApp.setDbUrl(activeDbUrl()); } catch (_) { /* ignore */ }
    try { user ? window.QMApp.setSession(user.uid, user.refreshToken) : window.QMApp.logout(); } catch (_) { /* ignore */ }
  });
}

// The app evaluates these in the top window; the call lives in an iframe, so pass screen-share frames/state down to it.
if (window.top === window && (window.QMApp || (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.qmScreen))) {
  const callWin = () => { try { return document.getElementById("callFrame").contentWindow; } catch (_) { return null; } };
  window.__qmScreenAudio = b64 => { const w = callWin(); if (w && w.__qmScreenAudio) w.__qmScreenAudio(b64); };
  window.__qmScreenFrame = b64 => { const w = callWin(); if (w && w.__qmScreenFrame) w.__qmScreenFrame(b64); };
  // Android picture-in-picture buttons of a call (mute / camera / deafen) are forwarded to the call page
  window.__qmCallCtl = op => { const c = callWin() && callWin().__qmCall; if (!c) return; if (op === "mic") c.toggleMute(); else if (op === "cam") c.toggleCam(); else if (op === "deaf") c.toggleDeafen(); };
  window.__qmScreenState = s => { const w = callWin(); if (w && w.__qmScreenState) w.__qmScreenState(s); };
}

// Android app: the app reports downloads (progress, then "saved" with an Open button). Shown in one bar in the top page.
if (window.top === window && window.QMApp) {
  let bar = null, hideT = 0;
  const show = (html, sticky) => {
    if (!bar) { bar = document.createElement("div"); bar.className = "dl-bar"; bar.setAttribute("role", "status"); document.body.append(bar); }
    bar.replaceChildren(); bar.append(html); bar.classList.add("show");
    clearTimeout(hideT); if (!sticky) hideT = setTimeout(() => bar.classList.remove("show"), 7000);
  };
  const line = (title, sub) => { const w = document.createElement("div"); w.className = "dl-text"; const a = document.createElement("strong"); a.textContent = title; const b = document.createElement("span"); b.textContent = sub; w.append(a, b); return w; };
  window.__qmSaving = (name, pct) => {
    const row = document.createElement("div"); row.className = "dl-row";
    const w = line("Downloading…", name); const p = document.createElement("div"); p.className = "dl-prog"; const i = document.createElement("i"); i.style.width = pct >= 0 ? pct + "%" : "40%"; if (pct < 0) p.classList.add("busy"); p.append(i);
    w.append(p); row.append(w); show(row, true);
  };
  window.__qmSaved = info => {
    const row = document.createElement("div"); row.className = "dl-row";
    if (!info.ok) { const gone = /\b(404|410)\b/.test(info.error || ""); row.append(line(gone ? "That file doesn't exist anymore" : "Couldn't save the file", gone ? info.name : info.name + (info.error ? " — " + info.error : ""))); show(row); return; }
    row.append(line("Saved to Downloads", info.name));
    if (info.uri) { const o = document.createElement("button"); o.type = "button"; o.className = "btn small primary"; o.textContent = "Open"; o.onclick = () => { try { window.QMApp.openFile(info.uri, info.mime || ""); } catch (_) { /* ignore */ } }; row.append(o); }
    const x = document.createElement("button"); x.type = "button"; x.className = "btn small"; x.textContent = "✕"; x.setAttribute("aria-label", "Dismiss"); x.onclick = () => bar.classList.remove("show"); row.append(x);
    show(row);
  };
}

// Android app: the app notices headsets / Bluetooth / USB audio being plugged in or removed (without touching the microphone) and calls this.
// Every frame is told, so Account → Audio and the in-call audio dialog refresh their lists.
if (window.top === window && window.QMApp) {
  const tell = w => { try { w.dispatchEvent(new Event("qm-audio-devices")); for (let i = 0; i < w.frames.length; i++) tell(w.frames[i]); } catch (_) { /* cross-origin frame */ } };
  window.__qmAudioDevices = () => tell(window);
}
