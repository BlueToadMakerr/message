// Inline chat events (call started/ended, someone added / left / removed). Stored as ordinary messages of type "event"
// so they sort, paginate and sync like everything else; they never touch lastMessage (no unread dots, no push).
import { db } from "./firebase.js";
import { ref, push, set } from "./sdk.js";

/** ev: { event: 'call_start'|'call_end'|'chat_add'|'chat_leave'|'chat_kick', target?: uid, duration?: ms, text?: string } */
export async function logEvent(chatId, actorUid, ev) {
  const msg = { fromUid: actorUid, type: "event", event: ev.event, text: ev.text || ev.event, timestamp: Date.now() };
  if (ev.target) msg.target = ev.target;
  if (typeof ev.duration === "number") msg.duration = Math.max(0, Math.round(ev.duration));
  try { await set(push(ref(db, `privateChats/${chatId}/messages`)), msg); } catch (err) { console.warn("event log failed", err); }
}
