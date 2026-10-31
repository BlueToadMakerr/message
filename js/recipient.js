// Turns what the user typed in an "add someone" box into a UID: either a UID, or an email address.
// Emails are never stored or shown: the server looks the account up and only hands back the UID (and only if that person allows it).
import { auth } from "./firebase.js";
import { PRIVATE, privateBase } from "./mode.js";

export const looksLikeEmail = s => (PRIVATE ? /^[^\s@]+@[^\s@]+$/ : /^[^\s@]+@[^\s@]+\.[^\s@]+$/).test(String(s).trim());

/** @returns {Promise<string>} uid. Throws Error with a user-facing message. */
export async function resolveRecipient(input) {
  const v = String(input || "").trim();
  if (!v) throw new Error("Enter a UID or an email address.");
  if (!v.includes("@")) {
    if (!/^[\w-]{6,128}$/.test(v)) throw new Error("That doesn't look like a valid UID or email address.");
    return v;
  }
  if (!looksLikeEmail(v)) throw new Error("That doesn't look like a valid email address.");
  const idToken = await auth.currentUser.getIdToken();
  if (PRIVATE) {                                                  // private server: its own lookup, same answer shape
    const j = await fetch((privateBase() || "") + "/api/lookup?email=" + encodeURIComponent(v), { headers: { Authorization: "Bearer " + idToken } }).then(r => r.json()).catch(() => ({}));
    if (!j.uid) throw new Error("No account with that email on this server.");
    return j.uid;
  }
  let r;
  try { r = await fetch("email-lookup.php", { method: "POST", body: new URLSearchParams({ idToken, email: v }) }); }
  catch (_) { throw new Error("Couldn't reach the server to look that email up."); }
  let j = {}; try { j = await r.json(); } catch (_) { /* ignore */ }
  if (!r.ok || !j.uid) throw new Error(j.error || "No one can be added with that email.");
  return j.uid;
}
