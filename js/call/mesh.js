// PeerLink — one RTCPeerConnection between two *sessions* (a session = one device/tab in the call).
//
// Signalling is transport-agnostic: the owner supplies `send(msg)` and feeds incoming messages to
// `handleSignal(msg)`. Negotiation follows the W3C "perfect negotiation" pattern, so both sides may
// (re)negotiate at any time — screen share start/stop, camera appearing late, ICE restarts — and offer
// collisions (glare) resolve themselves. On top of that:
//   * every message carries an `epoch`. A message from an older epoch is dropped; a message from a newer one
//     makes us rebuild our RTCPeerConnection. That is how reconnects / full resets stay in sync and how stale
//     signalling can never be applied to a fresh connection.
//   * answers are only applied while we really have a local offer outstanding (the old
//     "Called in wrong state: stable" error), otherwise they're ignored as stale.
//   * incoming signals are processed strictly one at a time.

import { applyScreenSender } from "../screenprefs.js";
export const LINK = Object.freeze({
  CONNECTING: "connecting",
  CONNECTED: "connected",
  RECONNECTING: "reconnecting",
  FAILED: "failed",
  CLOSED: "closed"
});

const RANK = { connected: 0, connecting: 1, reconnecting: 2, failed: 3, closed: 4 };
export const worstState = (...states) =>
  states.filter(s => s in RANK).sort((a, b) => RANK[b] - RANK[a])[0] || LINK.CONNECTING;

const toJSON = d => ({ type: d.type, sdp: d.sdp });

export class PeerLink {
  /**
   * @param {object} o
   * @param {string} o.selfId, o.peerId      session ids (their ordering decides who is "polite")
   * @param {RTCConfiguration} o.rtcConfig
   * @param {MediaStream} o.camStream        stream every camera/mic track is attached to (its id is published)
   * @param {(msg:{t:string,epoch:number,d:any})=>void} o.send
   * @param {(track:MediaStreamTrack, stream:MediaStream|null)=>void} o.onTrack
   * @param {(state:string)=>void} o.onState
   * @param {(...a:any[])=>void} [o.log]
   */
  constructor({ selfId, peerId, rtcConfig, camStream, send, onTrack, onState, log }) {
    this.selfId = selfId;
    this.peerId = peerId;
    this.polite = selfId > peerId;
    this.rtcConfig = rtcConfig;
    this.sendRaw = send;
    this.onTrack = onTrack;
    this.onStateChange = onState || (() => {});
    this.log = log || (() => {});

    // mic/cam are "persistent": toggling swaps the track on the same sender (no renegotiation).
    // screen slots are added/removed, which renegotiates.
    this.slots = {
      mic: { kind: "audio", persistent: true, track: null, stream: camStream, sender: null },
      cam: { kind: "video", persistent: true, track: null, stream: camStream, sender: null },
      screen: { kind: "video", persistent: false, track: null, stream: null, sender: null },
      screenAudio: { kind: "audio", persistent: false, track: null, stream: null, sender: null },
      screen2: { kind: "video", persistent: false, track: null, stream: null, sender: null }   // the phone's screen, shared alongside our own
    };

    this.epoch = 1;
    this.queue = Promise.resolve();
    this.closed = false;
    this.state = LINK.CONNECTING;
    this._everConnected = false;
    this._iceRestarts = 0;
    this._resets = 0;
    this._timers = new Set();
    this._createPc();
  }

  // ------------------------------------------------------------------ public API
  /** Set (or clear with null) the track in a slot: "mic" | "cam" | "screen" | "screenAudio" | "screen2". */
  async setTrack(name, track, stream) {
    const slot = this.slots[name];
    if (!slot) throw new Error("Unknown slot " + name);
    slot.track = track || null;
    if (stream) slot.stream = stream;
    await this._applySlot(name);
  }

  handleSignal(msg) {
    this.queue = this.queue.then(async () => {
      if (this.closed) return;
      const epoch = Number(msg.epoch) || 1;
      if (epoch < this.epoch) { this.log("drop stale epoch", epoch, "<", this.epoch, msg.t); return; }
      if (epoch > this.epoch) this._reset(epoch);
      await this._handle(msg);
    }).catch(err => this.log("signal error", err));
  }

  /** Rebuild the connection from scratch (the peer follows because our epoch is higher). */
  restart() {
    this.queue = this.queue.then(() => { if (!this.closed) this._reset(this.epoch + 1); })
      .catch(err => this.log("restart error", err));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this._clearTimers();
    this._closePc();
    this.state = LINK.CLOSED;
  }

  get pcState() { return this.pc ? this.pc.connectionState || this.pc.iceConnectionState : "closed"; }

  // ------------------------------------------------------------------ internals
  _send(t, d) { if (!this.closed) this.sendRaw({ t, epoch: this.epoch, d }); }

  _setState(s) {
    if (this.closed || s === this.state) return;
    this.state = s;
    try { this.onStateChange(s); } catch (e) { this.log("onState error", e); }
  }

  _later(fn, ms) {
    const id = setTimeout(() => { this._timers.delete(id); if (!this.closed) fn(); }, ms);
    this._timers.add(id);
    return id;
  }
  _clearTimers() { this._timers.forEach(clearTimeout); this._timers.clear(); }

  _closePc() {
    const pc = this.pc;
    this.pc = null;
    if (!pc) return;
    pc.ontrack = pc.onicecandidate = pc.onnegotiationneeded = pc.onconnectionstatechange = pc.oniceconnectionstatechange = null;
    try { pc.close(); } catch (_) { /* already closed */ }
  }

  _createPc() {
    this._clearTimers();
    const pc = new RTCPeerConnection(this.rtcConfig);
    this.pc = pc;
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.settingRemoteAnswer = false;
    this.pendingCandidates = [];
    for (const s of Object.values(this.slots)) s.sender = null;

    pc.ontrack = e => {
      if (pc !== this.pc) return;
      this.onTrack(e.track, (e.streams && e.streams[0]) || null);
    };
    pc.onicecandidate = e => {
      if (pc !== this.pc || !e.candidate) return;
      this._send("cand", JSON.parse(JSON.stringify(e.candidate.toJSON())));
    };
    pc.onnegotiationneeded = async () => {
      if (pc !== this.pc) return;
      try {
        this.makingOffer = true;
        if (pc.signalingState !== "stable") return; // fires again once we're stable if still needed
        await this._setLocal(pc);
        if (pc !== this.pc || !pc.localDescription) return;
        this._send("desc", toJSON(pc.localDescription));
      } catch (err) {
        this.log("negotiationneeded failed", err);
      } finally {
        this.makingOffer = false;
      }
    };
    const onConn = () => { if (pc === this.pc) this._connectionChanged(); };
    pc.onconnectionstatechange = onConn;
    pc.oniceconnectionstatechange = onConn;

    this._setState(this._everConnected ? LINK.RECONNECTING : LINK.CONNECTING);
    this._later(() => { if (this.state !== LINK.CONNECTED) this._recover("connect timeout"); }, 15000);

    for (const name of Object.keys(this.slots)) {
      if (this.slots[name].track) this._applySlot(name).catch(err => this.log("applySlot failed", name, err));
    }
  }

  _reset(epoch) {
    this.log("reset → epoch", epoch);
    this._closePc();
    this.epoch = epoch;
    this._createPc();
  }

  async _applySlot(name) {
    const pc = this.pc;
    if (!pc || pc.signalingState === "closed") return;
    const slot = this.slots[name];
    if (slot.track) {
      if (slot.sender && pc.getSenders().includes(slot.sender)) {
        if (slot.sender.track !== slot.track) await slot.sender.replaceTrack(slot.track);
      } else {
        slot.sender = pc.addTrack(slot.track, slot.stream);
        if (name === "screen" || name === "screen2") applyScreenSender(pc, slot.sender, slot.track);
      }
    } else if (slot.sender) {
      if (slot.persistent) {
        if (slot.sender.track) await slot.sender.replaceTrack(null);
      } else {
        try { pc.removeTrack(slot.sender); } catch (_) { /* sender gone with pc */ }
        slot.sender = null;
      }
    }
  }

  // setLocalDescription() without arguments is the modern form; fall back for older browsers.
  async _setLocal(pc) {
    try {
      await pc.setLocalDescription();
    } catch (err) {
      if (err && err.name !== "TypeError") throw err;
      const d = pc.signalingState === "have-remote-offer" ? await pc.createAnswer() : await pc.createOffer();
      await pc.setLocalDescription(d);
    }
  }

  async _handle(msg) {
    const pc = this.pc;
    if (!pc) return;

    if (msg.t === "desc") {
      const d = msg.d;
      if (!d || (d.type !== "offer" && d.type !== "answer")) return;

      const readyForOffer = !this.makingOffer && (pc.signalingState === "stable" || this.settingRemoteAnswer);
      const collision = d.type === "offer" && !readyForOffer;
      this.ignoreOffer = !this.polite && collision;
      if (this.ignoreOffer) { this.log("ignored colliding offer (impolite)"); return; }

      if (d.type === "answer" && pc.signalingState !== "have-local-offer") {
        this.log("ignored stale answer in state", pc.signalingState);
        return;
      }

      try {
        this.settingRemoteAnswer = d.type === "answer";
        await pc.setRemoteDescription({ type: d.type, sdp: d.sdp }); // implicit rollback when polite + collision
      } finally {
        this.settingRemoteAnswer = false;
      }
      if (pc !== this.pc) return;

      const queued = this.pendingCandidates.splice(0);
      for (const c of queued) {
        try { await pc.addIceCandidate(c); } catch (err) { if (!this.ignoreOffer) this.log("queued candidate failed", err); }
      }

      if (d.type === "offer") {
        await this._setLocal(pc);
        if (pc !== this.pc || !pc.localDescription) return;
        this._send("desc", toJSON(pc.localDescription));
      }
    } else if (msg.t === "cand") {
      if (!msg.d) return;
      if (!pc.remoteDescription) { this.pendingCandidates.push(msg.d); return; }
      try {
        await pc.addIceCandidate(msg.d);
      } catch (err) {
        if (!this.ignoreOffer) this.log("candidate failed", err);
      }
    }
  }

  // ------------------------------------------------------------------ connection health
  _connectionChanged() {
    const s = this.pcState;
    if (s === "connected" || s === "completed") {
      this._clearTimers();
      this._everConnected = true;
      this._iceRestarts = 0;
      this._resets = 0;
      this._setState(LINK.CONNECTED);
    } else if (s === "disconnected") {
      this._setState(LINK.RECONNECTING);
      this._later(() => { if (this.pcState === "disconnected") this._recover("still disconnected"); }, 4000);
    } else if (s === "failed") {
      this._recover("failed");
    } else if (s === "new" || s === "connecting" || s === "checking") {
      if (this._everConnected) this._setState(LINK.RECONNECTING);
    }
  }

  _recover(why) {
    if (this.closed) return;
    this.log("recover:", why);
    if (this._iceRestarts < 2 && this.pc && typeof this.pc.restartIce === "function") {
      this._iceRestarts++;
      this._setState(LINK.RECONNECTING);
      try { this.pc.restartIce(); } catch (_) { /* ignore */ }
      this._later(() => { if (this.state !== LINK.CONNECTED) this._recover("restart timeout"); }, 12000);
    } else if (this._resets < 2) {
      this._resets++;
      this._iceRestarts = 0;
      this._setState(LINK.RECONNECTING);
      this.restart();
    } else {
      this._setState(LINK.FAILED);
    }
  }
}
