import { audioSettingsNode } from "./call/devices.js";
import { rateSelect, spanSelect } from "./dev.js";
import { toHome, toTop, QM, trackSplit, markReady } from "./embed.js";
import { auth, db } from "./firebase.js";
import {
  onAuthStateChanged, signOut, EmailAuthProvider, GoogleAuthProvider,
  reauthenticateWithCredential, reauthenticateWithPopup, updatePassword, deleteUser, sendPasswordResetEmail,
  linkWithPopup, linkWithCredential, unlink
} from "./sdk.js";
import { ref, get, update, remove } from "./sdk.js";
import {
  toast, confirmDialog, promptDialog, avatarEl, hydrateIcons, copyText, authErrorMessage
} from "./ui.js";
import { ensureProfile, invalidateProfile } from "./users.js";
import { ensureFriend, setFriendOn, setFriendPublic, regenerateFriend, friendDeletePaths } from "./friend.js";
import { applyTheme, getTheme, getAppearance, setAppearance, materialAvailable, ACCENT_PRESETS, COLOR_ROLES, getColors, setColor, resetColors, activeScheme } from "./theme.js";
import { refreshSite } from "./refresh.js";
import { updatesSupported, installedVersion, checkForUpdate } from "./update.js";
import { pickColor } from "./customui.js";
import { hasNativeGoogle, nativeGoogleSignIn, nativeScreen } from "./native.js";
import { screenHelpNode } from "./screenhelp.js";
import * as E2E from "./crypto.js";
import { devOn, setDev, devButton, showRaw, envInfo } from "./dev.js";
import { PRESETS, RES, getScreenPrefs, setScreenPrefs, resetScreenPrefs, DEFAULTS } from "./screenprefs.js";
import { previewsOn, setPreviews } from "./linkpreview.js";
import "./datasaver-card.js";
import "./settings-tabs.js";
import { wirePhotoUpload } from "./photo.js";
import { refreshVerified, resendVerification } from "./verify.js";
import { showTour } from "./onboarding.js";
import { track, analyticsOn, onAnalyticsChange, setAnalyticsEnabled, analyticsAvailable } from "./analytics.js";
import { SITE_VERSION, API_VERSION, checkSiteVersion, lastCheck } from "./version.js";
import { HOSTS, getHostSettings, setHostSettings, resetHostSettings, EXPIRY_CHOICES, maxTtl, fmtTtl, fmtLimit } from "./hosts.js";

hydrateIcons();
const $ = id => document.getElementById(id);

let user = null;

function renderHeader(name, pfp) {
  $("headAvatar").replaceChildren(avatarEl(name, pfp, "avatar-lg"));
  $("headName").textContent = name;
}

// Live theme preview while choosing (saved to the profile on "Save changes"). A preview that was never saved is undone as soon as you leave this page.
let savedTheme = getTheme();
$("themeSelect").addEventListener("change", e => applyTheme(e.target.value));
const revertPreview = () => { try { if (getTheme() !== savedTheme) applyTheme(savedTheme); } catch (_) { /* ignore */ } };
addEventListener("pagehide", revertPreview);
addEventListener("beforeunload", revertPreview);

// Live avatar preview
function pfpPaint() {
  const v = $("pfpUrl").value.trim(), isData = /^data:image\//i.test(v);
  renderHeader($("displayName").value.trim() || user?.email || "?", v);
  $("pfpClear").hidden = !v;
  $("pfpNote").hidden = !isData; if (isData) $("pfpNote").textContent = "Uploaded photo (" + Math.round(v.length / 1024) + " KB, stored as a data link). Press Save changes to keep it.";
  // a long data link would bury the field: show a short stand-in instead
  $("pfpUrl").dataset.full = isData ? v : "";
}
$("pfpUrl").addEventListener("input", pfpPaint);
// Upload: shrink to a small square JPEG and keep it as a data: link in the profile (no file hosting needed)
wirePhotoUpload($("pfpUpload"), $("pfpFile"), d => { $("pfpUrl").value = d; pfpPaint(); toast("Photo ready. Press Save changes to keep it.", "success", 3000); }, m => toast(m, "error"));
$("pfpClear").onclick = () => { $("pfpUrl").value = ""; pfpPaint(); };

onAuthStateChanged(auth, async u => {
  if (!u) { toHome(); return; }
  user = u;

  let profile;
  try { profile = await ensureProfile(u); }
  catch (err) { console.error(err); toast("Couldn't load your profile.", "error"); profile = { displayName: u.displayName || "", pfp: "", theme: null }; }

  $("headEmail").textContent = u.email || "";
  paintFriend(u.uid);
  $("displayName").value = profile.displayName === "Unknown user" ? "" : profile.displayName;
  $("pfpUrl").value = profile.pfp || ""; pfpPaint();
  // Bug fix: the old page read an undefined `info.theme` here and crashed.
  const theme = profile.theme || getTheme();
  $("themeSelect").value = applyTheme(theme); savedTheme = $("themeSelect").value;
  renderHeader($("displayName").value || u.email || "?", profile.pfp);

  $("passwordSection").classList.toggle("hidden", !(u.providerData || []).some(p => p.providerId === "password"));
  $("loading").classList.add("hidden");
  $("content").classList.remove("hidden");
  if (window.QMApp) { $("appTitle").textContent = "App"; $("appText").textContent = "If the app looks out of date after a site update, refresh its cache to load the newest version."; $("refreshCacheBtn").textContent = "Refresh app cache"; }
  paintProviders();
  $("emailAddToggle").checked = profile.emailAdd !== false;
  $("previewToggle").checked = previewsOn();
  E2E.init(u.uid).then(() => { $("fpText").textContent = E2E.myFingerprint() || "locked on this device"; paintEncState(); }).catch(() => { $("fpText").textContent = "unavailable"; });
});

// ---------- email verification + sign-in methods ----------
const hasProvider = id => !!user && (user.providerData || []).some(p => p.providerId === id);
function paintProviders() {
  const list = $("providersList");
  list.replaceChildren();
  const add = t => { const d = document.createElement("div"); d.textContent = t; list.append(d); };
  if (hasProvider("password")) add("✓ Email & password");
  if (hasProvider("google.com")) add("✓ Google");
  $("linkGoogleBtn").classList.toggle("hidden", hasProvider("google.com"));
  $("showAddPwBtn").classList.toggle("hidden", hasProvider("password"));
  const vr = $("verifyRow");
  vr.replaceChildren();
  if (user.emailVerified) vr.textContent = "✓ Your email address is verified.";
  else {
    vr.append("Your email isn't verified yet. ");
    const a = document.createElement("button"); a.type = "button"; a.className = "btn small"; a.textContent = "Resend email";
    a.onclick = async () => { try { await resendVerification(); toast("Verification email sent.", "success"); } catch (_) { toast("Couldn't send the email right now.", "error"); } };
    const b = document.createElement("button"); b.type = "button"; b.className = "btn small primary"; b.textContent = "I've verified";
    b.onclick = async () => { if (await refreshVerified()) { paintProviders(); toast("Verified!", "success"); } else toast("Not verified yet.", "info"); };
    vr.append(a, " ", b);
  }
}

// Linking Google to an email account: Google must be the SAME email. A verified Google email also marks the account verified.
async function finishGoogleLink(cred) {
  const g = (cred.user || user).providerData.find(p => p.providerId === "google.com");
  if (!g || (g.email || "").toLowerCase() !== (user.email || "").toLowerCase()) {
    try { await unlink(user, "google.com"); } catch (_) { /* ignore */ }
    throw new Error("That Google account uses a different email address than this account.");
  }
  try {
    const r = await fetch("mark-verified.php", { method: "POST", body: new URLSearchParams({ idToken: await user.getIdToken(true) }) });
    if (!r.ok) console.warn("mark-verified", r.status);
  } catch (_) { /* best effort */ }
  await refreshVerified();
  paintProviders();
  toast("Google account linked. You can now sign in with Google.", "success");
}
$("linkGoogleBtn").onclick = async () => {
  try {
    if (hasNativeGoogle()) {
      // the app signs in through the browser; the shell hands the Google token to this callback instead of signing in
      window.top.__qmGoogleLink = async (idToken, err) => {
        if (!idToken) { toast(err ? "Google sign-in didn't finish." : "Cancelled.", "error"); return; }
        try { const c = await linkWithCredential(user, GoogleAuthProvider.credential(idToken)); await finishGoogleLink(c); }
        catch (e) { toast(authErrorMessage(e) || e.message, "error"); }
      };
      nativeGoogleSignIn();
      return;
    }
    await finishGoogleLink(await linkWithPopup(user, new GoogleAuthProvider()));
  } catch (e) { const m = authErrorMessage(e); toast(m || e.message || "Couldn't link Google.", "error"); }
};
$("showAddPwBtn").onclick = () => $("addPasswordBox").classList.toggle("hidden");
$("addPwBtn").onclick = async () => {
  const pw = $("newPw1").value;
  if (pw.length < 6) return toast("Use at least 6 characters.", "error");
  try {
    await linkWithCredential(user, EmailAuthProvider.credential(user.email, pw));
    $("newPw1").value = ""; $("addPasswordBox").classList.add("hidden");
    $("passwordSection").classList.remove("hidden");
    paintProviders();
    toast("Done. You can now sign in with your email and password.", "success");
  } catch (e) { const m = authErrorMessage(e); toast(m || "Couldn't add a password.", "error"); }
};

// ---------- privacy ----------
// ---------- file hosting ----------
function paintHosts() {
  const s = getHostSettings();
  $("hostMode").value = s.mode;
  const sel = $("hostTtl");
  if (!sel.options.length) for (const [v, l] of EXPIRY_CHOICES) sel.append(new Option(l, String(v)));
  sel.value = String(s.ttl);
  if (sel.value !== String(s.ttl)) { sel.append(new Option(fmtTtl(s.ttl), String(s.ttl))); sel.value = String(s.ttl); }
  const list = $("hostList"); list.replaceChildren();
  const save = n => { setHostSettings(n); paintHosts(); };
  s.order.forEach((id, i) => {
    const h = HOSTS[id], on = !!s.enabled[id];
    const row = document.createElement("div"); row.className = "host-row" + (on ? "" : " off");
    const top = document.createElement("div"); top.className = "host-top";
    const num = document.createElement("span"); num.className = "host-num"; num.textContent = s.mode === "priority" ? String(i + 1) : "•";
    const info = document.createElement("div"); info.className = "host-info";
    const nm = document.createElement("strong"); nm.textContent = h.name;
    const sm = document.createElement("small"); sm.textContent = `Up to ${fmtLimit(h.maxBytes)} · keeps files ${h.keeps ? h.keeps : h.range ? fmtTtl(h.range[0]) + " to " + fmtTtl(h.range[1]) : h.expiries.length > 1 ? "up to " + fmtTtl(maxTtl(h)) + " (" + h.expiries.map(fmtTtl).join(", ") + ")" : fmtTtl(maxTtl(h))}`;
    info.append(nm, sm);
    const mv = (d) => () => { const o = s.order.slice(); const j = i + d; if (j < 0 || j >= o.length) return; [o[i], o[j]] = [o[j], o[i]]; save({ ...s, order: o }); };
    const up = document.createElement("button"); up.type = "button"; up.className = "icon-btn"; up.textContent = "↑"; up.disabled = i === 0; up.setAttribute("aria-label", "Move " + h.name + " up"); up.onclick = mv(-1);
    const dn = document.createElement("button"); dn.type = "button"; dn.className = "icon-btn"; dn.textContent = "↓"; dn.disabled = i === s.order.length - 1; dn.setAttribute("aria-label", "Move " + h.name + " down"); dn.onclick = mv(1);
    const sw = document.createElement("input"); sw.type = "checkbox"; sw.checked = on; sw.className = "host-on"; sw.setAttribute("aria-label", "Use " + h.name);
    sw.onchange = () => save({ ...s, enabled: { ...s.enabled, [id]: sw.checked } });
    top.append(num, info, up, dn, sw);
    const det = document.createElement("details"); det.className = "host-rules";
    const su = document.createElement("summary"); su.textContent = "Rules and limits";
    const ul = document.createElement("ul"); ul.className = "rules"; for (const r of h.rules) { const li = document.createElement("li"); li.textContent = r; ul.append(li); }
    const a = document.createElement("a"); a.href = h.site; a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = "Open " + h.site.replace("https://", "");
    det.append(su, ul, a);
    row.append(top, det); list.append(row);
  });
}
$("hostMode").onchange = () => setHostSettings({ ...getHostSettings(), mode: $("hostMode").value }) || paintHosts();
$("hostTtl").onchange = () => setHostSettings({ ...getHostSettings(), ttl: +$("hostTtl").value || 0 });
$("hostReset").onclick = () => { resetHostSettings(); paintHosts(); toast("File hosting settings reset.", "success", 2000); };
paintHosts();

// ---------- feature suggestions: opens the user's email app, addressed to the developer ----------
const SUGGEST_TO = "bluetmaker@gmail.com";
$("suggestSend").onclick = () => {
  const text = $("suggestText").value.trim();
  if (!text) return toast("Write your idea first.", "info", 2000);
  const href = `mailto:${SUGGEST_TO}?subject=${encodeURIComponent("QuickMessage feature suggestion")}&body=${encodeURIComponent(text)}`;
  try { const a = document.createElement("a"); a.href = href; a.target = "_top"; a.rel = "noopener"; document.body.append(a); a.click(); a.remove(); } catch (_) { /* ignore */ }
  toast("Opening your email app… If nothing opens, use Copy text and send it to " + SUGGEST_TO, "info", 5000);
};
import("./version.js").then(m => { $("aboutVersion").textContent = "You are using version " + m.SITE_VERSION + "."; }).catch(() => {});
{   // usage statistics: one account setting for all devices
  const t = $("analyticsToggle");
  if (!analyticsAvailable()) { t.checked = false; t.disabled = true; t.parentNode.querySelector("small").textContent = "Not used here: this device uses a private server / own database, or your browser sends Do Not Track, so nothing is collected."; }
  else {
    t.checked = analyticsOn() !== false;
    onAnalyticsChange(v => { t.checked = v; });
    t.addEventListener("change", async () => {
      try { await setAnalyticsEnabled(t.checked); toast(t.checked ? "Usage statistics on." : "Usage statistics off on all your devices.", "success", 2500); }
      catch (_) { t.checked = !t.checked; toast("Couldn't save that.", "error"); }
    });
  }
  document.addEventListener("change", e => { const id = e.target && e.target.id; if (id && id !== "analyticsToggle" && /(Toggle|Select)$/.test(id)) track("setting_changed", { setting: id }); });
}
$("suggestCopy").onclick = async () => {
  const text = $("suggestText").value.trim();
  if (!text) return toast("Write your idea first.", "info", 2000);
  try { await navigator.clipboard.writeText(text); toast("Copied. Send it to " + SUGGEST_TO, "success", 3500); } catch (_) { toast("Couldn't copy. Select the text and copy it yourself.", "error"); }
};
$("tourBtn").onclick = () => showTour({ uid: user.uid });
$("emailAddToggle").addEventListener("change", async e => {
  try { await update(ref(db, `accsettings/${user.uid}/settings`), { emailAdd: e.target.checked }); invalidateProfile(user.uid); toast(e.target.checked ? "People can add you by email." : "People need your friend code to add you.", "success", 2500); }
  catch (_) { e.target.checked = !e.target.checked; toast("Couldn't save that.", "error"); }
});
// ---------- friend code ----------
let friend = null;
function paintFriendUI() {
  const ok = !!friend;
  $("friendText").textContent = ok ? friend.code : "Not available right now";
  $("friendText").style.opacity = ok && friend.on ? "1" : ".55";
  $("copyFriendBtn").disabled = !ok;
  $("friendOnToggle").checked = ok && friend.on; $("friendPubToggle").checked = ok && friend.public;
  for (const id of ["friendOnToggle", "friendPubToggle", "friendNewBtn"]) $(id).disabled = !ok;
  $("friendMsg").textContent = !ok ? "" : !friend.on ? "Switched off: nobody can add you with this code." : friend.public ? "People you chat with can copy this code." : "Private: only you can see it.";
}
async function paintFriend(uid) {
  try { friend = await ensureFriend(uid); } catch (e) { console.warn("friend code", e); friend = null; $("friendMsg").textContent = "Couldn't load your friend code. Check your connection and reload."; }
  paintFriendUI();
}
$("copyFriendBtn").onclick = async () => { if (friend) { await copyText(friend.code); toast("Friend code copied.", "success", 1800); } };
$("friendOnToggle").addEventListener("change", async e => {
  try { friend = await setFriendOn(user.uid, e.target.checked); toast(friend.on ? "People can add you with your friend code." : "Your friend code is switched off.", "success", 2500); }
  catch (_) { toast("Couldn't save that.", "error"); }
  paintFriendUI();
});
$("friendPubToggle").addEventListener("change", async e => {
  try { friend = await setFriendPublic(user.uid, e.target.checked); toast(friend.public ? "People you chat with can copy your friend code." : "Your friend code is private.", "success", 2500); }
  catch (_) { toast("Couldn't save that.", "error"); }
  paintFriendUI();
});
$("friendNewBtn").onclick = async () => {
  if (!(await confirmDialog({ title: "Make a new friend code?", message: "Your current code stops working right away. Anyone who has it will need the new one. Chats you already have are not affected.", okText: "Make new code" }))) return;
  try { friend = await regenerateFriend(user.uid); toast("New friend code ready.", "success", 2500); } catch (_) { toast("Couldn't make a new code.", "error"); }
  paintFriendUI();
};
try { $("fpsToggle").checked = localStorage.getItem("qm-show-fps") === "1"; } catch (_) { /* ignore */ }
$("fpsToggle").addEventListener("change", e => { try { localStorage.setItem("qm-show-fps", e.target.checked ? "1" : "0"); } catch (_) { /* ignore */ } toast(e.target.checked ? "Frame rate shown in calls." : "Frame rate hidden.", "success", 2000); });
$("previewToggle").addEventListener("change", e => { setPreviews(e.target.checked); toast(e.target.checked ? "Link previews on." : "Link previews off (reload chats to apply).", "success", 2500); });

// ---------- call notification button (Android app) ----------
if (window.QMApp) {
  $("notifBtnCard").classList.remove("hidden");
  try { $("notifBtn").value = localStorage.getItem("qm-notif-btn") || "screen"; } catch (_) { /* ignore */ }
  $("notifBtn").onchange = e => { try { localStorage.setItem("qm-notif-btn", e.target.value); } catch (_) { /* ignore */ } toast("Saved. It applies on your next call.", "success", 2200); };
}

// ---------- compatibility mode (private server) ----------
{
  const get_ = k => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const set_ = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (_) { /* ignore */ } };
  $("legacyToggle").checked = get_("qm-legacy") === "1";
  $("legacyAuto").checked = get_("qm-legacy-auto") !== "off";
  $("legacyToggle").onchange = e => { set_("qm-legacy", e.target.checked ? "1" : null); toast(e.target.checked ? "On. The simple version opens next time you open QuickMessage." : "Off.", "success", 3000); };
  $("legacyAuto").onchange = e => set_("qm-legacy-auto", e.target.checked ? null : "off");
}

// ---------- site version ----------
{
  const t = $("verText"), l = lastCheck();
  t.textContent = `Site version ${SITE_VERSION} (plugin API v${API_VERSION})` + (l && l.ok && l.newer ? ` \u2014 version ${l.latest} is available, reload to update.` : "");
  checkSiteVersion().then(r => { if (r.ok && r.newer) t.textContent = `Site version ${SITE_VERSION} \u2014 version ${r.latest} is available, reload to update.`; });
}

// ---------- developer mode ----------
$("devToggle").checked = devOn();
$("devToggle").addEventListener("change", e => { setDev(e.target.checked); toast(e.target.checked ? "Developer mode on: look for the { } buttons." : "Developer mode off.", "success", 2500); });
$("devAccountBtn").onclick = () => showRaw("Developer: account", async () => {
  let settings = null; try { settings = (await get(ref(db, `accsettings/${user.uid}`))).val(); } catch (e) { settings = { error: String(e) }; }
  return {
    uid: user.uid, email: user.email, emailVerified: user.emailVerified, providers: (user.providerData || []).map(p => p.providerId), created: user.metadata && user.metadata.creationTime, lastSignIn: user.metadata && user.metadata.lastSignInTime,
    accsettings: settings, e2e: { ready: E2E.ready(), fingerprint: E2E.myFingerprint(), skipped: E2E.skipped(user.uid) }, screenSharing: getScreenPrefs(),
    app: window.QMApp ? Object.keys(window.QMApp).sort() : null, env: envInfo()
  };
});

// ---------- colours: midnight, Material You, accent ----------
{
  const ap = getAppearance(), hexOk = v => /^#[0-9a-f]{6}$/i.test(v || "");
  $("midnight").checked = ap.midnight;
  const matOk = materialAvailable();
  $("materialRow").classList.toggle("hidden", !matOk);
  $("material").checked = ap.material;
  const sw = $("accentSwatches");
  for (const c of ACCENT_PRESETS) { const b = document.createElement("button"); b.type = "button"; b.className = "swatch"; b.style.background = c; b.dataset.c = c; b.setAttribute("aria-label", "Accent " + c); sw.append(b); }
  const paint = () => {
    const a = getAppearance();
    $("accentPick").firstElementChild.style.background = a.accent || ACCENT_PRESETS[0]; $("accentHex").textContent = a.accent ? a.accent : "default";
    sw.querySelectorAll(".swatch").forEach(b => b.classList.toggle("on", !!a.accent && b.dataset.c === a.accent));
    $("accentBox").classList.toggle("dim", a.material);
    $("accentPick").disabled = a.material; $("accentReset").disabled = a.material || !a.accent;
    paintRows();
  };
  $("midnight").onchange = () => { setAppearance({ midnight: $("midnight").checked }); paint(); };
  $("material").onchange = () => { setAppearance({ material: $("material").checked }); paint(); };
  sw.addEventListener("click", e => { const c = e.target.dataset && e.target.dataset.c; if (c && !getAppearance().material) { setAppearance({ accent: c }); paint(); } });
  $("accentPick").onclick = async () => { const c = await pickColor({ title: "Accent colour", value: getAppearance().accent || ACCENT_PRESETS[0] }); if (c) { setAppearance({ accent: c }); paint(); } };
  $("accentReset").onclick = () => { setAppearance({ accent: "" }); paint(); };

  // your own colours, separately for light and dark mode
  let scheme = activeScheme();
  const rows = $("colorRows");
  const tokenOf = (role) => { const T = window.__qmThemeTokens ? window.__qmThemeTokens() : null, key = { bg: "bg", surface: "surface", own: "ownBubble", other: "otherBubble", text: "text" }[role]; return T && T[key] ? T[key][scheme === "dark" ? 1 : 0] : "#888888"; };
  function paintRows() {
    $("schemeSeg").querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.s === scheme));
    const mine = getColors()[scheme] || {};
    rows.replaceChildren();
    for (const [role, label, hint] of COLOR_ROLES) {
      const row = document.createElement("div"); row.className = "color-row";
      const lab = document.createElement("div"); lab.className = "cr-label"; lab.textContent = label; const sm = document.createElement("small"); sm.textContent = hint; lab.append(sm);
      const btn = document.createElement("button"); btn.type = "button"; btn.className = "color-btn";
      const dot = document.createElement("i"); dot.style.background = mine[role] || tokenOf(role); const tx = document.createElement("span"); tx.textContent = mine[role] || "default"; btn.append(dot, tx);
      btn.onclick = async () => { const c = await pickColor({ title: label + (scheme === "dark" ? " (dark mode)" : " (light mode)"), value: mine[role] || tokenOf(role) }); if (c) { setColor(scheme, role, c); paintRows(); } };
      const reset = document.createElement("button"); reset.type = "button"; reset.className = "btn small ghost"; reset.textContent = "Default"; reset.hidden = !mine[role];
      reset.onclick = () => { setColor(scheme, role, ""); paintRows(); };
      row.append(lab, btn, reset); rows.append(row);
    }
  }
  $("schemeSeg").addEventListener("click", e => { const s2 = e.target.dataset && e.target.dataset.s; if (s2) { scheme = s2; paintRows(); } });
  $("colorsReset").onclick = () => { setColor(scheme, "bg", ""); for (const [r] of COLOR_ROLES) setColor(scheme, r, ""); paintRows(); };
  paint();
}

// ---------- screen sharing ----------
{
  const o = id => $(id);
  const fill = (sel, map) => { sel.replaceChildren(); for (const [k, v] of Object.entries(map)) { const op = document.createElement("option"); op.value = k; op.textContent = typeof v === "string" ? v : v.label; sel.append(op); } };
  fill(o("scPreset"), { ...PRESETS, custom: "Custom" }); fill(o("scRes"), RES);
  const nativeShare = !!nativeScreen();
  if (nativeShare) { o("scApp").classList.remove("hidden"); o("scWeb").classList.add("hidden"); }
  o("scHelpHost").append(screenHelpNode());
  const paint = p => {
    o("scPreset").value = p.preset; o("scRes").value = p.res; o("scFps").value = p.fps; o("scBitrate").value = p.bitrate; o("scHint").value = p.hint; o("scDegrade").value = p.degrade;
    o("scCodec").value = p.codec; o("scAudio").checked = !!p.audio; o("scJpeg").value = p.jpeg; o("scAfps").value = p.afps;
    o("scFpsOut").textContent = p.fps; o("scJpegOut").textContent = p.jpeg; o("scAfpsOut").textContent = p.afps;
    o("scSummary").textContent = nativeShare
      ? `Now: ${RES[p.res]}, ${p.afps} fps, picture quality ${p.jpeg}%${p.bitrate ? ", up to " + p.bitrate + " kbps" : ""}.`
      : `Now: ${RES[p.res]}, ${p.fps} fps${p.bitrate ? ", up to " + p.bitrate + " kbps" : ""}, ${o("scHint").selectedOptions[0].textContent.toLowerCase()}.`;
  };
  const read = () => ({ preset: "custom", res: o("scRes").value, fps: +o("scFps").value, bitrate: +o("scBitrate").value || 0, hint: o("scHint").value, degrade: o("scDegrade").value, codec: o("scCodec").value, audio: o("scAudio").checked, jpeg: +o("scJpeg").value, afps: +o("scAfps").value });
  const save = p => { setScreenPrefs(p); paint(getScreenPrefs()); };
  paint(getScreenPrefs());
  o("scPreset").onchange = () => { const k = o("scPreset").value; if (k === "custom") { o("scAdv").open = true; save({ ...read() }); } else { const { label, ...rest } = PRESETS[k]; save({ ...getScreenPrefs(), ...rest, preset: k }); } };
  for (const id of ["scRes", "scFps", "scBitrate", "scHint", "scDegrade", "scCodec", "scAudio", "scJpeg", "scAfps"]) o(id).addEventListener("input", () => save(read()));
  o("scReset").onclick = () => { resetScreenPrefs(); paint(getScreenPrefs()); toast("Screen sharing settings reset.", "success", 2000); };
}

// ---------- encryption ----------
/** A dialog showing a recovery code with a Copy button next to it. */
function codeNode(code) {
  const box = document.createElement("div"); box.className = "stack";
  const cb = document.createElement("div"); cb.className = "code-box";
  const c = document.createElement("code"); c.textContent = code; cb.append(c);
  const copy = document.createElement("button"); copy.type = "button"; copy.className = "btn"; copy.textContent = "Copy code";
  copy.onclick = async () => {
    try { await copyText(code); copy.textContent = "Copied ✓"; } catch (_) { copy.textContent = "Couldn't copy"; }
    setTimeout(() => { copy.textContent = "Copy code"; }, 1800);
  };
  box.append(cb, copy); return box;
}
$("showCodeBtn").onclick = async () => {
  const c = await E2E.savedCode(user.uid).catch(() => null);
  if (c) await confirmDialog({ title: "Your recovery code", node: codeNode(c), message: "Keep it somewhere safe. It is the only way to read your encrypted chats on a new device.", okText: "Close", hideCancel: true });
  else await confirmDialog({ title: "Your recovery code", message: "This device doesn't have the code stored (it was set up elsewhere, or you skipped unlocking here). Find it on a device that has it, or reset your keys as a last resort.", okText: "Close", hideCancel: true });
};
$("newCodeBtn").onclick = async () => {
  if (!(await confirmDialog({ title: "Make a new recovery code?", message: "The old code stops working. Save the new one somewhere safe.", okText: "Make new code" }))) return;
  try { const c = await E2E.rotateCode(user.uid); await confirmDialog({ title: "Your new recovery code", node: codeNode(c), okText: "I've saved it", hideCancel: true }); }
  catch (_) { toast("Couldn't change the code on this device (it needs your key).", "error"); }
};
// This device has no key (signed in somewhere new, and chose "Not now" or doesn't have the code yet): enter the code later, or start over
function paintEncState() {
  const locked = !E2E.ready();
  $("encLocked").classList.toggle("hidden", !locked);
  $("showCodeBtn").classList.toggle("hidden", locked);
  $("newCodeBtn").classList.toggle("hidden", locked);
}
$("unlockBtn").onclick = async () => {
  let msg = "";
  for (;;) {
    const code = await promptDialog({ title: "Enter your recovery code", message: msg || "This unlocks your encrypted chats on this device.", input: { placeholder: "XXXX-XXXX-XXXX-XXXX-XXXX" }, okText: "Unlock" });
    if (code == null) return;
    try { await E2E.restore(user.uid, code); toast("Encrypted chats unlocked.", "success"); await E2E.init(user.uid); $("fpText").textContent = E2E.myFingerprint(); paintEncState(); return; }
    catch (e) { msg = e.message === "badcode" ? "That code doesn't match. Try again." : "Couldn't restore: " + e.message; }
  }
};
$("resetKeysBtn").onclick = async () => {
  if (!(await confirmDialog({ title: "Reset your encryption keys?", message: E2E.RESET_WARNING, okText: "Reset keys", danger: true }))) return;
  try {
    await E2E.startFresh(user.uid);
    const c = await E2E.takeNewCode(user.uid) || await E2E.savedCode(user.uid);
    $("fpText").textContent = E2E.myFingerprint(); paintEncState();
    if (c) await confirmDialog({ title: "Your new recovery code", node: codeNode(c), message: "Save it now. Your old keys and the old code no longer work.", okText: "I've saved it", hideCancel: true });
  } catch (e) { toast("Couldn't reset the keys: " + (e.message || e), "error"); }
};

// ---------- app updates (Android / iPhone app) ----------
if (updatesSupported()) {
  $("updateRow").classList.remove("hidden");
  const v = installedVersion(); $("updateVer").textContent = v ? `Installed version ${v.name || v.code}` : "";
  $("updateBtn").onclick = async () => { $("updateBtn").disabled = true; try { await checkForUpdate({ manual: true }); } finally { $("updateBtn").disabled = false; } };
}

// ---------- refresh the app / site ----------
$("refreshCacheBtn")?.addEventListener("click", async () => {
  const btn = $("refreshCacheBtn"), inApp = !!window.QMApp;
  btn.disabled = true; btn.textContent = "Refreshing…";
  try { await refreshSite({ unregister: inApp, onProgress: n => { btn.textContent = `Refreshing… (${n})`; } }); } catch (_) { /* best effort */ }
  try { window.QMApp && window.QMApp.clearCache && window.QMApp.clearCache(); } catch (_) { /* ignore */ }
  btn.textContent = "Reloading…";
  setTimeout(() => { try { (window.top || window).location.reload(); } catch (_) { location.reload(); } }, 300);
});

// ---------- save profile ----------
$("profileForm").addEventListener("submit", async e => {
  e.preventDefault();
  if (!user) return;
  const displayName = $("displayName").value.trim();
  const pfp = $("pfpUrl").value.trim();
  if (!displayName) return toast("Display name can't be empty.", "error");
  if (pfp && !/^(https?:\/\/|data:image\/)/i.test(pfp)) return toast("Profile picture must be an http(s) link or an uploaded photo.", "error");
  if (pfp.length > 30000) return toast("That picture is too large. Upload a photo instead.", "error");

  const btn = $("saveSettingsBtn");
  btn.disabled = true;
  try {
    await update(ref(db, `accsettings/${user.uid}/settings`), { displayName, pfp, theme: $("themeSelect").value });
    invalidateProfile(user.uid);
    savedTheme = applyTheme($("themeSelect").value);
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
  toTop("index.html");
};

// ---------- delete account ----------
async function reauthenticate() {
  const hasPassword = (user.providerData || []).some(p => p.providerId === "password");
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
      friendDeletePaths(uid).then(o => update(ref(db), o)),
      import("./bots.js").then(b => b.listBots(uid).then(l => Promise.all(l.map(x => b.deleteBot(uid, x.id))))),     // your bots go with the account
      remove(ref(db, `botList/${uid}`)),
      remove(ref(db, `chatList/${uid}`)),
      remove(ref(db, `FCM/${uid}`)),
      remove(ref(db, `userKeys/${uid}`)),
      remove(ref(db, `accsettings/${uid}`))
    ]);
    await deleteUser(user);
    toast("Account deleted.");
    setTimeout(() => toHome(), 800);
  } catch (err) {
    const m = authErrorMessage(err); if (m) toast(m, "error");
  }
};

trackSplit();
if (QM) document.querySelector('a[aria-label="Back to chats"]')?.addEventListener("click", e => { e.preventDefault(); QM.closeDetail(); });

markReady();   // tells the app shell this frame booted (see frame watchdog in shell.js)

$("audioHost")?.append(audioSettingsNode());

$("devRateHost")?.append(rateSelect(), spanSelect());
