// Full-screen "incoming call" prompt, shown on whatever page of the app the user is on.
// Rings live at live/{uid}/rings/{chatId} (written next to calls/{chatId}/ringing/{uid} by ring.js).
import { db } from "./firebase.js";
import { ref, onValue, get } from "./sdk.js";
import { avatarEl, icon } from "./ui.js";
import { getProfile } from "./users.js";
import { clearRing, declineRing, RING_TTL_MS } from "./call/ring.js";
import { audioCtx } from "./call/audio.js";

let root = null, tone = null, ttl = null, current = null;

function build() {
  root = document.createElement("div");
  root.className = "incoming-call";
  root.setAttribute("role", "alertdialog");
  root.setAttribute("aria-label", "Incoming call");
  root.hidden = true;
  root.innerHTML = `
    <div class="ic-card">
      <div class="ic-rings"><span class="ic-av"></span></div>
      <div class="ic-label">Incoming call</div>
      <h2 class="ic-name"></h2>
      <p class="ic-chat"></p>
      <div class="ic-actions">
        <button type="button" class="ic-btn decline" aria-label="Decline"></button>
        <button type="button" class="ic-btn answer" aria-label="Answer"></button>
      </div>
    </div>`;
  document.body.append(root);
  root.querySelector(".decline").innerHTML = icon("phoneOff", 28);
  root.querySelector(".answer").innerHTML = icon("phone", 28);
  root.querySelector(".decline").onclick = () => { const r = current; hide(); if (r) declineRing(r.chatId, opts.uid, r); };
  root.querySelector(".answer").onclick = () => { const r = current; dismiss(true); if (r) opts.onAnswer(r.chatId); };
}

// Two soft beeps every 2.5 s. Browsers may refuse audio before the first interaction — then it's silent (the vibration/visuals still work).
function startTone() {
  stopTone();
  const beep = () => {
    const c = audioCtx();
    if (!c || c.state !== "running") return;
    const t = c.currentTime;
    for (const [dt, f] of [[0, 880], [0.28, 660]]) {
      const o = c.createOscillator(), g = c.createGain();
      o.type = "sine"; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + dt); g.gain.exponentialRampToValueAtTime(0.18, t + dt + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + dt + 0.24);
      o.connect(g).connect(c.destination); o.start(t + dt); o.stop(t + dt + 0.26);
    }
    try { navigator.vibrate && navigator.vibrate([200, 120, 200]); } catch (_) { /* ignore */ }
  };
  beep();
  tone = setInterval(beep, 2500);
}
function stopTone() { clearInterval(tone); tone = null; try { navigator.vibrate && navigator.vibrate(0); } catch (_) { /* ignore */ } }

function hide() { stopTone(); clearTimeout(ttl); if (root) root.hidden = true; current = null; document.title = document.title.replace(/^📞 /, ""); }

function dismiss(clear) {
  const r = current;
  hide();
  if (clear && r) clearRing(r.chatId, opts.uid, r.ringId);
}

let opts = null;
async function show(ring) {
  if (!root) build();
  if (current && current.chatId === ring.chatId && current.ringId === ring.ringId) return;
  current = ring;
  const caller = await getProfile(ring.fromUid);
  if (current !== ring) return;
  let chatName = "";
  try { chatName = (await get(ref(db, `privateChats/${ring.chatId}/chatData/name`))).val() || ""; } catch (_) { /* ignore */ }
  const self = ring.fromUid === opts.uid;
  root.querySelector(".ic-av").replaceChildren(avatarEl(caller.displayName, caller.pfp, "avatar-lg"));
  root.querySelector(".ic-name").textContent = self ? "Your other device" : caller.displayName;
  root.querySelector(".ic-chat").textContent = self ? "is in a call — join from this device?" : (chatName ? `is calling you in “${chatName}”` : "is calling you");
  root.hidden = false;
  document.title = "📞 " + document.title.replace(/^📞 /, "");
  startTone();
  clearTimeout(ttl);
  ttl = setTimeout(() => dismiss(false), RING_TTL_MS);
  root.querySelector(".answer").focus({ preventScroll: true });
}

/**
 * @param {{uid:string, onAnswer:(chatId:string)=>void, inCall?:(chatId:string)=>boolean}} o
 * @returns {() => void} stop
 */
export function watchIncomingCalls(o) {
  opts = o;
  const off = onValue(ref(db, `live/${o.uid}/rings`), async snap => {
    const all = snap.val() || {};
    const offset = (await get(ref(db, ".info/serverTimeOffset")).catch(() => null))?.val() || 0;
    const fresh = Object.values(all)
      .filter(r => r && typeof r.chatId === "string" && typeof r.createdAt === "number" && Date.now() + offset - r.createdAt < RING_TTL_MS)
      .filter(r => !(o.inCall && o.inCall(r.chatId)))
      .sort((a, b) => b.createdAt - a.createdAt);
    if (!fresh.length) { if (current) hide(); return; }
    show({ ...fresh[0] });
  });
  return () => { off(); hide(); };
}

export const hideIncoming = () => hide();
