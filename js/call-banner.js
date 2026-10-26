// "Call in progress" strip for the chat page (Discord-style): who is in the call, how long it has been going, and a Join button (not in Android bubbles).
// Also points the header call button at call.html for this chat.
//
//   import { initCallBanner } from "./call-banner.js";
//   initCallBanner({ chatId, callBtn: document.getElementById("callBtn"), after: document.querySelector(".topbar") });
import { db } from "./firebase.js";
import { ref, onValue } from "./sdk.js";
import { avatarEl, icon } from "./ui.js";
import { getProfile } from "./users.js";
import { QM } from "./embed.js";

const GHOST_MS = 60000; // ignore sessions that stopped heartbeating (they're removed for good after 120 s)

export function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const mm = String(m).padStart(h ? 2 : 1, "0"), rr = String(r).padStart(2, "0");
  return h ? `${h}:${mm}:${rr}` : `${mm}:${rr}`;
}

/** Live sessions → { uids:Set, start:number|null } (pure helper, also used by tests) */
export function summarize(sessions, now) {
  const uids = new Set();
  let start = null;
  for (const s of Object.values(sessions || {})) {
    if (!s || typeof s.uid !== "string") continue;
    if (typeof s.lastSeen === "number" && s.lastSeen < now - GHOST_MS) continue;
    uids.add(s.uid);
    if (typeof s.joinedAt === "number" && (start === null || s.joinedAt < start)) start = s.joinedAt;
  }
  return { uids, start };
}

export function initCallBanner({ chatId, callBtn, after }) {
  const href = `call.html?chatId=${encodeURIComponent(chatId)}`;
  if (callBtn) callBtn.href = href;

  // Inside the app shell, opening the call must not reload anything: the shell hosts the call layer.
  const open = e => { if (QM) { e.preventDefault(); QM.openCall(chatId); } };
  callBtn?.addEventListener("click", open);
  const bar = document.createElement("a");
  bar.className = "call-banner";
  bar.href = href;
  bar.hidden = true;
  bar.addEventListener("click", open);
  bar.innerHTML = `<span class="cb-live"></span><span class="cb-text"><strong>Call in progress</strong><span class="cb-meta"></span></span><span class="cb-faces"></span><span class="cb-join">Join</span>`;
  const meta = bar.querySelector(".cb-meta"), faces = bar.querySelector(".cb-faces");
  (after?.parentNode || document.body).insertBefore(bar, after ? after.nextSibling : document.body.firstChild);

  let offset = 0, start = null, uids = [], timer = null, startedAt = null, lastSessions = null;
  const now = () => Date.now() + offset;

  const tick = () => {
    const n = uids.length;
    meta.textContent = ` · ${n} ${n === 1 ? "person" : "people"}` + (start ? ` · ${fmtDuration(now() - start)}` : "");
  };
  const facesKey = () => uids.join(",");
  let shownFaces = "";
  async function drawFaces() {
    const key = facesKey(); if (key === shownFaces) return;
    shownFaces = key;
    const profiles = await Promise.all(uids.slice(0, 4).map(getProfile));
    if (key !== shownFaces) return;
    faces.replaceChildren(...profiles.map(p => avatarEl(p.displayName, p.pfp, "avatar xs")));
  }
  function update(sessions) {
    const sum = summarize(sessions, now());
    lastSessions = sessions;
    uids = [...sum.uids]; start = (uids.length && typeof startedAt === "number") ? startedAt : sum.start;
    const active = uids.length > 0;
    bar.hidden = !active;
    callBtn?.classList.toggle("in-call", active);
    if (callBtn) callBtn.title = active ? "Join the call in progress" : "Start a call";
    clearInterval(timer);
    if (active) { tick(); drawFaces(); timer = setInterval(tick, 1000); }
  }

  const unsubs = [
    onValue(ref(db, ".info/serverTimeOffset"), s => { offset = s.val() || 0; }),
    onValue(ref(db, `calls/${chatId}/startedAt`), s => { startedAt = typeof s.val() === "number" ? s.val() : null; if (lastSessions) update(lastSessions); }, () => {}),
    onValue(ref(db, `calls/${chatId}/sessions`), s => update(s.val()), () => { bar.hidden = true; })
  ];
  // Heartbeats keep sessions fresh; re-evaluate on visibility so a long-hidden tab doesn't show a stale call.
  return () => { clearInterval(timer); unsubs.forEach(u => u()); bar.remove(); };
}
