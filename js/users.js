// Profile helpers with a small in-memory cache.
import { db } from "./firebase.js";
import { ref, get, update } from "./sdk.js";
import { getSWR } from "./offline.js";

const pending = new Map();   // uid -> Promise<profile>
const resolved = new Map();  // uid -> profile (for synchronous peeks)

function normalize(uid, raw) {
  return {
    uid,
    exists: !!raw,
    displayName: (raw && typeof raw.displayName === "string" && raw.displayName.trim()) || "Unknown user",
    pfp: (raw && raw.pfp) || "",
    theme: (raw && raw.theme) || null,
    emailAdd: raw ? raw.emailAdd : undefined
  };
}

// A profile is also kept on this device for a while (localStorage), so opening the app doesn't download every contact's settings again.
const PROFILE_TTL = 15 * 60 * 1000;
const cacheKey = uid => "qm-prof-" + uid;
function cachedRaw(uid) {
  try { const c = JSON.parse(localStorage.getItem(cacheKey(uid)) || "null"); if (c && Date.now() - c.at < PROFILE_TTL) return { raw: c.raw }; } catch (_) { /* ignore */ }
  return null;
}
function storeRaw(uid, raw) {
  try {
    const slim = raw ? { displayName: raw.displayName, pfp: raw.pfp, theme: raw.theme, emailAdd: raw.emailAdd } : null;
    const text = JSON.stringify({ at: Date.now(), raw: slim });
    if (text.length < 120000) localStorage.setItem(cacheKey(uid), text);
  } catch (_) { /* storage full: no caching */ }
}

export function getProfile(uid) {
  if (!pending.has(uid)) {
    const hit = cachedRaw(uid);
    const p = (hit ? Promise.resolve(hit.raw) : getSWR(ref(db, `accsettings/${uid}/settings`)).then(s => { const v = s.val(); if (!s.fromCache) storeRaw(uid, v); return v; }))
      .then(raw => normalize(uid, raw))
      .catch(() => normalize(uid, null))
      .then(profile => { resolved.set(uid, profile); return profile; });
    pending.set(uid, p);
  }
  return pending.get(uid);
}

export const peekProfile = uid => resolved.get(uid) || null;

export function invalidateProfile(uid) {
  try { localStorage.removeItem(cacheKey(uid)); } catch (_) { /* ignore */ }
  pending.delete(uid);
  resolved.delete(uid);
}

export async function profileExists(uid) {
  const s = await get(ref(db, `accsettings/${uid}/settings`));
  return s.exists();
}

// New sign-ups (and Google logins) never had a profile written in the old app,
// which made other people see "User does not exist" / broken chat rows.
export async function ensureProfile(user) {
  const r = ref(db, `accsettings/${user.uid}/settings`);
  const snap = await getSWR(r);
  const cur = snap.val() || {};
  if (cur.displayName) return normalize(user.uid, cur);
  const fallback = {
    displayName: user.displayName || (user.email || "").split("@")[0] || "User",
    pfp: cur.pfp || user.photoURL || "",
    theme: cur.theme || (() => { try { return localStorage.getItem("theme"); } catch { return null; } })() || "system"
  };
  await update(r, fallback);
  invalidateProfile(user.uid);
  return normalize(user.uid, fallback);
}
