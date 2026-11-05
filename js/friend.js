// Friend codes: how people add each other to a chat now (instead of pasting a UID).
//
//   friend/{uid}        { code, on, public }   only you can read or change it
//   friendCodes/{code}  uid                    the lookup table. It only exists while the code is switched on. Nobody can list it; you can only
//                                              ask for one code you already know.
//   friendPub/{uid}     code                   only while the code is on AND public: it lets people who share a chat with you copy it
//
// Looks like  QM-K7R2D-9WBX4. It is random (about 47 bits), uses another alphabet and another shape than the encryption RECOVERY CODE
// (which is 5 groups of 4 letters and numbers), so the two can never be mixed up, and it is never derived from your UID or your recovery code.
import { db } from "./firebase.js";
import { ref, get, update } from "./sdk.js";

const FA = "BCDFGHJKMNPQRSTVWXZ23456789";                 // no vowels, no look-alikes (0/O, 1/I/L)
export const FRIEND_RE = /^QM-[BCDFGHJKMNPQRSTVWXZ2-9]{5}-[BCDFGHJKMNPQRSTVWXZ2-9]{5}$/;

export function makeCode() {
  const out = [];
  const lim = 256 - (256 % FA.length);                    // throw away values that would make some letters likelier than others
  while (out.length < 10) {
    const r = crypto.getRandomValues(new Uint8Array(16));
    for (const x of r) { if (x < lim && out.length < 10) out.push(FA[x % FA.length]); }
  }
  return "QM-" + out.slice(0, 5).join("") + "-" + out.slice(5).join("");
}

/** What a person typed (any case, with or without dashes or the QM prefix) -> "QM-XXXXX-XXXXX", or "" when it can't be a friend code. */
export function normalizeCode(input) {
  let s = String(input || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s.startsWith("QM")) s = s.slice(2);
  if (s.length !== 10) return "";
  const c = "QM-" + s.slice(0, 5) + "-" + s.slice(5);
  return FRIEND_RE.test(c) ? c : "";
}

const pubCache = new Map();                                // uid -> code | null

const clean = f => (f && typeof f === "object" && FRIEND_RE.test(String(f.code))) ? { code: f.code, on: f.on !== false, public: f.public !== false } : null;
const pathsFor = (uid, code, on, pub) => ({
  [`friendCodes/${code}`]: on ? uid : null,
  [`friendPub/${uid}`]: on && pub ? code : null
});

/** Your own friend code settings; makes a code the first time (public and on by default). Throws if the database refuses. */
export async function ensureFriend(uid) {
  const cur = clean((await get(ref(db, `friend/${uid}`))).val());
  if (cur) {
    // repair the lookup if it went missing or points elsewhere (an old half-finished change)
    if (cur.on) {
      const owner = (await get(ref(db, `friendCodes/${cur.code}`)).catch(() => null))?.val();
      if (owner !== uid && !owner) await update(ref(db), pathsFor(uid, cur.code, true, cur.public)).catch(() => {});
    }
    return cur;
  }
  for (let i = 0; i < 6; i++) {
    const code = makeCode();
    if ((await get(ref(db, `friendCodes/${code}`))).exists()) continue;
    const f = { code, on: true, public: true };
    await update(ref(db), { [`friend/${uid}`]: f, ...pathsFor(uid, code, true, true) });
    pubCache.delete(uid);
    return f;
  }
  throw new Error("Couldn't make a friend code. Try again.");
}

export async function setFriendOn(uid, on) {
  const f = await ensureFriend(uid);
  await update(ref(db), { [`friend/${uid}/on`]: !!on, ...pathsFor(uid, f.code, !!on, f.public) });
  pubCache.delete(uid);
  return { ...f, on: !!on };
}

export async function setFriendPublic(uid, pub) {
  const f = await ensureFriend(uid);
  await update(ref(db), { [`friend/${uid}/public`]: !!pub, [`friendPub/${uid}`]: f.on && pub ? f.code : null });
  pubCache.delete(uid);
  return { ...f, public: !!pub };
}

/** A completely new code. The old one stops working at once. Keeps your on / public choices. */
export async function regenerateFriend(uid) {
  const f = await ensureFriend(uid);
  for (let i = 0; i < 6; i++) {
    const code = makeCode();
    if ((await get(ref(db, `friendCodes/${code}`))).exists()) continue;
    await update(ref(db), { [`friend/${uid}/code`]: code, [`friendCodes/${f.code}`]: null, ...pathsFor(uid, code, f.on, f.public) });
    pubCache.delete(uid);
    return { ...f, code };
  }
  throw new Error("Couldn't make a friend code. Try again.");
}

/** code -> uid, or null (no such code, or its owner turned it off). */
export async function resolveFriendCode(code) {
  const c = normalizeCode(code); if (!c) return null;
  const v = (await get(ref(db, `friendCodes/${c}`))).val();
  return typeof v === "string" && v ? v : null;
}

/** Somebody else's code, but only if they made it public (and it is on). Used for the copy button in the member list. */
export async function publicCodeOf(uid) {
  if (pubCache.has(uid)) return pubCache.get(uid);
  let c = null;
  try { const v = (await get(ref(db, `friendPub/${uid}`))).val(); c = FRIEND_RE.test(String(v)) ? v : null; } catch (_) { c = null; }
  pubCache.set(uid, c);
  return c;
}

/** Everything to delete with the account. */
export async function friendDeletePaths(uid) {
  const f = clean((await get(ref(db, `friend/${uid}`)).catch(() => null))?.val());
  const o = { [`friend/${uid}`]: null, [`friendPub/${uid}`]: null };
  if (f) o[`friendCodes/${f.code}`] = null;
  return o;
}
