#!/usr/bin/env python3
"""A bot that joins QuickMessage calls with voice and video (WebRTC through aiortc).

    pip install aiortc requests
    python3 qmcall.py --db https://YOUR-PROJECT-default-rtdb.firebaseio.com --token qmbot.bot_xxx.yyyy [--audio music.mp3] [--video clip.mp4] [--record heard.wav]

What it does: waits until someone calls it (or a call is already running in a chat it belongs to), joins as one more participant, plays
--audio / --video (a file; otherwise silence and no picture) to everybody and, with --record, records what the others say. Use it as a
starting point: replace `Bot.on_audio_track` / the players with your own (a voice assistant, a music bot, a recorder...).

The worker (worker/qm_worker.py) must be running: it does the call bookkeeping through the bot API routes (callJoin, callSessions,
callSignals, callSignal, callState, callLeave in docs/BOTS.md). Calls in end-to-end encrypted chats can't include bots.
Signalling follows js/call/mesh.js (the same "perfect negotiation" the web page uses); media is plain WebRTC.
"""
import argparse, asyncio, json, sys, time
from aiortc import RTCPeerConnection, RTCSessionDescription, RTCConfiguration, RTCIceServer
from aiortc.contrib.media import MediaPlayer, MediaRecorder
from aiortc.sdp import candidate_from_sdp
from qmbot import QMBot

ICE = RTCConfiguration([RTCIceServer("stun:stun.l.google.com:19302")])


class Peer:
    """One connection to one other session (a device in the call)."""
    def __init__(self, bot, peer, epoch=1):
        self.bot, self.peer, self.epoch = bot, peer, epoch
        self.polite = bot.sid > peer["sid"]               # same rule as the page: the higher session id yields in a collision
        self.pc = None; self.making = False; self.recorder = None

    async def start(self):
        pc = self.pc = RTCPeerConnection(ICE)
        for tr in self.bot.tracks(): pc.addTrack(tr)
        @pc.on("track")
        def on_track(track): self.bot.on_track(self, track)
        @pc.on("connectionstatechange")
        async def _():
            if pc.connectionState == "failed": await self.restart()
        await self.offer()

    async def offer(self):
        pc = self.pc
        self.making = True
        try:
            await pc.setLocalDescription(await pc.createOffer())
            self.send("desc", {"type": pc.localDescription.type, "sdp": pc.localDescription.sdp})
        finally: self.making = False

    async def restart(self):
        await self.close(); self.epoch += 1; await self.start()

    def send(self, t, d):
        self.bot.api(lambda: self.bot.qm.call_signal(self.bot.chat, self.bot.sid, self.peer["uid"], self.peer["sid"], t, d, self.epoch))

    async def handle(self, m):
        ep = int(m.get("epoch") or 1)
        if ep < self.epoch: return
        if ep > self.epoch:                                # the other side rebuilt its connection: so do we, then answer
            await self.close(); self.epoch = ep; await self.start_passive()
        pc = self.pc
        if m["t"] == "desc":
            d = m["d"]
            collision = d["type"] == "offer" and (self.making or pc.signalingState != "stable")
            if collision and not self.polite: return       # impolite: our offer wins
            if collision:                                  # polite: give way (aiortc has no rollback, so start over and answer)
                await self.close(); await self.start_passive(); pc = self.pc
            await pc.setRemoteDescription(RTCSessionDescription(d["sdp"], d["type"]))
            if d["type"] == "offer":
                await pc.setLocalDescription(await pc.createAnswer())
                self.send("desc", {"type": pc.localDescription.type, "sdp": pc.localDescription.sdp})
        elif m["t"] == "cand" and m.get("d") and pc.remoteDescription:
            c = m["d"]
            try:
                cand = candidate_from_sdp(c["candidate"].split(":", 1)[1]); cand.sdpMid = c.get("sdpMid"); cand.sdpMLineIndex = c.get("sdpMLineIndex")
                await pc.addIceCandidate(cand)
            except Exception: pass                          # aiortc gathers candidates inside the SDP; stray ones don't matter

    async def start_passive(self):
        pc = self.pc = RTCPeerConnection(ICE)
        for tr in self.bot.tracks(): pc.addTrack(tr)
        @pc.on("track")
        def on_track(track): self.bot.on_track(self, track)

    async def close(self):
        if self.pc: await self.pc.close()
        self.pc = None


class Bot:
    def __init__(self, qm, chat, audio=None, video=None, record=None):
        self.qm, self.chat, self.record = qm, chat, record
        self.audio_src, self.video_src = audio, video
        self.sid = None; self.peers = {}; self.players = []; self.recorders = []; self.loop = asyncio.get_event_loop()

    def api(self, fn): return self.loop.run_in_executor(None, fn)          # the bot API is blocking HTTP: keep it off the event loop

    def tracks(self):
        out = []
        for src, opts in ((self.audio_src, {}), (self.video_src, {})):
            if not src: continue
            p = MediaPlayer(src, loop=True); self.players.append(p)
            out += [t for t in (p.audio, p.video) if t]
        return out

    def on_track(self, peer, track):
        """Something arrived from a person: their microphone (audio) or camera (video). Replace this to do something with it."""
        if self.record and track.kind == "audio":
            r = MediaRecorder(self.record); r.addTrack(track); self.recorders.append(r); asyncio.ensure_future(r.start())
        else:
            asyncio.ensure_future(_drain(track))

    async def run(self):
        j = await self.api(lambda: self.qm.call_join(self.chat, audio=bool(self.audio_src), video=bool(self.video_src)))
        self.sid = j["sid"]; print("joined", self.chat, "as session", self.sid)
        try:
            while True:
                sessions = {s["sid"]: s for s in await self.api(lambda: self.qm.call_sessions(self.chat))}
                for sid, s in sessions.items():
                    if sid not in self.peers:
                        self.peers[sid] = Peer(self, s)
                        await self.peers[sid].start()                  # whoever sees the other first offers; collisions resolve themselves
                for sid in [x for x in self.peers if x not in sessions]: await self.peers.pop(sid).close()
                for m in await self.api(lambda: self.qm.call_signals(self.chat, self.sid)):
                    p = self.peers.get(m.get("from"))
                    if p: await p.handle(m)
                await asyncio.sleep(0.7)
        finally:
            for p in self.peers.values(): await p.close()
            for r in self.recorders: await r.stop()
            await self.api(lambda: self.qm.call_leave(self.chat, self.sid))


async def _drain(track):
    try:
        while True: await track.recv()
    except Exception: pass


async def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--db", required=True); ap.add_argument("--token", required=True)
    ap.add_argument("--chat"); ap.add_argument("--audio"); ap.add_argument("--video"); ap.add_argument("--record")
    a = ap.parse_args(); qm = QMBot(a.token, db_url=a.db)
    if a.chat:
        await Bot(qm, a.chat, a.audio, a.video, a.record).run(); return
    print("waiting for a call (event feed)…"); after = qm.latest_event_key()
    while True:                                            # the worker writes {event:"call"} into the feed when someone rings this bot
        for key, ev in await asyncio.get_event_loop().run_in_executor(None, lambda: qm.events(after)):
            after = key
            if ev.get("event") == "call":
                try: await asyncio.wait_for(Bot(qm, ev["chat"], a.audio, a.video, a.record).run(), 3600)
                except asyncio.TimeoutError: pass
        await asyncio.sleep(2)

if __name__ == "__main__":
    try: asyncio.run(main())
    except KeyboardInterrupt: sys.exit(0)
