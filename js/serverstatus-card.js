// Fills <div id="srvStatus"> with whether the notification / bot worker is running (see serverstatus.js). Used on the Account and Bots pages.
import { getServerStatus, ago, STATE_TEXT } from "./serverstatus.js";
const box = document.getElementById("srvStatus");
async function tick() {
  if (!box) return;
  const s = await getServerStatus(), [dot, name, text] = STATE_TEXT[s.state];
  box.className = "srv-status " + s.state;
  box.replaceChildren(Object.assign(document.createElement("strong"), { textContent: `${dot} Notification & bot server: ${name}` }),
    Object.assign(document.createElement("div"), { className: "muted", textContent: text + (s.data && s.state !== "online" ? ` Last seen ${ago(s.age)} ago.` : "") }),
    Object.assign(document.createElement("a"), { href: "status.html", textContent: "Open status page", style: "font-size:.85rem" }));
}
tick(); setInterval(tick, 30000);
