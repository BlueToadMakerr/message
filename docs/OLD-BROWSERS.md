# Very old browsers (compatibility mode)

The real app needs a modern browser (ES modules, promises, fetch, top-level await, WebRTC). Browsers such as the **Nintendo Wii's Opera 9**, old Internet Explorer or Android 2/4 stock browsers cannot run it, and no amount of patching would make Firebase's SDK work there. Instead there is a separate small client, `legacy/index.html`, written in plain ES3 with tables and a tiny stylesheet.

## What it does
- Log in / sign up, chat list, read and send **plain text**, start a chat by the other person's email. Refreshes by polling (every 3 s in a chat).

## What it cannot do
- Encrypted chats (a Wii has no cryptography API): they show "encrypted" and cannot be read or written. Chats are created unencrypted by default.
- Pictures, files, calls, plugins, notifications.

## It needs the private server
Old browsers also cannot speak today's HTTPS, so the compatibility client talks to a server on your own network over plain HTTP: the [private Python server](SERVER-PRIVATE.md). On the Wii open `http://<server-ip>:8080/` — it detects the browser and opens the compatibility version by itself.

## Switching
- Automatic: `js/legacy.js` (first script on `index.html`) tests for promises, fetch, URLSearchParams and `<script nomodule>` support. A browser that fails goes to `legacy/`. A browser that passes but whose scripts fail to start gets a "use the compatibility version" bar after 12 seconds.
- Manual: Account → **Compatibility mode** ("use on this device", "switch automatically"), or add `?legacy=1` / `?legacy=0` to the address.
- On the Firebase version, a very old browser only gets a plain explanation page (the lite client needs the private server's API).

## Status
Tested in Chromium with `fetch` and `Promise` removed; **not tested on a real Wii**. The lite page avoids ES5+ features (no `let`, arrows, `forEach`, `JSON` assumed) but I could not verify Opera 9's behaviour here. If something misbehaves, the whole client is one file: `legacy/index.html`.
