import { auth, db } from "./firebase.js";
import {
  onAuthStateChanged, signOut, EmailAuthProvider, GoogleAuthProvider,
  reauthenticateWithCredential, reauthenticateWithPopup, updatePassword, deleteUser, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";
import { ref, get, update, remove } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-database.js";
import {
  toast, confirmDialog, promptDialog, avatarEl, hydrateIcons, copyText, authErrorMessage
} from "./ui.js";
import { ensureProfile, invalidateProfile } from "./users.js";
import { applyTheme, getTheme } from "./theme.js";

hydrateIcons();
const $ = id => document.getElementById(id);

let user = null;

function renderHeader(name, pfp) {
  $("headAvatar").replaceChildren(avatarEl(name, pfp, "avatar-lg"));
  $("headName").textContent = name;
}

// Live theme preview while choosing (saved to the profile on "Save changes").
$("themeSelect").addEventListener("change", e => applyTheme(e.target.value));

// Live avatar preview
$("pfpUrl").addEventListener("input", () => {
  renderHeader($("displayName").value.trim() || user?.email || "?", $("pfpUrl").value.trim());
});

onAuthStateChanged(auth, async u => {
  if (!u) { location.replace("index.html"); return; }
  user = u;

  let profile;
  try { profile = await ensureProfile(u); }
  catch (err) { console.error(err); toast("Couldn't load your profile.", "error"); profile = { displayName: u.displayName || "", pfp: "", theme: null }; }

  $("headEmail").textContent = u.email || "";
  $("uidText").textContent = u.uid;
  $("displayName").value = profile.displayName === "Unknown user" ? "" : profile.displayName;
  $("pfpUrl").value = profile.pfp || "";
  // Bug fix: the old page read an undefined `info.theme` here and crashed.
  const theme = profile.theme || getTheme();
  $("themeSelect").value = applyTheme(theme);
  renderHeader($("displayName").value || u.email || "?", profile.pfp);

  $("passwordSection").classList.toggle("hidden", !u.providerData.some(p => p.providerId === "password"));
  $("loading").classList.add("hidden");
  $("content").classList.remove("hidden");
});

$("copyUidBtn").onclick = () => copyText(user.uid);

// ---------- save profile ----------
$("profileForm").addEventListener("submit", async e => {
  e.preventDefault();
  if (!user) return;
  const displayName = $("displayName").value.trim();
  const pfp = $("pfpUrl").value.trim();
  if (!displayName) return toast("Display name can't be empty.", "error");
  if (pfp && !/^https?:\/\//i.test(pfp)) return toast("Profile picture must be an http(s) link.", "error");

  const btn = $("saveSettingsBtn");
  btn.disabled = true;
  try {
    await update(ref(db, `accsettings/${user.uid}/settings`), { displayName, pfp, theme: $("themeSelect").value });
    invalidateProfile(user.uid);
    applyTheme($("themeSelect").value);
    renderHeader(displayName, pfp);
    toast("Profile saved.", "success");
  } catch (err) {
    console.error(err);
    toast("Couldn't save: " + (err.message || err), "error");
  } finally { btn.disabled = false; }
});

// ---------- password ----------
$("passwordForm").addEventListener("submit", async e => {
  e.preventDefault();
  const oldPass = $("oldPassword").value, newPass = $("newPassword").value;
  if (!oldPass || newPass.length < 6) return toast("Enter your current password and a new one (6+ characters).", "error");
  const btn = $("changePassBtn");
  btn.disabled = true;
  try {
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, oldPass));
    await updatePassword(user, newPass);
    $("oldPassword").value = $("newPassword").value = "";
    toast("Password updated.", "success");
  } catch (err) {
    const m = authErrorMessage(err); if (m) toast(m, "error");
  } finally { btn.disabled = false; }
});

$("resetBtn").onclick = async () => {
  try {
    await sendPasswordResetEmail(auth, user.email);
    toast("Reset email sent to " + user.email, "success");
  } catch (err) {
    const m = authErrorMessage(err); if (m) toast(m, "error");
  }
};

// ---------- logout ----------
$("logoutBtn").onclick = async () => {
  await signOut(auth);
  location.href = "index.html";
};

// ---------- delete account ----------
async function reauthenticate() {
  const hasPassword = user.providerData.some(p => p.providerId === "password");
  if (hasPassword) {
    const pass = await promptDialog({
      title: "Confirm it's you", message: "Enter your password to continue.",
      input: { type: "password", placeholder: "Password" }, okText: "Continue"
    });
    if (!pass) return false;
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, pass));
    return true;
  }
  await reauthenticateWithPopup(user, new GoogleAuthProvider());
  return true;
}

$("deleteBtn").onclick = async () => {
  const ok = await confirmDialog({
    title: "Delete your account?",
    message: "This permanently deletes your account and profile and removes you from all chats. This can't be undone.",
    okText: "Delete account", danger: true
  });
  if (!ok) return;

  try {
    // Re-authenticate first so the final deleteUser can't fail halfway through the cleanup.
    if (!(await reauthenticate())) return;

    const uid = user.uid;
    const chatIds = Object.keys((await get(ref(db, `chatList/${uid}`)).catch(() => null))?.val() || {});
    for (const chatId of chatIds) {
      try {
        const parts = (await get(ref(db, `privateChats/${chatId}/participants`))).val() || {};
        if (Object.keys(parts).filter(p => p !== uid).length === 0) {
          await remove(ref(db, `privateChats/${chatId}`));
        } else {
          await update(ref(db), {
            [`privateChats/${chatId}/participants/${uid}`]: null,
            [`privateChats/${chatId}/messageRead/${uid}`]: null,
            [`privateChats/${chatId}/typing/${uid}`]: null
          });
        }
      } catch (err) { console.warn("Couldn't clean up chat", chatId, err); }
    }
    await Promise.allSettled([
      remove(ref(db, `chatList/${uid}`)),
      remove(ref(db, `FCM/${uid}`)),
      remove(ref(db, `accsettings/${uid}`))
    ]);
    await deleteUser(user);
    toast("Account deleted.");
    setTimeout(() => location.replace("index.html"), 800);
  } catch (err) {
    const m = authErrorMessage(err); if (m) toast(m, "error");
  }
};
