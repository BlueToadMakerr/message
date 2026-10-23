import { devCard, devGrid, devPill, devBar, devWho, devSection, devHistRow, devLoop, rateSelect, devRate } from "../dev.js";
import { getProfile } from "../users.js";
// Developer mode: a floating panel with live call statistics (WebRTC getStats) and the raw call state. Opened by the small { } button in the call.
const prev = new Map();            // "linkId|ssrc|dir" -> { t, bytes, frames }
const round = (v, d = 1) => (typeof v === "number" && isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : v);

async function linkStats(sid, link, S) {
  const pc = link.pc;
  if (!pc) return { note: "no peer connection right now" };
  let rep; try { rep = await pc.getStats(); } catch (e) { return { error: String(e) }; }
  const by = {}; rep.forEach(r => { by[r.id] = r; });
  const now = performance.now();
  // which of my slots (mic / cam / screen / screenAudio) a local track belongs to, and which remote stream (= which kind of source) a received track came from
  const slotOfTrack = {}; for (const [name, sl] of Object.entries(link.slots || {})) if (sl.sender && sl.sender.track) slotOfTrack[sl.sender.track.id] = name;
  const remote = S.remote && S.remote.get(sid), ses = (S.sessions || {})[sid] || {};
  const srcOfRemote = (trackId, kind) => {
    let sid2 = null;
    if (remote) for (const [streamId, st] of remote.streams) if (st.getTracks().some(t => t.id === trackId)) sid2 = streamId;
    const screen = sid2 && sid2 === ses.screenStream;
    return kind === "audio" ? (screen ? "screenAudio" : "mic") : (screen ? "screen" : "cam");
  };
  const rate = (key, bytes, frames) => {
    const p = prev.get(key); prev.set(key, { t: now, bytes, frames });
    if (!p || now <= p.t) return {};
    return { kbps: round(((bytes - p.bytes) * 8) / (now - p.t)), fpsMeasured: frames == null || p.frames == null ? undefined : round(((frames - p.frames) * 1000) / (now - p.t)) };
  };
  const out = { connection: pc.connectionState, ice: pc.iceConnectionState, gathering: pc.iceGatheringState, signaling: pc.signalingState, linkState: link.state, epoch: link.epoch, iceRestarts: link._iceRestarts, resets: link._resets, outbound: [], inbound: [] };
  let pair = null, transport = null;
  rep.forEach(r => { if (r.type === "transport") { transport = r; if (r.selectedCandidatePairId) pair = by[r.selectedCandidatePairId] || pair; } });
  if (!pair) rep.forEach(r => { if (r.type === "candidate-pair" && (r.nominated || r.selected) && r.state === "succeeded") pair = r; });
  if (pair) {
    const cand = c => c && { type: c.candidateType, protocol: c.protocol, network: c.networkType, address: c.address || c.ip, port: c.port, relayProtocol: c.relayProtocol, priority: c.priority };
    out.path = { local: cand(by[pair.localCandidateId]), remote: cand(by[pair.remoteCandidateId]), rttMs: round((pair.currentRoundTripTime || 0) * 1000), avgRttMs: pair.responsesReceived ? round((pair.totalRoundTripTime / pair.responsesReceived) * 1000) : undefined, availableOutKbps: round((pair.availableOutgoingBitrate || 0) / 1000), availableInKbps: round((pair.availableIncomingBitrate || 0) / 1000), bytesSent: pair.bytesSent, bytesReceived: pair.bytesReceived, requestsSent: pair.requestsSent, responsesReceived: pair.responsesReceived, consentRequests: pair.consentRequestsSent, packetsDiscardedOnSend: pair.packetsDiscardedOnSend, nominated: pair.nominated, state: pair.state };
  }
  if (transport) out.transport = { dtls: transport.dtlsState, ice: transport.iceState, role: transport.dtlsRole || transport.iceRole, tls: transport.tlsVersion, cipher: transport.dtlsCipher, srtp: transport.srtpCipher, bytesSent: transport.bytesSent, bytesReceived: transport.bytesReceived, selectedPairChanges: transport.selectedCandidatePairChanges };
  try { const c = pc.getConfiguration(); out.config = { iceTransportPolicy: c.iceTransportPolicy, bundlePolicy: c.bundlePolicy, iceServers: (c.iceServers || []).map(s => ({ urls: s.urls })) }; } catch (_) { /* ignore */ }
  const avg = (sum, n, mult = 1000) => (n ? round((sum / n) * mult) : undefined);
  rep.forEach(r => {
    const codec = r.codecId && by[r.codecId] ? by[r.codecId].mimeType : undefined;
    if (r.type === "outbound-rtp" && !r.isRemote) {
      const msrc = r.mediaSourceId && by[r.mediaSourceId], tid = msrc && msrc.trackIdentifier;
      const src = (tid && slotOfTrack[tid]) || (r.kind === "audio" ? "mic" : r.contentType === "screenshare" ? "screen" : "cam");
      out.outbound.push({ src, kind: r.kind, ssrc: r.ssrc, rid: r.rid, active: r.active, content: r.contentType, codec, ...rate(`${sid}|${r.ssrc}|o`, r.bytesSent || 0, r.framesEncoded), fps: r.framesPerSecond, size: r.frameWidth ? `${r.frameWidth}×${r.frameHeight}` : undefined, srcFps: msrc && msrc.framesPerSecond, srcSize: msrc && msrc.width ? `${msrc.width}×${msrc.height}` : undefined, framesEncoded: r.framesEncoded, framesSent: r.framesSent, hugeFramesSent: r.hugeFramesSent, keyFramesEncoded: r.keyFramesEncoded, targetKbps: r.targetBitrate ? round(r.targetBitrate / 1000) : undefined, limited: r.qualityLimitationReason, limitDurations: r.qualityLimitationDurations, limitChanges: r.qualityLimitationResolutionChanges, encoder: r.encoderImplementation, encodeMs: avg(r.totalEncodeTime, r.framesEncoded), qp: r.framesEncoded && r.qpSum ? round(r.qpSum / r.framesEncoded) : undefined, nack: r.nackCount, pli: r.pliCount, fir: r.firCount, retransmittedBytes: r.retransmittedBytesSent, packetsSent: r.packetsSent, headerBytes: r.headerBytesSent, audioLevel: msrc && msrc.audioLevel });
    } else if (r.type === "inbound-rtp" && !r.isRemote) {
      const src = srcOfRemote(r.trackIdentifier, r.kind);
      out.inbound.push({ src, kind: r.kind, ssrc: r.ssrc, codec, ...rate(`${sid}|${r.ssrc}|i`, r.bytesReceived || 0, r.framesDecoded), fps: r.framesPerSecond, size: r.frameWidth ? `${r.frameWidth}×${r.frameHeight}` : undefined, framesReceived: r.framesReceived, framesDecoded: r.framesDecoded, framesDropped: r.framesDropped, keyFramesDecoded: r.keyFramesDecoded, packetsLost: r.packetsLost, packetsReceived: r.packetsReceived, packetsDiscarded: r.packetsDiscarded, jitterMs: round((r.jitter || 0) * 1000), jitterBufferMs: avg(r.jitterBufferDelay, r.jitterBufferEmittedCount), freezes: r.freezeCount, freezeSec: round(r.totalFreezesDuration || 0), pauses: r.pauseCount, decoder: r.decoderImplementation, decodeMs: avg(r.totalDecodeTime, r.framesDecoded), qp: r.framesDecoded && r.qpSum ? round(r.qpSum / r.framesDecoded) : undefined, audioLevel: r.audioLevel, concealedSamples: r.concealedSamples, totalSamples: r.totalSamplesReceived, concealmentEvents: r.concealmentEvents, insertedSamples: r.insertedSamplesForDeceleration, removedSamples: r.removedSamplesForAcceleration, nack: r.nackCount, pli: r.pliCount, fir: r.firCount, fecPackets: r.fecPacketsReceived });
    }
  });
  return out;
}

const trackInfo = t => t && { id: t.id, kind: t.kind, label: t.label, state: t.readyState, enabled: t.enabled, muted: t.muted, hint: t.contentHint || undefined, settings: (() => { try { return t.getSettings(); } catch (_) { return null; } })() };

export async function callSnapshot(S) {
  const links = {};
  await Promise.all([...S.links].map(async ([sid, link]) => { links[sid] = await linkStats(sid, link, S); }));
  const m = S.media;
  const sum = l => `${l.connection} ` + (l.path ? `${l.path.local && l.path.local.type}→${l.path.remote && l.path.remote.type} ${l.path.rttMs}ms` : "");
  return {
    time: new Date().toISOString(), chatId: S.chatId, me: S.me, mySession: S.room && (S.room.sessionId || S.room.sid), joined: S.joined, online: S.online, deafened: !!S.deafened,
    summary: Object.fromEntries(Object.entries(links).map(([sid, l]) => [sid.slice(0, 6), [sum(l), ...(l.outbound || []).map(o => `↑${o.src} ${o.kbps ?? "?"}kbps${o.fps != null ? " " + o.fps + "fps" : ""}${o.size ? " " + o.size : ""}${o.limited && o.limited !== "none" ? " (limited: " + o.limited + ")" : ""}`), ...(l.inbound || []).map(i => `↓${i.src} ${i.kbps ?? "?"}kbps${i.fps != null ? " " + i.fps + "fps" : ""}${i.size ? " " + i.size : ""} lost ${i.packetsLost ?? 0}`)].filter(Boolean).join(" | ")])),
    local: m && { micOn: m.micOn, camOn: m.camOn, canScreen: m.canScreen, screenSharing: !!m.screen, deafened: !!S.deafened, micSource: m.micSource, camSource: m.camSource, micError: m.micError, camError: m.camError, cameraCount: m.cameraCount, mic: trackInfo(m.mic), rawMic: trackInfo(m._rawMic), cam: trackInfo(m.cam), screen: m.screen ? { video: trackInfo(m.screen.video), audio: trackInfo(m.screen.audio) } : null },
    sessions: S.sessions, links
  };
}

const dropPrev = new Map();        // "key" -> { t, v }: per-second change of a counter
const perSec = (key, v) => {
  if (typeof v !== "number") return 0;
  const now = performance.now(), p = dropPrev.get(key); dropPrev.set(key, { t: now, v });
  return p && now > p.t ? Math.max(0, ((v - p.v) * 1000) / (now - p.t)) : 0;
};
const tone = (v, good, bad) => (v == null ? "" : v <= good ? "ok" : v <= bad ? "warn" : "bad");
const kb = v => (v == null ? "?" : v >= 1000 ? (v / 1000).toFixed(2) + " Mbps" : Math.round(v) + " kbps");
const SRC = [["mic", "Microphone"], ["cam", "Camera"], ["screen", "Screen share"], ["screenAudio", "Screen share audio"]];
const settings = t => (t && t.settings) || {};
const dims = st => (st.width ? `${st.width}×${st.height}` : "");

/** rows for what one remote source sends us (↓) */
function inRows(k, i, sid) {
  const key = `${sid}|${k}|in|`, r = [];
  const lostPs = perSec(key + "lost", i.packetsLost), recvPs = perSec(key + "recv", i.packetsReceived);
  const lossPct = lostPs + recvPs > 0 ? (lostPs / (lostPs + recvPs)) * 100 : 0;
  r.push(devHistRow("↓ Bitrate", key + "kbps", i.kbps, { text: kb(i.kbps) }));
  if (i.kind === "video") {
    r.push(devHistRow("↓ Frame rate", key + "fps", i.fps, { unit: " fps", tone: i.fps != null && i.fps < 10 ? "warn" : "" }));
    r.push(["↓ Size", i.size]);
    const dps = perSec(key + "drop", i.framesDropped);
    r.push(devHistRow("↓ Dropped frames / s", key + "dps", dps, { unit: "/s", tone: dps > 1 ? "bad" : dps > 0 ? "warn" : "" }));
    r.push(["↓ Dropped frames (total)", `${i.framesDropped ?? 0} of ${i.framesReceived ?? i.framesDecoded ?? 0}`, (i.framesDropped || 0) > 0 ? "warn" : ""]);
    r.push(["↓ Frames decoded / key frames", `${i.framesDecoded ?? 0} / ${i.keyFramesDecoded ?? 0}`]);
    r.push(["↓ Freezes", i.freezes != null ? `${i.freezes} (${i.freezeSec ?? 0} s frozen)` : "", i.freezes > 0 ? "warn" : ""]);
    r.push(["↓ Pauses", i.pauses]);
    r.push(devHistRow("↓ Decode time", key + "dec", i.decodeMs, { unit: " ms", digits: 2 }));
    r.push(["↓ Avg QP", i.qp]);
    r.push(["↓ Decoder", [i.codec, i.decoder].filter(Boolean).join(" · ")]);
  } else {
    r.push(["↓ Codec", i.codec]);
    r.push(devHistRow("↓ Audio level", key + "lvl", i.audioLevel, { digits: 3 }));
    r.push(["↓ Concealed samples", i.totalSamples ? `${i.concealedSamples ?? 0} (${Math.round(((i.concealedSamples || 0) / i.totalSamples) * 1000) / 10}%)` : "", (i.concealedSamples || 0) > 0 ? "warn" : ""]);
    r.push(["↓ Concealment events", i.concealmentEvents]);
    r.push(["↓ Sped up / slowed down", i.removedSamples != null ? `${i.removedSamples} / ${i.insertedSamples}` : ""]);
  }
  r.push(devHistRow("↓ Packet loss", key + "loss", lossPct, { unit: " %", tone: tone(lossPct, 1, 5) }));
  r.push(["↓ Packets lost / received", `${i.packetsLost ?? 0} / ${i.packetsReceived ?? 0}`]);
  r.push(["↓ Discarded packets", i.packetsDiscarded, i.packetsDiscarded > 0 ? "warn" : ""]);
  r.push(devHistRow("↓ Jitter", key + "jit", i.jitterMs, { unit: " ms", tone: tone(i.jitterMs, 20, 60) }));
  r.push(devHistRow("↓ Jitter buffer delay", key + "jb", i.jitterBufferMs, { unit: " ms" }));
  r.push(["↓ NACK / PLI / FIR", `${i.nack ?? 0} / ${i.pli ?? 0} / ${i.fir ?? 0}`]);
  r.push(["↓ FEC packets", i.fecPackets]);
  return r;
}
/** rows for what we send to one person (↑) */
function outRows(k, o, sid) {
  const key = `${sid}|${k}|out|`, r = [];
  r.push(devHistRow("↑ Bitrate", key + "kbps", o.kbps, { text: kb(o.kbps) }));
  if (o.kind === "video") {
    r.push(devHistRow("↑ Frame rate", key + "fps", o.fps, { unit: " fps" }));
    r.push(["↑ Size", o.size]);
    r.push(["↑ Capture (before encoding)", [o.srcSize, o.srcFps != null ? o.srcFps + " fps" : ""].filter(Boolean).join(" @ ")]);
    r.push(devHistRow("↑ Target bitrate", key + "tgt", o.targetKbps, { text: kb(o.targetKbps) }));
    r.push(["↑ Limited by", o.limited && o.limited !== "none" ? devPill(o.limited, "warn") : o.limited ? devPill("nothing", "ok") : ""]);
    if (o.limitDurations) r.push(["↑ Time limited (cpu / bandwidth)", `${Math.round(o.limitDurations.cpu || 0)} s / ${Math.round(o.limitDurations.bandwidth || 0)} s`]);
    r.push(["↑ Resolution changes", o.limitChanges]);
    r.push(devHistRow("↑ Encode time", key + "enc", o.encodeMs, { unit: " ms", digits: 2 }));
    r.push(["↑ Frames encoded / sent / key", `${o.framesEncoded ?? 0} / ${o.framesSent ?? 0} / ${o.keyFramesEncoded ?? 0}`]);
    r.push(["↑ Huge frames", o.hugeFramesSent]);
    r.push(["↑ Avg QP", o.qp]);
    r.push(["↑ Encoder", [o.codec, o.encoder].filter(Boolean).join(" · ")]);
  } else {
    r.push(["↑ Codec", o.codec]);
    r.push(devHistRow("↑ Audio level", key + "lvl", o.audioLevel, { digits: 3 }));
  }
  r.push(["↑ Packets sent", o.packetsSent]);
  r.push(["↑ NACK / PLI / FIR", `${o.nack ?? 0} / ${o.pli ?? 0} / ${o.fir ?? 0}`]);
  r.push(["↑ Retransmitted", o.retransmittedBytes != null ? Math.round(o.retransmittedBytes / 1024) + " KB" : ""]);
  r.push(["↑ Active", o.active === false ? devPill("paused", "warn") : ""]);
  return r;
}

/** Visual view: a card per person (like a voice-connection panel) with connection, then each of their sources separately (mic, camera, screen, screen audio), plus a card for this device. */
export async function visualCall(S, snap) {
  const cards = [], m = snap.local || {};
  const prof = await getProfile(S.me).catch(() => null);
  const outsAll = Object.values(snap.links).flatMap(l => l.outbound || []);
  const sumOut = src => { const a = outsAll.filter(o => o.src === src); return a.length ? { n: a.length, kbps: a.reduce((x, o) => x + (o.kbps || 0), 0), fps: Math.max(...a.map(o => o.fps || 0)) } : null; };
  const me = [];
  const mic = m.mic, raw = m.rawMic, ms = settings(raw || mic);
  me.push(devSection("Microphone"));
  me.push(["State", mic ? devPill(m.micOn ? "on" : "muted", m.micOn ? "ok" : "warn") : devPill(m.micError || "none", "bad")]);
  me.push(["Source", m.micSource === "phone" ? "phone" : "this device"], ["Device", (raw || mic) && (raw || mic).label], ["Sample rate / channels", ms.sampleRate ? `${ms.sampleRate} Hz · ${ms.channelCount ?? "?"} ch` : ""]);
  me.push(["Echo cancel / noise / auto gain", ms.echoCancellation != null ? `${ms.echoCancellation} / ${ms.noiseSuppression} / ${ms.autoGainControl}` : ""], ["Latency", ms.latency != null ? Math.round(ms.latency * 1000) + " ms" : ""]);
  me.push(["Mic volume setting", raw && mic && raw.id !== mic.id ? devPill("gain stage active", "info") : "100% (direct)"]);
  const so = sumOut("mic"); if (so) me.push(devHistRow("↑ Sending (all links)", "me|mic|kbps", so.kbps, { text: kb(so.kbps) }));
  me.push(devSection("Camera"));
  me.push(["State", m.cam ? devPill("on", "ok") : devPill(m.camError || "off")], ["Source", m.camSource === "phone" ? "phone" : "this device"], ["Device", m.cam && m.cam.label], ["Cameras found", m.cameraCount]);
  const cs = settings(m.cam);
  me.push(["Capture", m.cam ? `${dims(cs)} @ ${Math.round(cs.frameRate || 0)} fps` : ""], ["Facing", cs.facingMode]);
  const sc = sumOut("cam"); if (sc) { me.push(devHistRow("↑ Frame rate (best link)", "me|cam|fps", sc.fps, { unit: " fps" })); me.push(devHistRow("↑ Sending (all links)", "me|cam|kbps", sc.kbps, { text: kb(sc.kbps) })); }
  me.push(devSection("Screen share"));
  const sv = m.screen && m.screen.video, ss = settings(sv);
  me.push(["State", sv ? devPill("sharing", "info") : devPill(m.canScreen ? "off" : "not available")]);
  if (sv) { me.push(["Capture", `${dims(ss)} @ ${Math.round(ss.frameRate || 0)} fps`], ["Surface", ss.displaySurface], ["Content hint", sv.hint]); }
  const sr = sumOut("screen"); if (sr) { me.push(devHistRow("↑ Frame rate (best link)", "me|screen|fps", sr.fps, { unit: " fps" })); me.push(devHistRow("↑ Sending (all links)", "me|screen|kbps", sr.kbps, { text: kb(sr.kbps) })); }
  me.push(devSection("Screen share audio"));
  const sa = m.screen && m.screen.audio;
  me.push(["State", sa ? devPill("sharing sound", "info") : devPill("none")], ["Device", sa && sa.label]);
  const sra = sumOut("screenAudio"); if (sra) me.push(devHistRow("↑ Sending (all links)", "me|screenAudio|kbps", sra.kbps, { text: kb(sra.kbps) }));
  me.push(devSection("This call"));
  me.push(["Session", String(snap.mySession || "").slice(0, 10)], ["Connections", Object.keys(snap.links).length], ["People (sessions)", Object.keys(snap.sessions || {}).length], ["Online", snap.online === false ? devPill("offline", "bad") : devPill("yes", "ok")], ["Deafened", snap.deafened ? devPill("yes", "warn") : "no"]);
  cards.push(devCard("", me, { head: devWho((prof && prof.displayName) || "You", prof && prof.pfp, "You · this device") }));

  for (const [sid, l] of Object.entries(snap.links)) {
    const ses = (snap.sessions || {})[sid] || {};
    const p = ses.uid ? await getProfile(ses.uid).catch(() => null) : null;
    const pk = `${sid}|link|`, rows = [], rtt = l.path && l.path.rttMs;
    rows.push(devSection("Connection"));
    rows.push(["State", devPill(l.connection || l.note || "?", l.connection === "connected" ? "ok" : l.connection === "failed" ? "bad" : "warn")]);
    rows.push(["ICE / DTLS", [l.ice, l.transport && l.transport.dtls].filter(Boolean).join(" / ")], ["Signalling", l.signaling]);
    rows.push(devHistRow("Ping (RTT)", pk + "rtt", rtt, { unit: " ms", tone: tone(rtt, 80, 200) }));
    if (l.path) {
      const lt = l.path.local && l.path.local.type, rt = l.path.remote && l.path.remote.type, relay = lt === "relay" || rt === "relay";
      rows.push(["Route", `${lt} → ${rt} (${l.path.local && l.path.local.protocol}${l.path.local.relayProtocol ? "/" + l.path.local.relayProtocol : ""})`, relay ? "warn" : ""]);
      rows.push(["Network", [l.path.local && l.path.local.network, l.path.remote && l.path.remote.network].filter(Boolean).join(" ↔ ")]);
      rows.push(["Remote address", l.path.remote && l.path.remote.address ? `${l.path.remote.address}:${l.path.remote.port}` : ""]);
      rows.push(devHistRow("Bandwidth estimate up", pk + "bwu", l.path.availableOutKbps, { text: kb(l.path.availableOutKbps) }));
      rows.push(devHistRow("Bandwidth estimate down", pk + "bwd", l.path.availableInKbps, { text: kb(l.path.availableInKbps) }));
      rows.push(["Avg RTT (whole call)", l.path.avgRttMs != null ? l.path.avgRttMs + " ms" : ""]);
      rows.push(["Data sent / received", `${Math.round((l.path.bytesSent || 0) / 1024)} KB / ${Math.round((l.path.bytesReceived || 0) / 1024)} KB`]);
    }
    if (l.transport) rows.push(["Encryption", [l.transport.tls, l.transport.srtp].filter(Boolean).join(" · ")], ["Route changes", l.transport.selectedPairChanges]);
    rows.push(["ICE restarts / resets", `${l.iceRestarts ?? 0} / ${l.resets ?? 0}`, (l.iceRestarts || l.resets) ? "warn" : ""], ["Epoch", l.epoch]);
    for (const [k, title] of SRC) {
      const ins = (l.inbound || []).filter(i => i.src === k), outs = (l.outbound || []).filter(o => o.src === k);
      if (!ins.length && !outs.length) continue;
      rows.push(devSection(title));
      for (const i of ins) rows.push(...inRows(k, i, sid));
      for (const o of outs) rows.push(...outRows(k, o, sid));
    }
    cards.push(devCard("", rows, { head: devWho((p && p.displayName) || "Someone", p && p.pfp, [ses.device, sid.slice(0, 6)].filter(Boolean).join(" · ")) }));
  }
  if (cards.length === 1) cards.push(devCard("Nobody else yet", [["Waiting", "Stats appear when someone joins"]]));
  return devGrid(cards);
}

let panel = null, stopLoop = null;
export function toggleDevPanel(S, plain) {
  if (panel) { stopLoop && stopLoop(); panel.remove(); panel = null; return; }
  panel = document.createElement("div"); panel.className = "dev-panel";
  panel.innerHTML = `<div class="dev-panel-head"><strong>Call stats</strong><span class="dev-tabs"><button type="button" class="dev-tab on" data-a="vis">Visual</button><button type="button" class="dev-tab" data-a="raw">Raw</button></span><span class="grow"></span><span data-slot="rate"></span><button type="button" class="dev-btn" data-a="copy">Copy</button><button type="button" class="dev-btn" data-a="pause">Pause</button><button type="button" class="dev-btn" data-a="x" aria-label="Close">✕</button></div><div class="dev-pane"></div>`;
  panel.querySelector('[data-slot="rate"]').append(rateSelect());
  document.body.append(panel);
  const pane = panel.querySelector(".dev-pane"); let paused = false, last = "", mode = "vis", down = false;
  pane.addEventListener("pointerdown", () => { down = true; });                      // don't swap the content under a click that is in progress
  addEventListener("pointerup", () => setTimeout(() => { down = false; }, 60), true);
  const tick = async () => {
    if (paused || down) return;
    let snap = null; try { snap = await callSnapshot(S); last = plain(snap); } catch (e) { last = String(e); }
    if (!snap || !panel) return;
    if (mode === "vis") { try { const keep = pane.scrollTop; pane.replaceChildren(await visualCall(S, snap)); pane.scrollTop = keep; } catch (e) { pane.textContent = String(e); } }
    else { const pre = pane.querySelector("pre") || pane.appendChild(Object.assign(document.createElement("pre"), { className: "dev-pre" })); pre.textContent = last; }
  };
  panel.addEventListener("click", async e => {
    const a = e.target && e.target.dataset && e.target.dataset.a;
    if (a === "x") toggleDevPanel(S, plain);
    else if (a === "pause") { paused = !paused; e.target.textContent = paused ? "Resume" : "Pause"; }
    else if (a === "vis" || a === "raw") { mode = a; panel.querySelectorAll(".dev-tab").forEach(b => b.classList.toggle("on", b.dataset.a === a)); pane.replaceChildren(); tick(); }
    else if (a === "copy") { try { await navigator.clipboard.writeText(last); e.target.textContent = "Copied ✓"; setTimeout(() => { e.target.textContent = "Copy"; }, 1200); } catch (_) { /* ignore */ } }
  });
  stopLoop = devLoop(tick);
}
