// Screen sharing quality settings (Account → Screen sharing). Stored on this device; used the next time you start sharing.
const KEY = "qm-screen";
export const DEFAULTS = { preset: "balanced", res: "auto", fps: 15, bitrate: 0, hint: "detail", degrade: "auto", codec: "auto", audio: true, jpeg: 55, afps: 5 };
export const PRESETS = {
  balanced: { label: "Balanced (default)", res: "auto", fps: 15, bitrate: 0, hint: "detail", degrade: "auto", codec: "auto", jpeg: 55, afps: 5 },
  text: { label: "Sharp text / slides", res: "1080", fps: 10, bitrate: 4000, hint: "detail", degrade: "resolution", codec: "auto", jpeg: 80, afps: 5 },
  motion: { label: "Smooth motion / games", res: "1080", fps: 60, bitrate: 10000, hint: "motion", degrade: "framerate", codec: "auto", jpeg: 60, afps: 15 },
  max: { label: "Max everything", res: "source", fps: 60, bitrate: 50000, hint: "detail", degrade: "balanced", codec: "auto", jpeg: 95, afps: 30, audio: true },
};
export const RES = { auto: "Automatic", 720: "720p", 1080: "1080p", 1440: "1440p", 2160: "4K", source: "Full screen size" };
const dims = { 720: [1280, 720], 1080: [1920, 1080], 1440: [2560, 1440], 2160: [3840, 2160], source: [7680, 4320] };
const clamp = (v, a, b, d) => { v = +v; return Number.isFinite(v) ? Math.max(a, Math.min(b, v)) : d; };

// Settings picked in the "start sharing" dialog apply to that one share only (unless saved as the default).
let override = null;
export const setScreenOverride = p => { override = p ? { ...p } : null; };
export const clearScreenOverride = () => { override = null; };
export function storedScreenPrefs() { let o = {}; try { o = JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch (_) { /* ignore */ } return o; }
export function getScreenPrefs() {
  const o = override || storedScreenPrefs();
  const p = { ...DEFAULTS, ...o };
  p.fps = clamp(p.fps, 1, 60, 15); p.bitrate = clamp(p.bitrate, 0, 50000, 0); p.jpeg = clamp(p.jpeg, 30, 95, 55); p.afps = clamp(p.afps, 1, 30, 5);
  return p;
}
export function setScreenPrefs(p) { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch (_) { /* ignore */ } }
export function resetScreenPrefs() { try { localStorage.removeItem(KEY); } catch (_) { /* ignore */ } }

/** getDisplayMedia video constraints for the saved settings. */
export function webVideoConstraints(p = getScreenPrefs()) {
  const v = { frameRate: { ideal: p.fps, max: Math.max(p.fps, 1) } };
  if (p.res !== "auto" && dims[p.res]) { v.width = { ideal: dims[p.res][0] }; v.height = { ideal: dims[p.res][1] }; }
  return v;
}
/** [longest edge px, JPEG quality, frames per second] for the Android app's own screen capture. */
export function androidParams(p = getScreenPrefs()) {
  const edge = { auto: 1024, 720: 1280, 1080: 1920, 1440: 2560, 2160: 2560, source: 2560 }[p.res] || 1024;
  return [edge, p.jpeg, p.afps];
}

/** Sets codec preference / bitrate / frame rate / "what to give up" on a screen-share sender. Safe to call more than once. */
export function applyScreenSender(pc, sender, track, p = getScreenPrefs()) {
  try { if (track && "contentHint" in track && p.hint !== "auto") track.contentHint = p.hint; } catch (_) { /* ignore */ }
  try {                                                         // codec: must happen before the offer, i.e. right after addTrack
    if (p.codec !== "auto" && window.RTCRtpSender && RTCRtpSender.getCapabilities) {
      const want = { vp9: "video/VP9", vp8: "video/VP8", h264: "video/H264", av1: "video/AV1" }[p.codec];
      const caps = RTCRtpSender.getCapabilities("video");
      const tr = pc.getTransceivers().find(t => t.sender === sender);
      if (want && caps && tr && tr.setCodecPreferences) {
        const pick = caps.codecs.filter(c => c.mimeType.toLowerCase() === want.toLowerCase());
        if (pick.length) tr.setCodecPreferences([...pick, ...caps.codecs.filter(c => !pick.includes(c))]);
      }
    }
  } catch (_) { /* unsupported: keep the default */ }
  const set = async () => {
    try {
      if (!sender || pc.signalingState === "closed") return;
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      const e = params.encodings[0];
      if (p.bitrate > 0) e.maxBitrate = p.bitrate * 1000; else delete e.maxBitrate;
      e.maxFramerate = p.fps; e.scaleResolutionDownBy = 1; e.priority = "high"; e.networkPriority = "high";
      if (p.degrade !== "auto") params.degradationPreference = { resolution: "maintain-resolution", framerate: "maintain-framerate", balanced: "balanced" }[p.degrade];
      await sender.setParameters(params);
    } catch (_) { /* some browsers refuse some fields */ }
  };
  set(); setTimeout(set, 1500); setTimeout(set, 6000);        // again once negotiation has produced the real encodings
}
