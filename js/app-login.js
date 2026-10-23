// Browser half of "Sign in with Google" for the Android app (a WebView can't run Google's popup flow). It signs in here, then
// hands the Google ID token back to the app through the quickmessage://auth link; the app passes it to the page, which finishes
// signing in with it (see index.js).
import { auth } from "./firebase.js";
import { signInWithPopup, GoogleAuthProvider } from "./sdk.js";
const $ = id => document.getElementById(id);
$("go").onclick = async () => {
  $("go").disabled = true; $("msg").textContent = "Opening Google…";
  try {
    const res = await signInWithPopup(auth, new GoogleAuthProvider());
    const cred = GoogleAuthProvider.credentialFromResult(res);
    if (!cred || !cred.idToken) throw new Error("Google didn't return a token.");
    const url = "quickmessage://auth?idToken=" + encodeURIComponent(cred.idToken);
    $("back").href = url; $("back").classList.remove("hidden");
    $("msg").textContent = "Signed in. Returning to the app…";
    location.href = url;
  } catch (err) {
    $("go").disabled = false;
    $("msg").textContent = (err && err.code === "auth/popup-closed-by-user") ? "Sign-in was cancelled." : "Couldn't sign in: " + ((err && err.message) || "unknown error");
  }
};
