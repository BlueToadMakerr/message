// QuickMessage push notifications, run by Firebase itself (no PHP, no InfinityFree request involved).
//  - onMessage : a new message appears in privateChats/{chat}/messages  -> push to the other members' devices
//  - onRing    : a ring appears in calls/{chat}/ringing/{uid}           -> push to that account's devices, then writes notifyStatus
// Deploy: `firebase deploy --only functions` (needs the Blaze plan; the free tier covers normal use). See README "Round 44".
const { onValueCreated } = require("firebase-functions/v2/database");
const admin = require("firebase-admin");
admin.initializeApp();

const REGION = process.env.QM_REGION || "us-central1";
const APP_URL = (process.env.QM_APP_URL || "https://msg.infinityfreeapp.com/").replace(/\/?$/, "/");
const DB = () => admin.database();
const trig = ref => ({ ref, region: REGION, ...(process.env.QM_DB_INSTANCE ? { instance: process.env.QM_DB_INSTANCE } : {}) });
const val = async path => (await DB().ref(path).get()).val();

const isDead = e => {
  const c = e && (e.code || (e.errorInfo && e.errorInfo.code)) || "";
  return c === "messaging/registration-token-not-registered" || c === "messaging/invalid-registration-token" || c === "messaging/invalid-argument";
};

/** Sends one payload to every token of a user; removes tokens FCM says are gone. Returns {accepted, failed}. */
async function pushTo(uid, build) {
  const tokens = Object.keys((await val(`FCM/${uid}`)) || {});
  let accepted = 0, failed = 0;
  await Promise.all(tokens.map(async token => {
    try { await admin.messaging().send({ token, ...build() }); accepted++; }
    catch (e) {
      failed++;
      if (isDead(e)) await DB().ref(`FCM/${uid}/${token}`).remove().catch(() => {});
      else console.warn("push failed", uid, e && e.code);
    }
  }));
  return { accepted, failed, tokens: tokens.length };
}

exports.onMessage = onValueCreated(trig("/privateChats/{chatId}/messages/{msgId}"), async event => {
  const { chatId, msgId } = event.params;
  const msg = event.data.val() || {};
  if (msg.type === "event") return;                                   // system lines ("X changed the colour") never notify
  const from = msg.fromUid;
  const [participants, last] = await Promise.all([val(`privateChats/${chatId}/participants`), val(`privateChats/${chatId}/lastMessage`)]);
  if (!participants || !from || !participants[from]) return;
  const name = (await val(`accsettings/${from}/settings/displayName`)) || "New message";
  const sameAsLast = last && last.id === msgId;
  const encrypted = sameAsLast ? !!last.enc : !!msg._enc || !!msg.enc || !!msg.iv;
  const text = encrypted ? "🔒 New message" : String((sameAsLast && last.text) || msg.text || msg.content || (msg.fileName ? "📎 " + msg.fileName : "New message")).slice(0, 100);
  const link = `${APP_URL}message.html?chatId=${encodeURIComponent(chatId)}`;
  // A photo can be shown in the notification only when it has a public https address (a picture uploaded to a file host, not encrypted).
  // Pictures stored inside the chat are not public, so they cannot be shown in a push (the Android app draws those itself).
  const imageUrl = !encrypted && ((msg.type === "file" && msg.kind === "image" && /^https:\/\//.test(msg.url || "") && msg.url) || (msg.type === "image" && /^https:\/\//.test(msg.content || "") && msg.content)) || null;
  // @mentions: a message that names people is for those people only; without a mention everybody in the chat is notified.
  const only = msg.mentions && typeof msg.mentions === "object" ? Object.keys(msg.mentions).filter(u => participants[u]) : [];
  const mentioned = only.length > 0;
  const title = mentioned ? `${name} mentioned you` : name;
  await Promise.all(Object.keys(participants).filter(u => u !== from && (!mentioned || only.includes(u))).map(async uid => {
    const read = await val(`privateChats/${chatId}/messageRead/${uid}`);
    if (read === msgId) return;                                         // already looking at it
    await pushTo(uid, () => ({
      notification: { title, body: text },
      android: { priority: "high", collapseKey: `chat_${chatId}`, notification: { tag: `chat_${chatId}`, ...(imageUrl ? { imageUrl } : {}) } },
      webpush: { headers: { TTL: "86400", Urgency: "high" }, notification: { tag: `chat_${chatId}`, renotify: true, requireInteraction: false, ...(imageUrl ? { image: imageUrl } : {}) }, fcmOptions: { link } },
      apns: { headers: { "apns-collapse-id": `chat_${chatId}`, "apns-priority": "10" }, payload: { aps: { alert: { title, body: text }, sound: "default" } } },
      data: { link, chatId, ...(imageUrl ? { image: imageUrl } : {}) }
    }));
  }));
});

exports.onRing = onValueCreated(trig("/calls/{chatId}/ringing/{uid}"), async event => {
  const { chatId, uid } = event.params;
  const ring = event.data.val() || {};
  if (!ring.ringId || !ring.fromUid) return;
  const participants = await val(`privateChats/${chatId}/participants`);
  if (!participants || !participants[ring.fromUid] || !participants[uid]) { await event.data.ref.update({ notifyStatus: "failed" }); return; }
  const self = ring.fromUid === uid;
  const name = (await val(`accsettings/${ring.fromUid}/settings/displayName`)) || "QuickMessage";
  const title = self ? "Call in progress" : "Incoming call";
  const text = self ? "Join the call on this device" : `${name} is calling you`;
  const link = `${APP_URL}call.html?chatId=${encodeURIComponent(chatId)}&session=${encodeURIComponent(ring.ringId)}`;
  const r = await pushTo(uid, () => ({
    notification: { title, body: text },
    android: { priority: "high", ttl: 60000, notification: { tag: `call_${chatId}` } },
    webpush: { headers: { TTL: "60", Urgency: "high" }, notification: { tag: `call_${chatId}`, renotify: true, requireInteraction: true }, fcmOptions: { link } },
    apns: { headers: { "apns-priority": "10", "apns-expiration": String(Math.floor(Date.now() / 1000) + 60) }, payload: { aps: { alert: { title, body: text }, sound: "default" } } },
    data: { call: "1", chatId, sessionId: ring.ringId, link }
  }));
  const cur = await val(`calls/${chatId}/ringing/${uid}/ringId`);
  if (cur !== ring.ringId) return;                                      // answered / replaced meanwhile
  await event.data.ref.update({ notifyStatus: r.accepted > 0 ? "sent" : r.tokens === 0 ? "no_token" : "failed" });
});
