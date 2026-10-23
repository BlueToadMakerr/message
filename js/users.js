// Profile helpers with a small in-memory cache.
import { db } from "./firebase.js";
import { ref, get, update } from "./sdk.js";

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

export function getProfile(uid) {
  if (!pending.has(uid)) {
    const p = get(ref(db, `accsettings/${uid}/settings`))
      .then(s => normalize(uid, s.val()))
      .catch(() => normalize(uid, null))
      .then(profile => { resolved.set(uid, profile); return profile; });
    pending.set(uid, p);
  }
  return pending.get(uid);
}

export const peekProfile = uid => resolved.get(uid) || null;

export function invalidateProfile(uid) {
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
  const snap = await get(r);
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
