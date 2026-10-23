// Email verification helpers. Google accounts are verified automatically; email+password accounts must click the link in the email.
import { auth } from "./firebase.js";
import { sendEmailVerification } from "./sdk.js";
import { toast } from "./ui.js";

export const isVerified = () => { const u = auth.currentUser; return !u || u.emailVerified === true; };

/** Use before an action that needs a verified email. Shows a message and returns false when it isn't allowed yet. */
export function requireVerified(what) {
  if (isVerified()) return true;
  toast(`Verify your email to ${what}. Check your inbox for the link.`, "error", 5000);
  return false;
}

/** Re-reads the account from the server; once verified, also refreshes the sign-in token (the database rules read it). */
export async function refreshVerified() {
  const u = auth.currentUser;
  if (!u) return false;
  try { await u.reload(); if (u.emailVerified) await u.getIdToken(true); } catch (_) { /* offline */ }
  return u.emailVerified === true;
}

export async function resendVerification() {
  const u = auth.currentUser;
  if (!u) return;
  await sendEmailVerification(u);
}

/** Calls [cb] when the verified state changes (polls while unverified, so clicking the email link is noticed). */
export function watchVerified(cb) {
  let last = isVerified();
  const tick = async () => {
    if (!isVerified()) await refreshVerified();
    const now = isVerified();
    if (now !== last) { last = now; cb(now); }
  };
  const t = setInterval(tick, 5000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });
  return () => clearInterval(t);
}
