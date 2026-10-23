// CallRoom — Firebase Realtime Database side of a call.
//
//   calls/{chatId}/sessions/{sessionId}          one entry per *device/tab* in the call (never per user)
//       uid, joinedAt, lastSeen, device, audio, video, screen, camStream, screenStream, links/{peerSessionId}
//   calls/{chatId}/inbox/{uid}/{sessionId}/{id}  signalling messages addressed to one session; the recipient
//                                                deletes each one once read, so nothing stale ever lingers
//   (ringing lives in ring.js — it must work before/after a session exists)
//
// A session is created fresh on every join (new id), registered with onDisconnect cleanup, kept alive by a
// heartbeat, and re-registered automatically if the server drops it (network blip) — in that case `onReset`
// fires so the caller rebuilds its peer connections.

import { db } from "../firebase.js";
import {
  ref, set, update, remove, push, onValue, onChildAdded, onDisconnect, serverTimestamp
} from "../sdk.js";

const HEARTBEAT_MS = 15000;
export const STALE_MS = 120000;     // keep in sync with the database rules

export const newId = () => push(ref(db, "_ids")).key; // generates a key locally, writes nothing

export class CallRoom {
  /**
   * @param {object} o
   * @param {string} o.chatId
   * @param {string} o.uid
   * @param {(sessions:Object)=>void} o.onSessions    all live sessions (including ours)
   * @param {(msg:object)=>void} o.onSignal           {from, t, epoch, d}
   * @param {()=>void} o.onReset                      our session had vanished server-side and was re-created
   * @param {(online:boolean)=>void} [o.onConnection]
   * @param {(...a:any[])=>void} [o.log]
   */
  constructor({ chatId, uid, onSessions, onSignal, onReset, onConnection, log }) {
    this.chatId = chatId;
    this.uid = uid;
    this.sessionId = newId();
    this.onSessions = onSessions;
    this.onSignal = onSignal;
    this.onReset = onReset;
    this.onConnection = onConnection || (() => {});
    this.log = log || (() => {});

    this.base = `calls/${chatId}`;
    this.sessionRef = ref(db, `${this.base}/sessions/${this.sessionId}`);
    this.inboxRef = ref(db, `${this.base}/inbox/${uid}/${this.sessionId}`);

    this.state = {};
    this.links = {};
    this.offset = 0;
    this.joined = false;
    this._seenSelf = false;
    this._healing = false;
    this._unsubs = [];
    this._hb = null;
    this._wasOnline = null;
    this.startedAt = null;       // when the call began (first person in), kept for the whole call even if that person leaves
    this._live = {};
    this._startRef = ref(db, `${this.base}/startedAt`);
  }

  now() { return Date.now() + this.offset; }

  // ------------------------------------------------------------------ lifecycle
  async join(initialState) {
    this.state = { ...initialState, uid: this.uid };
    await remove(this.inboxRef).catch(() => {});
    await this._register();
    this.joined = true;

    this._unsubs.push(onValue(ref(db, ".info/serverTimeOffset"), s => { this.offset = s.val() || 0; }));
    this._unsubs.push(onValue(ref(db, ".info/connected"), s => {
      const online = !!s.val();
      if (online && this._wasOnline === false) this._rearm();
      if (this._wasOnline !== online) this.onConnection(online);
      this._wasOnline = online;
    }));
    this._unsubs.push(onValue(this._startRef, snap => {
      const v = snap.val();
      this.startedAt = typeof v === "number" ? v : null;
      if (this._seenSessions) this.onSessions(this._live);        // let the UI re-read the call start
    }));
    this._unsubs.push(onValue(ref(db, `${this.base}/sessions`), snap => this._sessionsChanged(snap.val() || {})));
    this._unsubs.push(onChildAdded(this.inboxRef, snap => {
      const msg = snap.val();
      remove(snap.ref).catch(() => {});
      if (msg && typeof msg.from === "string") this.onSignal(msg);
    }));
    this._hb = setInterval(() => {
      update(this.sessionRef, { lastSeen: serverTimestamp() }).catch(() => {});
    }, HEARTBEAT_MS);
  }

  async _register() {
    // Arm the server-side cleanup first so a crash right after the write can't leave a zombie.
    await onDisconnect(this.sessionRef).remove();
    await onDisconnect(this.inboxRef).remove();
    await set(this.sessionRef, {
      ...this.state,
      links: this.links,
      joinedAt: serverTimestamp(),
      lastSeen: serverTimestamp()
    });
  }

  // onDisconnect handlers are one-shot; after a reconnect the old ones were consumed.
  async _rearm() {
    try {
      await onDisconnect(this.sessionRef).remove();
      await onDisconnect(this.inboxRef).remove();
      await update(this.sessionRef, { lastSeen: serverTimestamp() });
    } catch (err) { this.log("rearm failed", err); }
  }

  async _sessionsChanged(all) {
    const live = {};
    const cutoff = this.now() - STALE_MS;
    for (const [sid, s] of Object.entries(all)) {
      if (!s || typeof s.uid !== "string") continue;
      if (typeof s.lastSeen === "number" && s.lastSeen < cutoff && sid !== this.sessionId) {
        remove(ref(db, `${this.base}/sessions/${sid}`)).catch(() => {}); // anyone may clear a dead session
        continue;
      }
      live[sid] = s;
    }

    if (live[this.sessionId]) {
      this._seenSelf = true;
    } else if (this._seenSelf && this.joined && !this._healing) {
      // The server dropped us (e.g. onDisconnect ran after a network blip). Rejoin as a fresh participant.
      this._healing = true;
      this.log("own session vanished — re-registering");
      try {
        await remove(this.inboxRef).catch(() => {});
        await this._register();
        this.onReset();
      } catch (err) {
        this.log("re-register failed", err);
      } finally { this._healing = false; }
      return;
    }
    this._live = live;
    this._seenSessions = true;
    this._claimStart(live);
    this.onSessions(live);
  }

  // The call's start time lives in calls/{chat}/startedAt so it survives people leaving. The first person into an empty
  // room (re)sets it, which also discards a stale value left behind by a call that ended without cleanup.
  _claimStart(live) {
    if (this._startChecked || !live[this.sessionId]) return;
    this._startChecked = true;
    const others = Object.entries(live).filter(([sid]) => sid !== this.sessionId);
    if (!others.length) set(this._startRef, this.now()).catch(() => {});
    else if (this.startedAt === null) {
      const first = Math.min(...others.map(([, x]) => typeof x.joinedAt === "number" ? x.joinedAt : Infinity), live[this.sessionId].joinedAt ?? Infinity);
      if (isFinite(first)) set(this._startRef, first).catch(() => {});
    }
  }

  async leave() {
    if (!this.joined) return;
    this.joined = false;
    clearInterval(this._hb);
    this._unsubs.forEach(fn => { try { fn(); } catch (_) { /* ignore */ } });
    this._unsubs = [];
    try { await onDisconnect(this.sessionRef).cancel(); } catch (_) { /* ignore */ }
    try { await onDisconnect(this.inboxRef).cancel(); } catch (_) { /* ignore */ }
    const lastOut = !Object.keys(this._live || {}).some(sid => sid !== this.sessionId);
    await Promise.allSettled([remove(this.sessionRef), remove(this.inboxRef), ...(lastOut ? [remove(this._startRef)] : [])]);
  }

  /** Best-effort synchronous teardown for pagehide/unload (onDisconnect covers the rest). */
  dispose() {
    if (!this.joined) return;
    this.joined = false;
    clearInterval(this._hb);
    remove(this.sessionRef).catch(() => {});
    remove(this.inboxRef).catch(() => {});
  }

  // ------------------------------------------------------------------ published state
  /** Merge media state (audio / video / screen / screenStream …) into our session. */
  updateState(patch) {
    Object.assign(this.state, patch);
    for (const k of Object.keys(patch)) if (patch[k] === null) delete this.state[k];
    if (!this.joined) return Promise.resolve();
    return update(this.sessionRef, patch).catch(err => this.log("updateState failed", err));
  }

  /** What we think of our connection to one peer session (the peer shows the worse of both views). */
  setLinkState(peerSid, state) {
    if (state === null) delete this.links[peerSid]; else this.links[peerSid] = state;
    if (!this.joined) return Promise.resolve();
    const r = ref(db, `${this.base}/sessions/${this.sessionId}/links/${peerSid}`);
    return (state === null ? remove(r) : set(r, state)).catch(() => {});
  }

  // ------------------------------------------------------------------ signalling
  send(toUid, toSid, msg) {
    const r = push(ref(db, `${this.base}/inbox/${toUid}/${toSid}`)); // key assigned synchronously => ordered
    return set(r, { from: this.sessionId, t: msg.t, epoch: msg.epoch, d: msg.d ?? null })
      .catch(err => this.log("signal send failed", err));
  }
}
