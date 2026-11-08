// Is the notification / bot worker (worker/qm_worker.py) running? It writes serverStatus/{ts,...} every 30 s. Anyone may read that node.
import { activeDbUrl } from "./dburl.js";
import { PRIVATE } from "./mode.js";

export const STALE_SEC = 100;                                // 3 missed heartbeats

/** { state: "online" | "offline" | "never" | "unreachable" | "private", age (seconds since the last heartbeat), data } */
export async function getServerStatus() {
  if (PRIVATE) return { state: "private" };
  try {
    const r = await fetch(activeDbUrl() + "/serverStatus.json", { cache: "no-store" });
    if (!r.ok) return { state: "unreachable" };
    const now = Date.parse(r.headers.get("date") || "") || Date.now();          // the database's clock when the browser may read it
    const d = await r.json();
    if (!d || typeof d.ts !== "number") return { state: "never" };
    const age = Math.max(0, (now - d.ts) / 1000);
    return { state: age <= STALE_SEC ? "online" : "offline", age, data: d };
  } catch (_) { return { state: "unreachable" }; }
}
export function ago(sec) {
  if (sec < 90) return Math.round(sec) + " s";
  if (sec < 5400) return Math.round(sec / 60) + " min";
  if (sec < 172800) return Math.round(sec / 3600) + " h";
  return Math.round(sec / 86400) + " days";
}
export const STATE_TEXT = {
  online: ["🟢", "Online", "Notifications and bot calls are working."],
  offline: ["🔴", "Offline", "The notification server isn't responding, so push notifications, call rings and bot calls will NOT work until it is back. Chat itself still works."],
  never: ["⚪", "Not set up", "No notification server has reported in yet (see worker/README.md). Until one runs, push notifications and the bot API don't work."],
  unreachable: ["🟠", "Can't check", "Couldn't reach the database to check the server."],
  private: ["⚪", "Private server", "This device uses a private server, which sends its own notifications and runs the bot API."]
};

const NOWARN = "qm-srv-nowarn";
export const warnHidden = () => { try { return localStorage.getItem(NOWARN) === "1"; } catch (_) { return false; } };
export const hideWarning = () => { try { localStorage.setItem(NOWARN, "1"); } catch (_) { /* ignore */ } };

/** Asks whether the notification worker is up; when it is not, tells the person that notifications can fail for other people too. */
export async function checkNotificationServer(show, last = {}) {
  const s = await getServerStatus();
  const bad = s.state === "offline" || (s.state === "never" && !warnHidden());
  if (bad && !last.warned) {
    show(s.state === "offline"
      ? `The notification server is offline (last seen ${ago(s.age)} ago). Notifications can fail, including for other people: they may not be told about your messages or calls until it is back. Chatting still works.`
      : "No notification server is running, so push notifications aren't being sent. They can fail for other people too: they may not be told about your messages or calls. (Using Firebase Cloud Functions instead? Open Account to hide this.)");
  }
  last.warned = bad; last.state = s.state;
  return s;
}
