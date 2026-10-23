// Shared WebAudio plumbing: one AudioContext, level meters (speaking detection) and a gain "booster" that lets
// a tile go past 100 % volume (HTMLMediaElement.volume tops out at 1).
let ctx = null;
export function audioCtx() {
  if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) { ctx = null; } }
  if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}
// Browsers only allow audio after a user gesture; resume on the first one.
for (const ev of ["pointerdown", "keydown", "touchend"]) addEventListener(ev, () => { if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {}); }, { capture: true, passive: true });

const meters = new Set();
let poll = null;
const THRESH = 0.018;      // RMS above this = voice (after echo cancellation / noise suppression)
const HOLD_MS = 450;        // keep glowing briefly between words

function tick() {
  const now = performance.now();
  for (const m of meters) m._poll(now);
}

export class LevelMeter {
  constructor(onChange) {
    this.onChange = onChange;
    this.speaking = false;
    this._key = "";
    this._src = null;
    this._an = null;
    this._buf = null;
    this._until = 0;
    this.stream = null;
    meters.add(this);
    if (!poll) poll = setInterval(tick, 90);
  }

  setStream(stream) { this.stream = stream || null; }

  _bind() {
    const tracks = this.stream ? this.stream.getAudioTracks().filter(t => t.readyState === "live") : [];
    const key = tracks.map(t => t.id).join(",");
    if (key === this._key) return !!this._an;
    this._unbind();
    this._key = key;
    if (!tracks.length) return false;
    const c = audioCtx();
    if (!c) return false;
    try {
      this._src = c.createMediaStreamSource(new MediaStream(tracks));
      this._an = c.createAnalyser();
      this._an.fftSize = 512;
      this._buf = new Uint8Array(this._an.fftSize);
      this._src.connect(this._an);               // analyser only — never connected to the speakers
    } catch (_) { this._unbind(); return false; }
    return true;
  }

  _unbind() {
    try { this._src && this._src.disconnect(); } catch (_) { /* ignore */ }
    this._src = this._an = this._buf = null;
    this._key = "";
  }

  _poll(now) {
    let loud = false;
    if (this._bind() && audioCtx()?.state === "running") {
      this._an.getByteTimeDomainData(this._buf);
      let sum = 0;
      for (let i = 0; i < this._buf.length; i++) { const v = (this._buf[i] - 128) / 128; sum += v * v; }
      loud = Math.sqrt(sum / this._buf.length) > THRESH;
    }
    if (loud) this._until = now + HOLD_MS;
    const on = now < this._until;
    if (on !== this.speaking) { this.speaking = on; this.onChange(on); }
  }

  destroy() {
    meters.delete(this);
    this._unbind();
    if (this.speaking) { this.speaking = false; this.onChange(false); }
    if (!meters.size && poll) { clearInterval(poll); poll = null; }
  }
}

/** Routes a stream through a GainNode (gain may exceed 1). */
export class Booster {
  constructor() { this._src = null; this._gain = null; this._key = ""; this.active = false; }

  /** @returns {boolean} whether the booster path is carrying the audio */
  apply(stream, gain) {
    const tracks = stream ? stream.getAudioTracks().filter(t => t.readyState === "live") : [];
    if (!tracks.length) { this.release(); return false; }
    const c = audioCtx();
    if (!c) return false;
    const key = tracks.map(t => t.id).join(",");
    try {
      if (!this._gain || key !== this._key) {
        this.release();
        this._src = c.createMediaStreamSource(new MediaStream(tracks));
        this._gain = c.createGain();
        this._src.connect(this._gain);
        this._gain.connect(c.destination);
        this._key = key;
      }
      this._gain.gain.value = gain;
      this.active = true;
      return true;
    } catch (_) { this.release(); return false; }
  }

  release() {
    try { this._src && this._src.disconnect(); this._gain && this._gain.disconnect(); } catch (_) { /* ignore */ }
    this._src = this._gain = null; this._key = ""; this.active = false;
  }
}
