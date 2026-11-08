// End-to-end encryption for chats.
//
//  * Every user has an identity key pair (ECDH P-256). The public half is published (userKeys/{uid}/pub); the private half lives only
//    in this device's IndexedDB, plus a copy in the database that is encrypted with a random RECOVERY CODE only the user has
//    (userKeys/{uid}/backup). Without the code nobody - including the site's owner - can read that copy.
//  * Every encrypted chat has one random AES-GCM chat key. It is stored in the database once per member, wrapped (encrypted) for that
//    member with an ECDH-derived key (privateChats/{chat}/keys/{uid}). Members unwrap it locally.
//  * Messages, link text, photos and uploaded files are encrypted in the browser with the chat key before they're stored or uploaded.
//    The database and the file host only ever see random-looking bytes.
//
// Nothing here is recoverable server-side: lose the device AND the recovery code and old encrypted chats stay unreadable
// (other members' devices can hand the chat key to a brand-new identity, see ensureMemberKeys()).
import { db } from "./firebase.js";
import { ref, get, set, update } from "./sdk.js";

const subtle = crypto.subtle;
const enc8 = new TextEncoder(), dec8 = new TextDecoder();

// ---------------------------------------------------------------- small helpers
export function b64(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
export const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const rnd = n => crypto.getRandomValues(new Uint8Array(n));
const hex = u8 => Array.from(u8, x => x.toString(16).padStart(2, "0")).join("");
const sha = async s => new Uint8Array(await subtle.digest("SHA-256", enc8.encode(s)));

// IndexedDB key/value store (this device only)
let idbP = null;
const idb = () => idbP ||= new Promise((res, rej) => {
  const r = indexedDB.open("qm-crypto", 1);
  r.onupgradeneeded = () => r.result.createObjectStore("kv");
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
async function kvGet(k) { const d = await idb(); return new Promise((res, rej) => { const q = d.transaction("kv").objectStore("kv").get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }
async function kvSet(k, v) { const d = await idb(); return new Promise((res, rej) => { const t = d.transaction("kv", "readwrite"); t.objectStore("kv").put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); }
const locked = fn => navigator.locks ? navigator.locks.request("qm-identity", fn) : fn();

// ---------------------------------------------------------------- identity
let ident = null;                       // { uid, priv, pub, pubStr, fp }
const listeners = new Set();
export const onIdentity = fn => { listeners.add(fn); return () => listeners.delete(fn); };
let bc = null; try { bc = new BroadcastChannel("qm-crypto"); } catch (_) { /* old browser */ }
/** Other frames of the app are told when this one restores/creates the identity, so they can unlock their chats. */
export const onRemoteIdentity = fn => { if (bc) bc.addEventListener("message", fn); };
const emit = () => { try { bc && bc.postMessage("identity"); } catch (_) { /* ignore */ } listeners.forEach(f => { try { f(); } catch (_) { /* ignore */ } }); };

const pubStr = jwk => jwk.x + "." + jwk.y;
const pubJwk = s => { const [x, y] = s.split("."); return { kty: "EC", crv: "P-256", x, y, ext: true }; };
const importPub = s => subtle.importKey("jwk", pubJwk(s), { name: "ECDH", namedCurve: "P-256" }, true, []);
const fpOf = async s => hex((await sha(s)).subarray(0, 6));

async function adopt(uid, privJwk) {
  const priv = await subtle.importKey("jwk", privJwk, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"]);
  const ps = pubStr(privJwk);
  ident = { uid, priv, pubStr: ps, fp: await fpOf(ps) };
  // The Android app decrypts notification text itself, so it is given the key (kept in the app's private storage). Retried a few
  // times because the app may not have recorded the signed-in account yet.
  const giveApp = () => { try { window.QMApp && window.QMApp.setCryptoKey && window.QMApp.setCryptoKey(uid, JSON.stringify(privJwk)); } catch (_) { /* ignore */ } };
  giveApp(); setTimeout(giveApp, 4000); setTimeout(giveApp, 20000);
  keyCache.clear();
  emit();
}

const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function newCode() {
  const r = rnd(20);
  return Array.from(r, x => ALPHA[x % 32]).join("").replace(/(.{4})(?=.)/g, "$1-");
}
const normCode = c => String(c || "").toUpperCase().replace(/[^A-Z2-9]/g, "");
async function codeKey(code, salt) {
  const base = await subtle.importKey("raw", enc8.encode(normCode(code)), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey({ name: "PBKDF2", salt, iterations: 250000, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function makeBackup(privJwk, code) {
  const salt = rnd(16), iv = rnd(12);
  const ct = await subtle.encrypt({ name: "AES-GCM", iv }, await codeKey(code, salt), enc8.encode(JSON.stringify(privJwk)));
  return { v: 1, salt: b64(salt), iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}

async function createIdentity(uid) {
  const kp = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"]);
  const privJwk = await subtle.exportKey("jwk", kp.privateKey);
  const code = newCode();
  const ps = pubStr(privJwk), fp = await fpOf(ps);
  await set(ref(db, `userKeys/${uid}`), { pub: ps, fp, backup: await makeBackup(privJwk, code) });
  await kvSet("id:" + uid, privJwk);
  await kvSet("code:" + uid, code);
  await kvSet("pending:" + uid, true);
  await adopt(uid, privJwk);
}

/** "ready" (keys usable on this device), "needs-restore" (this account has a backup but this device has no key yet) or
 *  "replaced" (the keys were reset on another device, so the key this device had no longer works). */
export async function init(uid) {
  if (ident && ident.uid === uid) return "ready";
  return locked(async () => {
    if (ident && ident.uid === uid) return "ready";
    const local = await kvGet("id:" + uid);
    if (local) {
      // The check that the keys weren't reset elsewhere needs the network. On a slow connection (offline data on) it gets 2 s; after that this
      // device's own key is used right away and the check finishes in the background (a reset found later locks this device's identity again).
      const remoteP = get(ref(db, `userKeys/${uid}/pub`)).then(s => s.val(), () => null);
      let remote = null;
      const slow = Symbol("slow");
      if (localStorage.getItem("qm-offline") !== "off") remote = await Promise.race([remoteP, new Promise(r => setTimeout(() => r(slow), 1200))]); else remote = await remoteP;
      if (remote === slow) {
        await adopt(uid, local);
        remoteP.then(async r => {
          if (typeof r === "string" && r !== pubStr(local)) {
            await kvSet("id:" + uid, null); await kvSet("code:" + uid, null);
            try { window.QMApp && window.QMApp.setCryptoKey && window.QMApp.setCryptoKey(uid, ""); } catch (_) { /* ignore */ }
            if (ident && ident.uid === uid) { ident = null; keyCache.clear(); emit(); }
          } else if (ident && ident.uid === uid && r !== ident.pubStr) update(ref(db, `userKeys/${uid}`), { pub: ident.pubStr, fp: ident.fp }).catch(() => {});
        });
        return "ready";
      }
      if (typeof remote === "string" && remote !== pubStr(local)) {
        // the keys were reset on another device: this device's old key doesn't work any more, so forget it
        await kvSet("id:" + uid, null); await kvSet("code:" + uid, null);
        try { window.QMApp && window.QMApp.setCryptoKey && window.QMApp.setCryptoKey(uid, ""); } catch (_) { /* ignore */ }
        return "replaced";
      }
      await adopt(uid, local);
      if (remote !== ident.pubStr) await update(ref(db, `userKeys/${uid}`), { pub: ident.pubStr, fp: ident.fp }).catch(() => {});
      return "ready";
    }
    const remote = (await get(ref(db, `userKeys/${uid}`))).val();
    if (remote && remote.backup) return "needs-restore";
    await createIdentity(uid);
    return "ready";
  });
}
export const ready = () => !!ident;
export const myFingerprint = () => ident ? ident.fp.replace(/(.{4})/g, "$1 ").trim() : "";

/** The recovery code to show the user once, right after an identity was created on this device. */
export async function takeNewCode(uid) {
  if (!(await kvGet("pending:" + uid))) return null;
  await kvSet("pending:" + uid, false);
  return (await kvGet("code:" + uid)) || null;
}
export const savedCode = uid => kvGet("code:" + uid);

/** "Not now": the person signed in without the recovery code. This device then skips the unlock prompt (unencrypted chats work as usual). */
const skipKey = uid => "qm-e2e-skip:" + uid;
export const skipped = uid => { try { return localStorage.getItem(skipKey(uid)) === "1"; } catch (_) { return false; } };
export const setSkipped = (uid, on) => { try { on ? localStorage.setItem(skipKey(uid), "1") : localStorage.removeItem(skipKey(uid)); } catch (_) { /* ignore */ } };
/** Does the account have an encryption backup on the server (i.e. is there something to unlock)? */
export const hasBackup = async uid => !!(await get(ref(db, `userKeys/${uid}/backup`)).catch(() => null))?.exists();

/** Restore this account's identity on a new device. Throws "badcode" when the code is wrong. */
export async function restore(uid, code) {
  const b = (await get(ref(db, `userKeys/${uid}/backup`))).val();
  if (!b) throw new Error("nobackup");
  let jwk;
  try {
    const pt = await subtle.decrypt({ name: "AES-GCM", iv: unb64(b.iv) }, await codeKey(code, unb64(b.salt)), unb64(b.ct));
    jwk = JSON.parse(dec8.decode(pt));
  } catch (_) { throw new Error("badcode"); }
  await kvSet("id:" + uid, jwk);
  await kvSet("code:" + uid, normCode(code).replace(/(.{4})(?=.)/g, "$1-"));
  setSkipped(uid, false);
  await adopt(uid, jwk);
}

/** Give up on the old identity: new keys. Chats whose keys can't be unwrapped stay locked until another member's device re-shares them. */
export const startFresh = uid => locked(async () => {
  ident = null; setSkipped(uid, false);
  await dropMyChatKeys(uid);          // the old copies can't be opened by the new identity: take them out so the chats show "no key" and other members re-share
  await createIdentity(uid);
});

/** Remove this user's wrapped copy of the chat key from every chat they are in (used when the identity is reset). Best effort. */
async function dropMyChatKeys(uid) {
  try {
    const ids = Object.keys((await get(ref(db, `chatList/${uid}`))).val() || {});
    await Promise.all(ids.map(id => set(ref(db, `privateChats/${id}/keys/${uid}`), null).catch(() => {})));
  } catch (_) { /* ignore */ }
  keyCache.clear();
}

/** Replace the recovery code (the old one stops working). */
export async function rotateCode(uid) {
  const jwk = await kvGet("id:" + uid);
  if (!jwk) throw new Error("nokey");
  const code = newCode();
  await update(ref(db, `userKeys/${uid}`), { backup: await makeBackup(jwk, code) });
  await kvSet("code:" + uid, code);
  return code;
}

// ---------------------------------------------------------------- other people's public keys
const pubCache = new Map();
async function getPub(uid) {
  const hit = pubCache.get(uid);
  if (hit && Date.now() - hit.t < 60000) return hit.v;
  const r = (await get(ref(db, `userKeys/${uid}`)).catch(() => null))?.val();
  const v = r && typeof r.pub === "string" ? { pub: r.pub, fp: r.fp || await fpOf(r.pub) } : null;
  pubCache.set(uid, { v, t: Date.now() });
  return v;
}
export const hasPublicKey = async uid => !!(await getPub(uid));
const sharedKey = async otherPub => subtle.deriveKey({ name: "ECDH", public: await importPub(otherPub) }, ident.priv, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);

// ---------------------------------------------------------------- chat keys
const keyCache = new Map();               // chatId -> Promise<CryptoKey|null>
const aad = chatId => enc8.encode("qm:" + chatId);

async function unwrap(chatId) {
  const rec = (await get(ref(db, `privateChats/${chatId}/keys/${ident.uid}`)).catch(() => null))?.val();
  if (!rec || !rec.by) return null;
  try {
    const bp = rec.by === ident.uid ? { pub: ident.pubStr } : await getPub(rec.by);
    if (!bp) return null;
    const raw = await subtle.decrypt({ name: "AES-GCM", iv: unb64(rec.iv), additionalData: aad(chatId) }, await sharedKey(bp.pub), unb64(rec.ct));
    return subtle.importKey("raw", raw, "AES-GCM", true, ["encrypt", "decrypt"]);
  } catch (_) { return null; }
}

/** Forget the remembered key of a chat (it was replaced or removed), so the next use fetches it again. */
export const forgetChatKey = chatId => { keyCache.delete(chatId); };

/** The chat key if this device can open it (else null). */
export function getChatKey(chatId) {
  if (!ident) return Promise.resolve(null);
  let p = keyCache.get(chatId);
  if (!p) {
    p = unwrap(chatId).then(k => { if (!k) keyCache.delete(chatId); return k; });
    keyCache.set(chatId, p);
  }
  return p;
}

async function wrapFor(chatId, key, uid) {
  const p = await getPub(uid);
  if (!p) return null;
  const iv = rnd(12);
  const raw = await subtle.exportKey("raw", key);
  const ct = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(chatId) }, await sharedKey(p.pub), raw);
  return { by: ident.uid, bfp: ident.fp, fp: p.fp, iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}

/** Make a brand-new chat key and wrap it for every member who already has a public key (the rest are filled in by ensureMemberKeys later). */
export async function createChatKey(chatId, participants) {
  const key = await subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  keyCache.set(chatId, Promise.resolve(key));
  const out = {};
  for (const u of participants) { const w = await wrapFor(chatId, key, u); if (w) out[u] = w; }
  return { key, wrapped: out };
}

/** Any member holding the key wraps it for members who lack it (new members, or members whose identity changed). */
export async function ensureMemberKeys(chatId, participants) {
  const key = await getChatKey(chatId);
  if (!key) return false;
  const existing = (await get(ref(db, `privateChats/${chatId}/keys`)).catch(() => null))?.val() || {};
  const upd = {};
  for (const u of participants) {
    const p = await getPub(u);
    if (!p) continue;
    const cur = existing[u];
    let stale = !cur || cur.fp !== p.fp;
    if (!stale && cur.by && cur.by !== u && cur.bfp) { const bp = await getPub(cur.by); stale = !!bp && bp.fp !== cur.bfp; }
    if (!stale) continue;
    const w = await wrapFor(chatId, key, u);
    if (w) upd[u] = w;
  }
  if (Object.keys(upd).length) await update(ref(db, `privateChats/${chatId}/keys`), upd).catch(() => {});
  return true;
}

// ---------------------------------------------------------------- encrypt / decrypt
// Chats where NOBODY has the key any more (every member reset or lost theirs): their old encrypted messages are gone for good.
const lostChats = new Set();
export const setChatLost = (chatId, on) => { on ? lostChats.add(chatId) : lostChats.delete(chatId); };
export const isChatLost = chatId => lostChats.has(chatId);
export class NoKey extends Error { constructor() { super("This chat's encryption key isn't available on this device yet."); this.noKey = true; } }
async function need(chatId) { const k = await getChatKey(chatId); if (!k) throw new NoKey(); return k; }

export const isCipher = s => typeof s === "string" && /^1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/.test(s);

export async function encText(chatId, text) {
  const k = await need(chatId), iv = rnd(12);
  const ct = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(chatId) }, k, enc8.encode(text));
  return "1." + b64(iv) + "." + b64(new Uint8Array(ct));
}
export async function decText(chatId, s) {
  const k = await need(chatId);
  const [, iv, ct] = s.split(".");
  return dec8.decode(await subtle.decrypt({ name: "AES-GCM", iv: unb64(iv), additionalData: aad(chatId) }, k, unb64(ct)));
}
/** Bytes → iv ‖ ciphertext (for uploaded files). */
export async function encBytes(chatId, buf) {
  const k = await need(chatId), iv = rnd(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(chatId) }, k, buf));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
  return out;
}
export async function decBytes(chatId, buf) {
  const k = await need(chatId), u = new Uint8Array(buf);
  return subtle.decrypt({ name: "AES-GCM", iv: u.subarray(0, 12), additionalData: aad(chatId) }, k, u.subarray(12));
}

/** Shown before anyone resets their keys (from the unlock prompt or Account → Encryption). */
export const RESET_WARNING = "Resetting is a last resort. Try your recovery code first (or another device that is still signed in).\n\nIf you reset:\n• You get brand-new keys and a new recovery code.\n• Your old keys stop working everywhere. Other devices of yours that still have the old key will be asked to unlock again, and the old recovery code won't work.\n• Older encrypted messages stay unreadable here until another member of each chat opens it and shares access again. Messages nobody else can open are gone for good.\n• Unencrypted chats are not affected.";
