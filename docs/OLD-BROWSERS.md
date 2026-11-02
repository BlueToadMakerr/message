# Very old browsers (compatibility mode)

The real app needs a modern browser (ES modules, promises, fetch, top-level await, WebRTC). Browsers such as the **Nintendo Wii's Opera 9**, old Internet Explorer or Android 2/4 stock browsers cannot run it, and no amount of patching would make Firebase's SDK work there. Instead there is a separate small client, `legacy/index.html`, written in plain ES3 with tables and a tiny stylesheet.

## What it does
- Log in / sign up, chat list, read and send **plain text**, start a chat by the other person's email. Refreshes by polling (every 3 s in a chat).

## What it cannot do
- Encrypted chats (a Wii has no cryptography API): they show "encrypted" and cannot be read or written. Chats are created unencrypted by default.
- Pictures, files, calls, plugins, notifications.

## Two ways to connect
Old browsers cannot speak today's HTTPS, so the compatibility client has a **Server** box on its login page:
- **Private server** — the address of your [private Python server](SERVER-PRIVATE.md), e.g. `http://192.168.1.20:8080` (plain HTTP works). On the Wii open that address: it detects the browser and opens the compatibility version by itself, using that server.
- **Firebase** — by default the page talks to Firebase **directly** (Google's sign-in REST API + the Realtime Database REST API, with the account's own login token and the normal database rules), so it puts no load on the website host. **Connection → Through proxy.php** uses `proxy.php` in the root of the site instead; the page switches to it by itself if the browser can't reach Google (very old browsers without modern HTTPS). Direct mode still calls `email-lookup.php` once when you start a new chat by email. Direct sending needs a **verified email** (same rule as the app); `proxy.php` bypasses that. The **Firebase database address** box is the real database URL (e.g. `https://your-project-default-rtdb.firebaseio.com`); leave it empty for the default database. `proxy.php` is a small PHP worker that behaves like a private server but stores everything in your Firebase database. You log in with the **email and password** of a Firebase account (no Google sign-in): either create one on the compatibility page, or add a password to your existing account in the normal app. The host must be reachable by the old browser (many free hosts force HTTPS, which a Wii cannot do; then use a private server, or put a plain-HTTP relay in front).
The choice is remembered on the device. On a first visit the page guesses: a QuickMessage Python server answers `/api/ping`, a plain website does not.

`proxy.php` details: it uses the service account in `secrets.php`, checks chat membership itself, makes new chats **unencrypted**, never reads or writes encrypted chats, and a new-chat-by-email only works for verified accounts that allow being added by email (same rule as the app). Notifications for messages sent from here are sent by the Cloud Function as usual.

## Switching
- Automatic: `js/legacy.js` (first script on `index.html`) tests for promises, fetch, URLSearchParams and `<script nomodule>` support. A browser that fails goes to `legacy/`. A browser that passes but whose scripts fail to start gets a "use the compatibility version" bar after 12 seconds.
- Manual: Account → **Compatibility mode** ("use on this device", "switch automatically"), or add `?legacy=1` / `?legacy=0` to the address.
- On the Firebase version, a very old browser is sent to `legacy/` as well and uses `proxy.php` (see above).

## Behaviour
Chat order: chats with a newer message from someone else first, then by last opened; the list is never refetched on its own. Link previews, images and file contents are never fetched (they show as `[image]` / `[file: name]`). One limit: messages sent long ago with media stored inline in the message itself (before media moved to its own node) are still downloaded with the message by the database, which can't skip a field.

Because the proxy path is slow, the client avoids requests: the chat list loads once, the open chat refreshes every 10 s (button: every 5 s at most), the newest 30 messages load first and **Load older messages** fetches 30 more. Sent messages show as "sending..." first; **Delete** (own messages only) asks, then deletes.

## Status
Tested in Chromium with `fetch` and `Promise` removed; **not tested on a real Wii**, and `proxy.php` has only been syntax-checked and exercised for routing/auth (not against a real Firebase project). The lite page avoids ES5+ features (no `let`, arrows, `forEach`, `JSON` assumed) but I could not verify Opera 9's behaviour here. If something misbehaves, the whole client is one file: `legacy/index.html`.
