// Ringing: calls/{chatId}/ringing/{uid} = { ringId, fromUid, createdAt, notifyStatus }
// Rings are per *account*: every device of that account that has the call page open sees the prompt, and the
// first one to answer clears it for the rest. Kept separate from CallRoom so the lobby can receive rings too.
import { db } from "../firebase.js";
import { ref, get, set, update, remove, onValue, serverTimestamp } from "../sdk.js";
import { newId } from "./signal.js";

export const RING_TTL_MS = 60000;
let offset;
const serverOffset = () => (offset ||= get(ref(db, ".info/serverTimeOffset")).then(s => s.val() || 0).catch(() => 0));
const ringRef = (chatId, uid) => ref(db, `calls/${chatId}/ringing/${uid}`);

export function watchRing(chatId, uid, cb) {
  return onValue(ringRef(chatId, uid), async snap => {
    const ring = snap.val();
    if (!ring) return cb(null);
    const off = await serverOffset();
    if (typeof ring.createdAt === "number" && Date.now() + off - ring.createdAt > RING_TTL_MS) return cb(null);
    cb(ring);
  });
}

export async function startRing(chatId, fromUid, targetUid) {
  const ringId = newId();
  // Two copies: per chat (the call page) and per user (live/{uid}/rings/{chatId} — lets the app shell ring
  // whatever page they're on without knowing which chat to watch).
  await update(ref(db), {
    [`calls/${chatId}/ringing/${targetUid}`]: { ringId, fromUid, createdAt: serverTimestamp(), notifyStatus: "sending" },
    [`live/${targetUid}/rings/${chatId}`]: { ringId, fromUid, chatId, createdAt: serverTimestamp() }
  });
  return ringId;
}

export const setRingStatus = (chatId, targetUid, status) =>
  update(ringRef(chatId, targetUid), { notifyStatus: status }).catch(() => {});

/** Remove a ring; with onlyRingId, only if it's still that exact ring (so we never clear a newer one). */
export async function clearRing(chatId, targetUid, onlyRingId) {
  try {
    const r = ringRef(chatId, targetUid);
    if (onlyRingId) {
      const s = await get(r);
      if (s.val()?.ringId !== onlyRingId) return;
    }
    await update(ref(db), { [`calls/${chatId}/ringing/${targetUid}`]: null, [`live/${targetUid}/rings/${chatId}`]: null });
  } catch (_) { /* best effort */ }
}

/** Declining: tell the caller (live/{caller}/declines/{chat}, which pops up a notice and shows it on their call page), then clear the ring. */
export async function declineRing(chatId, myUid, ring) {
  const from = ring && ring.fromUid;
  if (from && from !== myUid) {
    try { await update(ref(db), { [`live/${from}/declines/${chatId}`]: { by: myUid, chatId, ts: Date.now() } }); } catch (_) { /* best effort */ }
  }
  await clearRing(chatId, myUid, ring && ring.ringId);
}
