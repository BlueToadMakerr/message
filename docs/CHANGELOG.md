# Changelog

Newest first. Older rounds (1–43) are kept below exactly as they were written.

## 1.51.0 — Android: push instead of a standing connection; notification threads always match the chat

- **Android no longer keeps a connection open for notifications.** The app registers for Firebase Cloud Messaging push (token stored at `FCM/{uid}/{token} = "android"`). When a message or call arrives, the Cloud Function (`functions/index.js`) sends a **data-only, high-priority push**; the app wakes for a moment, makes the few plain requests it needs (sender, thread, picture, decrypting) and shows the full notification itself (names, pictures, reply, mark-as-read, bubbles, full-screen call alert). Then it goes back to sleep: no stream, no polling, no wake lock, no permanent "Listening" notification, and no battery-optimisation prompt.
- **It falls back to the old live connection** (so nothing breaks) when push can't work: the build has no `google-services.json`, the phone has no Google Play services, the token isn't registered yet, or a private server is used.
- **Fixed: notification threads that didn't match the chat.** The thread shown in a notification used to be loaded once and then only grew with the notifications that happened to arrive, so a missed notification, a message that came in while the app was open, or a reply typed in the app left it wrong (or showing only your reply). The thread is now rebuilt from the database (newest messages, yours included) every time. If you already read the newest message, or the newest message is yours (answered in the app or on another device), the notification is removed instead of being shown. A bubble stays but is refreshed. Replying from a notification now also marks what you answered as read.
- The app is told when you send or read something in a chat (`QMApp.chatSync`) and when you leave the app, so a notification or bubble left behind is refreshed or cleared.
- Needs: `google-services.json` for package `app.quickmessage.chat` (Firebase console → Project settings → Your apps → add Android app) saved as the GitHub secret **`GOOGLE_SERVICES_JSON`** (paste the JSON, or its base64), and **`firebase deploy --only functions`** plus the new `database.rules.json` (the `FCM` node now also accepts `"android"`). See docs/APPS.md.
- **iPhone is unchanged.** Real push on iOS needs APNs, which needs a paid Apple Developer account and a different build setup; without it iOS keeps using the in-app keep-alive.

## 1.50.0 — Friend codes replace UIDs

- **Adding someone by UID is gone.** In "New chat" and "Add someone" you now paste a **friend code** (like `QM-K7R2D-9WBX4`) or an email address. Typing is forgiving (any case, spaces instead of dashes, without `QM`).
- **Friend codes are random, not derived from anything.** They use another alphabet and shape than the encryption **recovery code** (5 groups of 4), so the two can't be confused, and they are unrelated to your UID. Everyone gets one automatically the next time they open the app.
- **Account → Friend code**: copy your code, **switch it off** (it stops working until you turn it on again), make it **private** (public by default), or **make a new code** (the old one stops working immediately).
- **Copy button in the member list**: the old "Copy UID" button is gone. Another person's row only has a copy button if they made their friend code public (and it is on). Your own row always has one.
- Database: new nodes `friend/{uid}` (only you can read it), `friendCodes/{code}` (lookup; can't be listed, only asked for one code; you can claim a free code for yourself and release only your own) and `friendPub/{uid}` (your code while it's on and public). Deleting your account removes them. The private server enforces the same rules.
- **Deploy: publish the new `database.rules.json` to Firebase** (Realtime Database → Rules). Until you do, friend codes can't be created and nobody can be added by code (email still works).
- Plugin templates that used the panel now open on a button press: **Message counter** and **Quick replies** add a button to the chat header and open a window (Quick replies lets you save your own), and the **Call timer** banner is toggled from a button on the call screen. `qm.ui.open` has a new `reset: true` option that clears typed values.
- The Legacy page only ever added chats by email, so nothing changed there.

## 1.49.0 — Plugin windows, message-menu items, call banners, add by URL

- **Fixed: plugin panels and banners were unreadable in dark mode and always floated in the bottom-right corner.** They used a colour variable the site never defined. They now use the site's own theme colours. The old floating panel is gone: `qm.panel.set` now opens a window (a sheet on phones, a card on wide screens) that you can close with ×, Escape or a tap outside.
- **New: `qm.ui` windows** (permission `ui`). A plugin describes a window as blocks (`heading`, `text`, `kv`, `badge`, `input`, `toggle`, `select`, `progress`, `list`, `image`, `button`, `buttons`, `divider`) and the site draws it, so every plugin looks like the rest of the app and cannot inject its own HTML. `qm.ui.open / update / close / list`, plus `qm.ui.confirm` and `qm.ui.prompt` (the site's own dialogs). Events `ui-action` (with all field values) and `ui-close`. Images only from https or data URLs.
- **New: `qm.messageMenu`** (permission `menu`): add up to 8 choices to the "⋯" menu of every message (`add / remove / clear / list`; options `mine`, `textOnly`, `danger`, `icon`). The `menu-click` event carries the message; its text is included only if the plugin also holds `messages`.
- **New: call and chat banners.** `qm.banner.show({where: "app" | "call" | "chat", kind: info/success/error/warn, dismiss})`, `qm.banner.hide({where})`, `qm.banner.clear()`. Call banners are drawn on the call screen and come back if the page reloads.
- **New: add a plugin by URL.** Plugins page → "Add from URL…". Paste a link to a plugin .json file (GitHub page links are converted to raw links). You see its name, author and permissions first, it is added switched off, and its address is kept for update checks. https only (http for localhost). The host site must allow cross-site reading (GitHub raw and jsDelivr do).
- New templates: Notes window, Message menu, Banner on calls.
- Plugin API number stays 1 (additive); set `minSite` to 1.49.0 when you use these.

## 1.48.0 — Many more plugin functions; disabling a plugin works at once

- **Fixed: switching a plugin off did not fully switch it off until Developer mode was toggled.** The Plugins page asked the host to "start all enabled plugins", which never stopped the disabled ones. The host now makes what is running match what is saved: switched-off, deleted or blocked plugins are stopped (and everything they put on screen is taken back: CSS, panels, banners, buttons, hidden elements, the page title, shortcuts, commands, timers), edited ones restart, new ones start, unchanged ones are left alone.
- **New plugin functions** (additive: the plugin API number stays 1; set `minSite` to 1.48.0 when you use them). Five new permissions: `send`, `clipboard`, `notify`, `keys`, `commands`.
  - Messages: `qm.messages.list / find / get / jump / reply` (the messages loaded in the open chat, with sender, type, time, reply and edited state).
  - Chat: `qm.chat.getText / setText / clearText / focus / list / info / send`.
  - Slash commands: `qm.commands.*` and the `command` event (`/name args` is handed to the plugin instead of being sent). Shortcuts: `qm.keys.*` and the `key` event.
  - Look and feel: `qm.style.vars / sheet / removeSheet / get`, `qm.banner.show / hide`, panel `progress`, `qm.notify`, `qm.vibrate`, `qm.clipboard.write`.
  - More page control: `qm.page.waitFor / text / attr / count / focus / press / select / check / hide / show / title`.
  - Helpers that need no permission: `qm.every / after / now`, `qm.util.*`, `qm.bus.emit / on` (plugins talking to each other), `qm.app.info`, `qm.plugins.list`, `qm.storage.keys / clear / usage`.
  - New events: `command`, `key`, `banner-button`, `bus`, `online`, `offline`, `visibility`, `theme-change`.
  - Safety: sending is rate limited (5 per 10 seconds) and announced with a notice; shortcuts need ctrl/alt/meta and cannot take browser shortcuts; commands and shortcuts belong to one plugin each.
- Two new templates (slash commands + shortcut, copy my messages), documentation in `plugin-docs.html`.

## 1.47.3 — Uploads survive closing the app (Android), speaker fix

- **Android: closing the app no longer cancels an upload.** If you swipe the app away while a file is uploading, the page that is doing the upload is kept running quietly in the background (the "Uploading a file" notification stays), and it is released as soon as the upload is done (or after 30 minutes). When you open the app again, the chat shows the file as an uploading message with its percentage, and the chat list shows "Uploading". Both pages share what they are uploading through `localStorage` (`qm-up:*`), and the upload notification adds the pages up.
- **An upload that was cut off is reported.** If the page that was uploading is gone (the app was force-stopped, or on iPhone), the next start tells you which file was not finished so you can send it again.
- **iPhone:** an upload keeps going when you switch to another app (as before) and the chat still shows it uploading when you come back. iOS does not let a web page keep uploading after the app is swiped away in the app switcher, so the upload notification now says so.
- **Android: calls start on the speaker again.** Android's call system (Telecom, added with Android Auto support) reset the sound to the earpiece when the call became active; the app now asks Telecom for the speaker (and for whatever output you pick) as well, and uses the Android 12+ routing API for the starting speaker.

## 1.47.2 — Scrolling fix

- **Chat scrolling no longer jumps when pictures, videos or link previews load.** The browser's own scroll anchoring is off for the message list (it was fighting the app's correction and moving things twice), and the app now keeps the message you are reading exactly where it is on screen whatever grows above it or inside it. At the bottom it stays at the bottom, and "am I at the bottom" is no longer flipped by the growth itself. The chat also stays at the bottom when its area changes size (keyboard, composer growing, rotating).

## 1.47.1 — Legacy talks to Firebase directly

- **Legacy (compatibility) page, Firebase mode: direct connection.** Sign-in, chat list, messages, sending, deleting and starting chats now go straight from the browser to Google/Firebase with the user's own token under the normal database rules, so the website host (InfinityFree) is no longer hit for every refresh. `proxy.php` remains as a selectable "Connection" option and as an automatic fallback when the browser can't reach Google; `email-lookup.php` is still used once per new chat.
- Auto refresh is now every **10 seconds** (manual refresh still limited to once per 5 s).
- Direct sending needs a verified email (the database rules require it); the failed-message line says so.

## 1.47.0 — Round 47

- **Swipe to reply.** Swipe a message to the right (touch screens) and it starts a reply; the row follows your finger, buzzes once at the trigger point and springs back. Vertical scrolling is untouched and the first 24px from the screen edge are ignored so the back gesture still works.
- **@mentions.** Type `@` in the composer to get a picker of the chat's people (plus `@everyone`); arrows/Enter/Tab/Esc or tap to pick. Mentions are highlighted while typing and shown as pills in messages, and messages that mention you get a glow.
- **Targeted notifications.** If a message mentions people, only they are notified ("Name mentioned you"). No `@` (or `@everyone`) still notifies everyone, as before.
- Mentions are stored as a plain `mentions` map (uids) even in encrypted chats; the message text stays encrypted.
- **You must:** republish `database.rules.json` and redeploy Cloud Functions (`firebase deploy --only functions`) for mention-only push. Private server needs nothing.

## 1.46.0 — Round 46

**Android Auto** (Android app): messages read aloud with voice reply and mark-as-read; calls registered with Telecom so the car can show, answer, decline, hang up and mute them. Not compiled or tried in a car here. See [APPS.md](APPS.md).

**Plugins**: new permissions `page`, `buttons`, `calls`, `devinfo`. Plugins can now read what is on screen and click / type / scroll (`qm.page`), search a chat by scrolling until a message is found (`qm.page.scrollUntil`, loads older messages on the way, with a Stop button), add their own buttons to the chat header, chat list or call controls (`qm.buttons`), follow calls (`qm.calls.state`, `call-state`), read developer info (`qm.dev.read`) and add their own cards to the developer views for the app, a chat, a message and the call stats (`qm.dev.addCard`), ask the user a question (`qm.ask`), open a chat (`qm.chat.open`). Three new templates in the editor. Docs: [PLUGINS.md](PLUGINS.md), plugin-docs.html.

**Fixes**
- Plugins page showed "Still loading… your connection looks slow" forever, because the page never told the app it had loaded; fixed. The plugin docs page had no such signal either, and its table-of-contents links added browser history entries, so Back could land on the docs again; same-page links no longer touch history in any embedded page.
- Messages sent from the compatibility client (proxy.php), and in private-server mode, got ids one character too long that sorted before every real message, so they showed up above the older messages in the normal app and in the next refresh. New messages now get proper 20-character ids. Messages already sent with the wrong id stay where they are.

## 1.45.0 — Round 45

**Private servers everywhere**
- Android and iOS apps can use a private Python server: new input box on the login page (**Use a private server instead of Firebase**), also available in the plain web page. The server got a Firebase-REST look-alike (`/db/<path>.json`, including streaming) so the native notification code works unchanged.
- The compatibility (legacy) client has a **Server** box: a private server address, or **Firebase through `proxy.php`**.
- New `proxy.php`: a PHP worker on the website host that answers like a private server but uses the Firebase database. Email + password accounts only (no Google sign-in), unencrypted text chats.
- Very old browsers on the Firebase site are now sent to the compatibility client too.

- Fix: `proxy.php` now reports PHP/database/token problems as a readable message instead of a bare HTTP 500, and the compatibility page shows it. The worker is now called `proxy.php`; its address box is blank by default (= `proxy.php` in the site root); the database is the normal app's (default, or the one picked there). No `curl_multi` needed (free hosts disable it).

- Compatibility client made calmer and clearer: a "Working..." bar shows while anything is loading (and says so when the server is slow); your message appears at once as grey "sending..." and turns normal when stored (failed ones offer Try again / Remove); **Delete** on your own messages turns the message red to confirm, orange while deleting, then removes it; the chat list loads once (no last message, "Reload chats" button); messages refresh by themselves every 15 seconds plus a **Refresh** button that waits 5 seconds between uses; **Load older messages** at the top of a chat. New `lite/delete` route and `before` / `more` on `lite/messages` in both the Python server and `proxy.php`. Messages deleted by someone else show until the next full open of the chat.

- Compatibility client, lighter on the database: the chat list is fetched once and kept in memory (going back from a chat never refetches; only "Reload chats" or reloading the page does). Order: chats with a new message from someone else come first (newest first), then the rest by the chat you opened most recently. Only the time and sender of the last message are read for this, never its content; no link previews and no file/media data are fetched. The Firebase mode now always uses `proxy.php` in the root of the site (not changeable) and has a **Firebase database address** field (empty = the default database). `proxy.php` caches names and chat membership for 10 minutes, and the page skips its 15-second refresh while the tab is hidden.

**Suggestions**
- Account → Suggest a feature now also has a **Suggest on GitHub** link (https://github.com/BlueToadMakerr/message) next to the email option.

**Honest notes**: Android/iOS changes and `proxy.php` against a real Firebase project were not run here; the web parts and the Python server were tested.

## 1.44.0 — Round 44

**Notifications and the host**
- Push notifications are now sent by **Firebase Cloud Functions** (`functions/`), triggered by the database itself. Nothing on the website host (InfinityFree) takes part any more, so notifications and ringing also work from an offline copy of the site. `notify.php`, `call-notify.php` and the "browser check" solver (`js/challenge.js`) are gone.
- Ringing shows "Notification sent / failed" from the status the function writes to the ring.
- Site address is now `https://msg.infinityfreeapp.com/` (apps, `config.php`, docs). Add the domain to Firebase → Authentication → Settings → Authorized domains.

**Less database usage**
- Photos, clips and voice notes live in `privateChats/{chat}/media/{id}`, not inside the message. Opening a chat downloads small message records; a picture is fetched when it scrolls into view and cached on the device (Cache Storage). New rule block `media` in `database.rules.json`: **redeploy the rules**.
- Pictures are re-encoded as WebP (JPEG fallback) aiming at about 300 KB instead of up to 2.8 MB.
- One listener for a chat's name / photo / encryption flag instead of three (chat list and chat page); the chat list's `get()` no longer downloads the list twice.
- Contact profiles are cached on the device for 15 minutes.
- Android background check is one small request per minute (was one per chat every 15 seconds).
- See [DATABASE-USAGE.md](DATABASE-USAGE.md).

**Notifications with pictures**
- Chrome / Edge / Android Chrome web push show the picture when it was uploaded to a public file host and the chat is not encrypted. The Android app shows any photo (also from inside the chat, also encrypted ones it can open) as a large picture. Safari / iOS web push and the iPhone app cannot (needs an Apple notification extension, not included).

**Private server mode**
- `server/qm_server.py`: a stand-alone Python server (standard library only) that replaces Firebase and hosts the site. Works fully offline. See [SERVER-PRIVATE.md](SERVER-PRIVATE.md).
- Features that need Google or the internet are hidden in that mode (Google sign-in, e-mail verification and reset, link previews, file hosts, app downloads, push).

**Very old browsers**
- `legacy/` is a small ES3 text chat (Nintendo Wii / Opera 9, old IE, old Android) used automatically on browsers that can't run the app, or by hand (Account → Compatibility mode, `?legacy=1`). See [OLD-BROWSERS.md](OLD-BROWSERS.md).

**Developer mode**
- Plugins: sandboxed scripts with permissions (Account → Developer → Plugins), a detailed docs page (`plugin-docs.html`), outdated / too-new warnings and update checks. See [PLUGINS.md](PLUGINS.md).
- Site version (`js/version.js`, `version.json`): checked on load and every 30 minutes, with a "new version" bar and a version line in Account.

---

# History (rounds 1–43)

## What's new

- **Typing indicators** — "typing…" in the chat header, animated dots in the thread, and live "typing…" in the chat list.
- Redesigned UI: responsive chat bubbles, light / dark / match-device theme (`dark.css` is gone — one `style.css` handles all three), modal dialogs and toasts instead of `alert()`/`confirm()`/`prompt()`, avatars with initials fallback, unread dots, chats sorted by latest activity, jump-to-latest button, auto-growing composer (Enter sends on desktop), message copy / edit / delete menu.
- Real `manifest.json` + icons (the manifest used to be an inline data URI).
- Code split into small modules in `js/`.

## Bugs fixed

**Crashes / broken features**
- `account.html` crashed on load (`info.theme` was undefined → should have been `data.theme`) and referenced `darkThemeToggle` before it was defined.
- `message.html` had duplicate `#popup` / `#overlay` ids, so the "add user" confirmation popup never worked properly.
- New sign-ups and Google logins never got a profile record, which produced "User does not exist" errors and broken chat rows for everyone who chatted with them. A profile is now created automatically.
- Message authors showed as "Unknown" if they rendered before the participant list finished loading.
- Image/video messages never updated the chat-list preview or sent notifications.
- Videos up to 20 MB were allowed, but Realtime Database rejects writes that large once base64-encoded — limit is now 8 MB, and images are resized/compressed in the browser first.
- Editing a message changed its timestamp, so it jumped to a new position on reload. Edits now set `editedAt` instead.
- Deleting the newest message left the deleted text in the chat-list preview.
- The page attached `child_*` listeners to the whole `messages` node, which downloaded the entire history and defeated pagination. Listeners now cover only the loaded window.
- Every send downloaded the entire message history to compute the next numeric id (slow, and racy when two people send at once). Messages now use Firebase push ids.
- Read receipts used `Number(key)`, which breaks for push ids; receipts now store the key as-is (old numeric receipts still match). Receipts no longer show "Read by" yourself, and a single-message chat is now marked read.
- Starting a chat with someone you already chat with created a duplicate; it now opens the existing chat.
- `getToken()` ran on page load and could pop the notification permission prompt unprompted; it now only runs silently if permission was already granted.
- Deleting an account failed with `requires-recent-login` and didn't clean up data; it now re-authenticates, leaves your chats, and removes your records first.
- Service worker used `/icon.png` (404); the `notificationclick` link logic was fragile.

**Security**
- **XSS**: message text, chat names and display names were injected with `innerHTML` and a regex "sanitizer". Everything is now built with DOM nodes / `textContent`, links are only auto-linked for `http(s)`, and media URLs are allow-listed.
- **`notify.php` trusted a `?uid=` query value**, so anyone could pretend to be any participant. It now verifies the caller's Firebase ID token.
- **Hard-coded admin e-mail + password removed** — the service account is used for database access instead.
- The "already notified" flag is now an atomic conditional write (previously two quick requests could both send).
- Only truly dead FCM tokens are deleted (`INVALID_ARGUMENT` used to wipe tokens on any payload error).
- Pinch-zoom is no longer disabled (accessibility).

## ⚠️ Do this after deploying

1. **Rotate your credentials.** The old `notify.php` contained the service-account private key *and* the admin account's password in plain text, and both have now been pasted into chat tools. Treat them as exposed:
   - Firebase console → Project settings → Service accounts → generate a new private key, delete the old key, and paste the new values into `secrets.php`.
   - Change the password of `adminaccount@admin.com` (or delete that user — nothing uses it any more).
2. Upload `secrets.php`, `config.php`, `notify.php`, `.htaccess` together. `secrets.php` is a PHP file that only `return`s an array, so it can't be downloaded as text even if `.htaccess` isn't honoured.
3. **Replace your Realtime Database rules** with the contents of `database.rules.json` (Firebase console → Realtime Database → Rules → Publish). It keeps your admin override and the same overall model, plus:
   - the typing indicator and read receipts are covered (members write only their own);
   - `accsettings` is readable only by signed-in users (was: anyone on the internet), `participants` is no longer world-readable;
   - you can no longer push a chat into a stranger's list — the other person must already be a member;
   - members can only edit/delete their own messages, and can only post as themselves;
   - a chat can only be created if you're in it, and deleted only by a member (rules can't count members, so the "last one out" check is done by the app);
   - `chatList/$uid` and `FCM/$uid` are writable by their owner as a whole, which account deletion needs;
   - basic type/length validation on profile, chat name, messages and `lastMessage`.

   After publishing, try the Rules Playground once or just send a message, edit it, delete it, and start a new chat to confirm. Keep `".indexOn": ["timestamp"]` on `messages` (already in the file).
4. Hard-refresh once (or unregister the old service worker) so devices pick up the new `firebase-messaging-sw.js`.

## Notes

- Notifications need HTTPS; on iOS the site must be installed to the home screen first.
- Photos/videos are stored inline in the database (as before). That's fine for a tiny app but will grow your DB quickly; a storage bucket would be the next step if usage grows.
- `notify.php` caches its short-lived Google access token in the system temp dir to avoid a token request on every message.

## Group calls (`call.html`)

Open `call.html?chatId=<chatId>`. Everyone in the chat shares one call; whoever opens the page can join, others can be rung from the People panel.

**Wire the button.** In `message.js`, once `chatId` is known:
```js
document.getElementById('callBtn').href = `call.html?chatId=${encodeURIComponent(chatId)}`;
```

**Files:** `call.html`, `call.css`, `js/call.js` (orchestration), `js/call/` — `signal.js` (Firebase sessions + inbox), `mesh.js` (WebRTC perfect negotiation per peer), `media.js` (mic/camera/screen), `tile.js`, `layout.js`, `ring.js`, `rtc-config.js`, `device.js`. Also changed: `js/ui.js` (new icons), `style.css` (old call CSS removed), `call-notify.php` (allows ringing your own other devices), `firebase-messaging-sw.js` (call rings persist and aren't swallowed by an open chat tab), `database.rules.json` (new `calls` section — merge it into your live rules).

**How it works**
- Each device/tab is its own *session* (`calls/{chatId}/sessions/{sessionId}`), so one account on a phone and a laptop is two participants (the second is labelled "Your other device"). Leaving on one device leaves the other in the call.
- Signalling goes through `calls/{chatId}/inbox/{uid}/{sessionId}/…` and is deleted once read, so stale offers/answers can't be replayed. Every link has an epoch; messages from an older epoch are dropped, which removes the "Called in wrong state: stable" class of error. Screen sharing renegotiates cleanly and appears as its own tile.
- Sessions heartbeat every 15 s; dead ones (>120 s) are removed by any member. A dropped network re-registers the session and rebuilds the links.
- It is a full mesh: great for 2–4 people, usable to ~6. For anything bigger you'd want an SFU.
- **TURN:** `js/call/rtc-config.js` only has public STUN. Add a TURN server there for users behind strict NATs/corporate networks — without one some pairs will show "Connection failed".


## App shell, persistent calls, split view (added with the call upgrade)

`index.html` is now the **shell**: chat list on the left, the open chat (`message.html`) or account page on the right (≥ 900 px wide; on phones the chat covers the list). Opening `message.html`, `account.html`-style deep links or `call.html` directly still works — they forward into the shell (`?chat=<id>`), unless you add `&standalone=1` (handy for debugging).

- **Calls survive navigation.** The call runs in its own iframe layer inside the shell. The arrow on the call screen *minimises* it: a green "in call" bar (mute / return / leave) appears at the top and you can open other chats. Hanging up returns to that chat's room.
- **Incoming calls** are shown full-screen on whatever page you're on (`js/incoming.js`, fed by `callRings/{uid}/{chatId}`, which `ring.js` writes next to `calls/{chatId}/ringing/{uid}`). Background push (`call-notify.php` + service worker) covers the app being closed. **Re-publish `database.rules.json`** — it has the new `callRings` section.
- Chat page shows a Discord-style **"Call in progress · 3 people · 12:34 · Join"** strip; the call screen shows the running duration.
- In the call: chat panel (same messages as the chat room), speaking glow, per-tile volume up to 200 %, own screen-share preview tile, mic/camera on/off remembered per browser (`localStorage`: `qm-call-mic`, `qm-call-cam`), controls fade with the cursor when the mouse rests, join/leave toasts.
- New files: `js/shell.js`, `js/embed.js`, `js/incoming.js`, `js/call/audio.js`. Changed: `index.html`, `message.html`, `style.css`, `js/index.js`, `js/message.js`, `js/account.js`, `js/call.js`, `js/call-banner.js`, `js/call/{tile,media,ring,mesh}.js`, `call.css`, `firebase-messaging-sw.js`, `database.rules.json`.
- Limits: reloading the page ends the call (it lives in the page). Volume above 100 % uses WebAudio gain, so very quiet sources can sound noisy.


## Chat upgrades (files, events, read markers)

- **Files via Litterbox.** Any file can be sent. Photos/videos that are too big to store in the database, and every non-media file, are uploaded to Litterbox with a 72 h expiry (the maximum) and a random 16-character name; the chat shows a notice first. The message stores the link, original name, size and expiry, shows the expiry under the file, displays images/video/audio inline, and greys the file out once expired. If the browser can't reach Litterbox directly, `upload.php` (needs `config.php`'s `api_key`) is used as a proxy. Re-publish `database.rules.json` (new message types/fields).
- **Camera:** the "Camera" button opens a live preview in-page to take a photo (falls back to the system camera picker on old browsers).
- **Inline events:** call started / ended (with duration), someone added, left or removed — stored as `type: "event"` messages; they never change the chat's last-message preview or send pushes.
- **Read markers:** every member's avatar sits under the last message they read (on anyone's messages and on events).
- **History paging** now pages by message key instead of the timestamp field, so older messages that have odd/missing timestamps no longer end the history early.
- **In a call:** the chat button opens the real chat page in a panel; the unread badge counts messages newer than your last-read marker. Streams are really pinned when they start (unless something is already pinned), videos have a pop-out (picture-in-picture) button and no browser right-click menu, and the minimised call bar shows participants' avatars with mic / camera / screen-share controls.
- Call links and notifications now carry a one-shot, short-lived token, so reloading, restoring a tab or pressing Back can't start a call by itself; the app's iframes are navigated with `location.replace` so Back no longer leaves a blank white pane on mobile.

## Sending, uploads and notifications (latest round)

- **Pending messages.** Everything you send (text, photos, videos, files, links) first appears as a grey copy of what it will
  look like. Litterbox uploads show `Uploading… NN%` where the expiry text will later appear. When the send is acknowledged the
  grey copy is swapped for the real message.
- **Failures.** A failed send turns red, shows "Failed to send", still raises the error toast, and the "more" button becomes an
  alert icon with **Retry / See error / Cancel**. Retry reuses the same message key, so it can never post twice; an upload that
  already finished is not re-uploaded.
- **Litterbox CORS.** Litterbox answers CORS preflights (`OPTIONS`) with 405, and any `xhr.upload.onprogress` listener forces a
  preflight. So: files that fit `upload.php` (its `post_max_size`/`upload_max_filesize`, reported by `upload.php?limits`) go
  through the same-origin relay, which gives a real progress percentage. Bigger files are posted straight to Litterbox as a
  *simple* request (no preflight); browsers can't report progress for that path, so it shows an animated "Uploading…".
  Each route falls back to the other. `upload.php` now returns readable errors (size limits, missing token, …).
- **Toasts are global.** Pages inside the app shell hand their toasts to the top page (`window.__qmToast`), so they stack in
  one place instead of overlapping inside iframes.
- **In-call chat** is loaded the first time you open it, then kept alive (hidden) so closing/reopening doesn't reload it. While
  hidden it doesn't mark messages as read.
- **Back.** The call arrow and the browser Back button just minimise the call and leave you where you were (chat, account page…).
  Hanging up still takes you to the call's chat.

## Call length, frame watchdog and the Android companion (latest round)

- **Call length** now comes from `calls/{chatId}/startedAt`, written by the first person into an empty call and cleared by the last one out, so it no longer resets when the person who started the call leaves. (New rule in `database.rules.json`.)
- **Frame watchdog** (`shell.js`): every embedded page calls `markReady()` once it has booted. If it doesn't within 15 s the shell reloads that frame (3 tries, cache-busted), then shows a "This page didn't load / Try again" panel instead of a white screen. If the call page disappears while you're in a call, the shell reloads it and the call page rejoins by itself (max 3 recoveries per 2 min). A frame that ends up showing the app shell inside itself is sent back to what it should show.
- **Android companion**: see `android/README.md`. Website side: Account, *Android companion* (`js/companion.js`).

## Android app, site fixes (latest round)

**Android app** (`android/`): the companion/pairing idea is gone. The app is the website in a WebView plus native screen sharing,
message notifications, full-screen incoming-call alerts, bar colours and a cache refresh button (Account → App). See `android/README.md`.
The `companion*`/`pairings` database rules and `js/companion.js`, `js/phone-call.js` were removed; **publish the new `database.rules.json`**.

**Site**
* Chat history: a short page no longer means "beginning of the conversation"; only an empty page does, so older messages keep loading.
* Messages aren't marked read while the full-screen call covers the chat (the call's own chat panel still marks its messages).
* Leaving and rejoining a call no longer shows a false "Your other device left the call", and a fresh join is never "recovered" mid-load by the frame watchdog.
* The browser's top bar (`theme-color`) and the app's status/navigation bars follow the app background (`js/bars.js`), including in the call.
* Group chats can have a photo (Chat options → Group photo, an image URL): `privateChats/{chat}/chatData/photo`.
* Call rotation: the call layout follows the device orientation (app: sensor rotation enabled).

## App round 2 (insets, calls in the background, notifications)
* **Edge to edge:** the page draws under the status/navigation bars and keeps clear via `--sat/--sab` (set by the app, `js/bars.js`), so both bars show the site background and the green call bar no longer overlaps the chat header (`--bar-h` includes the top inset).
* **Calls in the background:** while a call is up the WebView is never paused and the foreground service holds the camera/microphone types, so media survives leaving the app. Android's own Picture-in-Picture is used (pop-out button, and automatically when you leave the app mid-call). Fullscreen works through the WebView's custom-view support.
* **Screen share:** frames are now forwarded into the call iframe (the app evaluates in the top window).
* **Back / blank pages:** Android Back asks the site (`QM.androidBack`: minimise call, close chat, else background the app) instead of walking WebView history. Same-origin links inside frames replace rather than push history. The shell restores any frame that shows `about:blank`; the call frame is only restored when it really is blank (a live call is never touched).
* **Notifications in the app:** the bell toggles the app's own listener (no web push in a WebView). Calls raise a full-screen alert.
* Calls report this device as **App on Android**.

## Round 3: offline page, navigation rewrite, theme, PiP
* **Offline page** (`offline.html`): shown by the service worker when a page can't load without a connection (PWA), and bundled in the Android app (`assets/offline.html`) for WebView load errors. It maps common `net::` errors (offline, timeout, refused, DNS, SSL…) to friendly text; an error it doesn't know shows the raw `net::ERR_…` code. A red banner appears whenever the device goes offline, and slow loads show "Still loading…" (`js/bars.js`).
* **Navigation rewrite** (`js/shell.js`): one controller owns history. Each entry stores the whole view `{chat, pane, call}`; browser Back and Android Back both restore the previous view instead of going back inside a frame, so frames can't leak into each other or turn into `about:blank`. Opening the call you're already in never reloads it. Frame links use `replace()` and frames never push history.
* **Theme:** changes apply instantly to the page and all frames (BroadcastChannel). In the app, *Match my device* follows Android's own light/dark setting.
* **PiP:** a tile's pop-out button pops out *that person's* video (in the app the window takes the video's aspect ratio and follows it as it changes); the new dock button pops out the whole call (Android PiP in the app, Document Picture-in-Picture in browsers that have it).
* **App:** no text highlighting; side/bottom margins follow rotation; bell turns red when Android blocks notifications (tap opens settings); Google sign-in runs in the browser via `app-login.html` and returns through `quickmessage://auth`; the WebView is never paused, the service holds a wake lock and the app asks once for battery-optimisation exemption so the connection stays up.
* Other users' messages now have a "more" button with Copy.

## Round 5

- **Calls breaking after Back** – root cause: every history entry remembers what each iframe showed, so going Back re-navigated the call
  frame to an old `call.html` (which silently rejoined an ended call). `navFrame()` now swaps in a brand-new, uniquely named iframe
  instead of navigating in place, so no history entry knows about it. Covers the notification (`call.html?…&session=`) path as well.
- **Pop-out** – a person's pop-out is only their video; the tile shows a "Popped out · Bring back" panel; Android PiP shows the video + name chip.
- **Rear camera** is no longer mirrored (only front/unknown cameras are).
- **Android** – layered adaptive icon (background, foreground with shadow, monochrome) from the web logo; screen share follows rotation
  (`VirtualDisplay.resize` + new `ImageReader`).
- **Offline banner** pushes the layout down (`--off-h`) instead of covering it.
- **Margins** – frames only pad for a screen edge they actually touch (not below the call bar/offline banner, never in the call chat panel).
- **Android install button** (`app.apk`) shown on Android browsers, not inside the app.

## Round 6

- **PiP (Android)**: a person's pop-out button now pops out only that person (the "single tile" mode was being cleared before Android reported PiP);
  the PiP window takes that video's aspect ratio and follows it; the dock button pops out everyone (ratio reset to 16:9).
- **PiP (web)**: the dock button uses the top window's Document Picture-in-Picture API (it errored from inside the call iframe).
- **Call notifications** are real incoming-call notifications (`Notification.CallStyle` on Android 12+, Answer/Decline actions before): ringtone
  loops, they can't be swiped away, Answer opens the call, Decline dismisses it and clears the ring in the database.
- **Message notifications** use MessagingStyle: recent history in the shell, plus an inline Reply that posts straight to the chat.
- **Chat list / chat loading**: "Loading…", then a "taking longer than usual" hint, and an offline / "problem" state with Try again — "No chats yet" only appears once the list really arrived empty.
- **Android screen share audio** (Android 10+): other apps' sound is captured (QuickMessage's own call audio is excluded to avoid echo) and sent as the screen-audio track.
- **Scrolling up in long chats**: older pages are throttled, don't chain, and media loading in older messages no longer shifts the view or yanks to the bottom.

## Round 7 — encryption, previews, protection, verification, connections

**Deploy:** upload the new PHP files (`lib.php`, `link-preview.php`, `email-lookup.php`, `fetch-file.php`, `mark-verified.php`) and the changed `notify.php`; give the service account the *Identity Toolkit* permission (email lookup / mark-verified); **republish `database.rules.json`** (new `live`, `userKeys`, chat `keys`, verification checks; `callRings` is gone — rings now live at `live/{uid}/rings`).

- **End-to-end encryption** (on by default per chat, switch in chat options): WebCrypto ECDH identity per account, AES-GCM chat key wrapped for each member, files/images/audio encrypted before upload, reply quotes too. A recovery code (shown once, see Account → Encryption) restores keys on a new device. Not encrypted: chat names/photos, who is in a chat, timestamps. Notifications can't show encrypted text ("🔒 New message"), and notification replies are off for encrypted chats. No key rotation when a member is removed.
- **Link previews** (`js/linkpreview.js`, `link-preview.php`): inline images/video/audio, click-to-play YouTube/Vimeo, cards for other pages. The site's server fetches the page (SSRF-safe). Toggle in Account → Privacy.
- **Replies** (to others and yourself), **audio** messages/files (audio-only videos show just the player; Litterbox keeps the expiry note).
- **Add by UID or email**; email stays private (`email-lookup.php`); opt out in Account → Privacy.
- **Email verification**: unverified users can sit in chats but can't send, start chats, or join/ring calls (UI + rules); banner at the top. Google sign-in / linking marks the email verified. Accounts can link Google or add a password (Account → Email & sign-in).
- **Message protection** (Android): when a call opens the app over the lock screen, only the call is reachable; Back asks for the device unlock, hanging up closes the app, chat inside the call shows only messages sent during the call + an Unlock banner.
- **Ring all** button in the call's People panel (with confirmation).
- **Connections** (free plan = 100): every frame now shares ONE Firebase SDK/connection with the shell (`js/sdk.js`); the app adds exactly one background stream (`live/{uid}`: rings + message pings) — message text is fetched with plain requests. Hidden browser tabs disconnect after 2 min; calls keep it online. A chat bubble is its own page, so it costs one extra connection while open.
- **Android**: ongoing-call notification uses `CallStyle` with Mute / Share screen / Hang up; chats can show as **bubbles** (`BubbleActivity`, chat only); keyboard images (Gboard clipboard/GIF) can be pasted into the composer. *None of the Android code has been compiled or run on a device here.*

**Round 7b:** encryption is now **off by default** (switch in chat options; turning it on/off posts a "turned on/off encryption" line visible to everyone; the recovery-code reminder appears the first time you turn it on). The Android app keeps ONE live stream (`live/{uid}`) plus a light 15 s check of each chat's newest message with plain requests (no connection) as a safety net, so notifications can't be lost if a ping is missed. The website hands the app your private key (stored only in the app's private storage, removed on logout), so notifications for encrypted chats are decrypted on the phone and can be replied to (the reply is encrypted too).

**Round 7c:** notifications and bubbles show the sender's photo (group photo / letter avatar for groups); bubbles fill the available height and get a zero-inset bridge so no margins are miscalculated; Android also checks `live/{you}/rings` every ~15 s as a fallback for call rings.

**Round 7d:** lock-screen protection now also starts when you *join* a call while the phone is locked (not just when answering from the ring); the rest of the UI is hidden and every way out asks Android to unlock, and chats show only messages since the call started. Calls show the chat/user photo on the web and in the Android notifications (ongoing-call chronometer = the real call timer), call buttons have icons, bubble icon is the full-bleed photo and bubble layout fits its window, encrypted messages are teal with a "What's this?" explainer, and decrypting late-arriving keys updates messages in place (no reload).

## Round 7e
- In-call chat panel now finds the shell's lock-protection state reliably, so only messages sent since you joined the call are shown. The banner puts the text on top and an "Unlock to see all messages" button below.
- Answering from the Android call notification joins directly (no "someone is calling" popup); the popup only appears for the full-screen ring. Its Join button brings the app to full screen first.
- Bubbles stay when the app opens; "Mark as read" notification action; per-sender icons in group notifications; non-site links open in the browser (also from popup windows).
- Android code is still not compiled/tested here.

## Round 7f
- Chat options button is hidden while the phone is locked (call chat panel).
- Android call notification photo: the picture is now loaded even when the call info reaches the app before the "in call" flag (previously it could stay a plain letter), and is reset when the call ends.

## Round 8
- **Message info:** the ⋯ menu has "Info": sent time (sender's device), delivered time and read status per member.
- **Link preview cache:** the app reads `linkPreviews/{id}` from the database first (good for a week). Only if missing/older does it call `link-preview.php`, which fetches just the first ~128 KB of the page (Range request, stops at `</head>`), and stores good previews there. A page with no preview is never cached; if a cached link later fails or has no preview, the cached one stays. Network failures are retried when the connection returns. Links from encrypted chats and from a custom database are never put in the shared cache. YouTube uses oEmbed: title + channel.
- **Declined calls:** declining (web popup, call page, Android notification) writes a "declined the call" line in the chat and notifies the caller (`live/{caller}/declines`, rules updated; toast/notification on web, notification on Android).
- **Bubble offline:** bubbles show the same offline page as the app, with Try again.
- **Encryption:** encrypted messages are no longer a different colour; the 🔒 next to the time marks them, "What's this?" explains it. A message waiting for its key gets an ⓘ button that explains how to get the key.
- **Another database:** login screen → Advanced → Firebase database URL (stored per device; the Android app follows). Push notifications, e-mail lookup and the preview cache on the server still use the database in `config.php`.
- **Deploy:** publish the new `database.rules.json`, and upload `link-preview.php`, `lib.php`.

## Round 9
- **Timestamps:** `timestamp` stays the time the sender's device sent it; every new message also gets `deliveredAt`, a server timestamp the database itself writes (rules force it to equal the real server time). Message info shows both. Read times are no longer stored (`messageReadAt` removed).
- **Declines:** no longer written into the chat. The caller still gets the notification, and the call page shows "Declined the call" in red where "Notification sent" was, and ringing that person (or "Ring all") is locked for a minute.
- **Pop-out button** is hidden where the browser can't pop the call out.
- **Images** are never taller than the screen; the page can't be zoomed (viewport, gestures, ctrl+wheel, Android WebView); tapping an image opens our own viewer (wheel / pinch / double-tap zoom, drag, caption = the image's alt text).
- **Players:** own video player (seek, volume, speed, PiP, fullscreen) and audio player with a waveform (decoded from the file when the host allows it, otherwise a generated one).
- **Rich link previews** (`link-preview.php`): image alt text (hover + viewer caption), video files and audio files (own players), price (+ rating, availability; cached links with a price refresh daily), Android app links (popup in the app only when that app is installed), location (address, "Show map", "Open in maps"), movies/music (artists, cast, director, duration, genres), articles (authors, published/edited dates, read time, tags), profiles, books, recipes, JSON-LD, twitter label/data facts, favicon, theme colour.
- Deploy: new `database.rules.json`, `link-preview.php`, `lib.php`.

## Round 10
- Video: picture-in-picture button on every video the browser allows it for (frames now carry `allow="picture-in-picture"`).
- Audio plays from an element in the top window, so it keeps playing when you leave the chat or switch apps (media-session controls on the lock screen / notification where the OS supports it). On Android the WebView is never paused and the foreground service keeps the app alive.
- Speed: dropdown (0.5× – 3×) plus a box for any value 0.1× – 16×. Waveform: played bars turn white as the audio plays (smooth, also for files whose length the browser can't report).
- Image viewer opens in the top window: full screen, controls offset by the system bars/cutout.
- Message info: "Send delay" in ms — green < 100, yellow < 1000, red above.
- Encryption: when encryption is off and no encrypted message is left in the chat (all deleted), the chat key is deleted so anyone can turn encryption on again with a fresh key (rules: messages indexed on `enc`). The toggle is disabled while the chat has a key this device can't open. Devices drop a replaced key automatically (web and Android).
- Deploy: new `database.rules.json`.

## Round 11 – downloads and an accurate waveform
- Download buttons on all three media types: images (hover/tap button in chat and in the viewer), video and audio players. Android uses DownloadManager / MediaStore (not compiled or tested here); web uses a normal download.
- Audio waveform now samples the whole file (240 slices, RMS) and uses the decoded length for the time display and for seeking, so the bar matches the real duration. If a file can't be read (cross-origin without CORS), bars are flat and the element's duration is used.

## Round 12 – audio width, overflow menu, encryption skip/reset, delay fix
- **Send delay**: "sent" timestamps are now the database's clock (`.info/serverTimeOffset`), so the delay is no longer thrown off by the sender's device clock (that is why 129 ms showed as 0). Messages sent before this update, and replies sent from an Android notification, still use the device clock.
- **Audio** fills the chat column, so the waveform is as wide as possible.
- **Player controls** that get squeezed move into a "⋯" menu (audio: speed, download; video: volume, speed, download, picture-in-picture, mute, then the total time).
- **Video picture-in-picture**: browsers (Safari too); in the Android app the video is stretched over the window and Android's own picture-in-picture is used (untested here).
- **Recovery code** dialogs (Account → Encryption) have a Copy button.
- **Locked devices**: the unlock prompt has "Not now" (use unencrypted chats; enter the code later under Account → Encryption → Enter recovery code) and "reset keys…". Resetting asks for confirmation and explains it is a last resort and that old keys on other devices stop working. A device holding an old key notices the reset, drops it and asks for the new code.

## Round 13
- **Several chats between the same two people**: "New chat" with someone you already chat with asks "Open existing chat" or "New chat". Unnamed chats with identical people are numbered "Name (2)" in the list.
- **Android downloads**: the app now downloads links itself into Downloads with a progress notification, a "Saved to Downloads" notification (tap to open) and a bar in the page with an Open button; errors are shown too. Decrypted/blob files go through `saveFile`. (Not compiled or tested here.)
- **Notification "Mark as read"** disappears once pressed (the notification stays, quietly re-posted without the button).
- **Own audio messages** are as wide as received ones.
- **Android picture-in-picture for chat videos**: only the video is shown (it is lifted out of the message and the rest of the app is hidden), with back-10 s / play-pause / forward-10 s buttons in the PiP window.
- **Images/videos/audio that fail to load** show "Can't show this …" with a Download button.

## Round 14 – data usage fix
- The audio waveform (round 11) downloaded every audio file in view in full (up to 60 MB each) just to draw it, which could add up to 100 MB+ when opening a chat. Now: files up to 3 MB are read automatically (one at a time, cached), larger files (up to 30 MB) only when played, and anything bigger, or any file while Data Saver is on, shows flat bars. Nothing else loads whole files.
- Note: the key cleanup after deleting an encrypted message / switching encryption off uses the `enc` index (see database.rules.json); deploy the current rules so it doesn't scan the whole chat.

## Round 15
- Audio files up to 8 MB (same as video) are sent inline; bigger ones go to Litterbox (up to 1 GB, 72 h).
- The waveform is now drawn from the bytes as they stream in (decoding what has arrived so far, filling in from the start). Auto-starts for files ≤ 3 MB when scrolled into view, up to 30 MB when played; at the limit the download stops and the part read stays drawn (rest flat).

## Round 16
- **Waveform travels with the message**: when an audio file is sent (inline or to Litterbox, encrypted chats included) the sender's device stores a 128-byte waveform (`wave`, base64) and the exact length (`duration`) in the message. Receivers draw it instantly and never download the file for it. Older messages keep the streaming/capped fallback. **Rules changed**: new `wave` field (string ≤ 700 chars), deploy `database.rules.json`.
- **Android PiP black screen**: the "hide everything but the video" rule was also applied to the top page, which hid the chat frame itself. It now only applies inside the chat frame (`qm-vpip-in`), the top page only expands the chat frame (`qm-vpip`).

## Round 17
- **Deafen**: new headphones button in the call dock. Deafened = nothing from the call is played on your device; everyone sees a headphones-off icon on your tile (and in the people list). Published as `deaf` on the call session (rules: boolean, added). Your own mic is not touched.
- **Android call picture-in-picture** now has mute / camera / deafen buttons (no hang-up). The call notification uses the web's mic / mic-off and screen / screen-off icons (status-bar icon and action buttons), and the screen-share notification uses the screen icon.
- Download bar hides fully (no sliver above the bottom margin). Downloads that return 404/410 say "That file doesn't exist anymore." (Android app and when the browser can read the response; a browser that blocks reading the host just opens/saves it.)

## Round 18 — developer mode, screen-sharing settings, notification Deafen

- **Developer mode** (Account → Developer, `localStorage qm-dev`, per device, synced across open frames). Off: nothing extra is shown. On: small `{ }` buttons appear — chat list (loaded data, auth, E2E, service workers, env), chat header (participants, key state, loaded counts, raw chat/lastMessage/typing, resource sizes), message menu → "Raw data" (stored vs shown, path), call dock (live per-link stats panel: connection/ICE state, candidate pair, RTT, bitrate, fps, resolution, codec, limitation, jitter/loss), Account (raw account info). Code: `js/dev.js`, `js/call/devstats.js`.
- **Screen sharing settings** (Account → Screen sharing, `localStorage qm-screen`): presets (balanced / text / motion / max) plus resolution, FPS, bitrate, content hint, degradation preference, codec, share-audio. Applied to `getDisplayMedia` constraints and to the sender (`js/screenprefs.js`, `applyScreenSender` in `mesh.js`). Android: JPEG-frame based, so quality = max edge / JPEG quality / fps, passed through `QMApp.setScreenQuality`.
- **Call notification third button**: Android allows 3 actions and Hang up uses one, so only 2 custom buttons fit. Account → Call notification chooses Share screen or Deafen (`qm-notif-btn`).
- No database rules change.

## Round 19 — notification Share screen without opening the app; PiP grid fits
- Notification "Share screen" now opens `ScreenShareActivity` (translucent, no history, own task) which only shows the system capture prompt, then hands the result to `MainActivity.shareWithProjection` → page `QM.toggleScreen()` → `QMApp.startScreen()` consumes the stored consent. "Stop sharing" goes through the service (no activity).
- Call PiP: grid uses min tile width 0 (never scrolls), spotlight disabled, tighter padding/gap, tile buttons hidden; layout re-runs when `qm-pip` toggles.

## Round 20 — visual developer views, key reset / lost messages, audio devices, share dialog
- **Developer mode** now has a Visual tab (cards with avatar + name, pills, meters) next to Raw JSON: chat list `{ }`, chat header `{ }`, message menu → "Developer info" (sender, timing/skew, encryption, content, read-by), and the call panel (one card per person: ping, route, video in fps/size/kbps, dropped frames (+/s), freezes, jitter, packet loss, sending fps/limited-by; plus a card for this device). Code: `showDev/devCard/devPill/devBar/devWho` in `js/dev.js`, `visualCall` in `js/call/devstats.js`.
- **Encryption**: resetting keys now removes the user's wrapped key from every chat (`dropMyChatKeys`, uses existing rules). When nobody holds a key (`keys` node empty) old encrypted messages show "🔒 This message is lost…" (`_lost`, `E2E.setChatLost`) with an explanation dialog; the chat can be re-keyed (toggle on/off works, flagged chats get a fresh key). Chat list shows a "🔑 No key" tag; chat options show a key-status row. No rules change.
- **Audio** (Account → Audio, and the speaker button in calls): microphone, output device (`setSinkId`, also for the >100 % booster via `AudioContext.setSinkId`), microphone volume 0–200 % (gain graph only when ≠100 %). Saved in localStorage (`qm-mic-dev`, `qm-spk-dev`, `qm-mic-vol`); a running call follows changes, also from the Account page (storage event). Code: `js/call/devices.js`, `LocalMedia.setMicDevice/setMicVolume`.
- **Screen sharing**: Account keeps the defaults; pressing Share screen in a call opens a dialog with the sending settings (prefilled, editable, "Save as defaults" optional) and a Start sharing button (`js/call/sharedialog.js`, per-share override in `screenprefs.js`). Starting from the notification skips the dialog and uses the saved defaults.

## Round 21 — chat key is only re-made when nobody has it; link info in developer mode
- Personal key reset only removes that user's own wrapped copy from each chat (`dropMyChatKeys`). The chat key is never regenerated while any member still holds a copy; only an empty `keys` node (nobody has it) allows a fresh key. Test: `t34`.
- Fixed: the chat options key-status row was not repainted while the encryption toggle was locked.
- Developer info for a message now has a card per link: parts (scheme/host/path/query/fragment), kind (YouTube/Vimeo/image/video/audio/page), the preview setting, the shared-cache entry (age, fresh/stale, stored title/text/image/price), and a "Fetch preview now" button that asks the server and shows the result and timing (`inspectUrl`, `fetchPreviewNow` in `linkpreview.js`).

## Round 22 — Android audio routing, call bar overflow menu
- Android app: audio input/output are listed and chosen natively (`QMApp.audioDevices / setAudioInput / setAudioOutput`, ids "type|name"; API 31+ `setCommunicationDevice`, older: speakerphone / Bluetooth SCO). Saved as `qm-app-in` / `qm-app-out`, applied shortly after joining. Android moves a headset's mic and speaker together. Microphone volume stays a JS gain. Browsers keep the `deviceId` / `setSinkId` path.
- Call bar: buttons that don't fit move into a ⋯ menu on the bar (order: pop-out, dev, audio, switch camera, chat, share screen, camera, deafen; mute and Leave always stay), restored when there is room again. Works in portrait and in the sideways (vertical bar) layout; an unread chat badge shows as a dot on ⋯. Code: `fitDock()` in `js/call.js`.

## Round 23 — deafen icon, debug history/graphs, key requests, grid fix
- Deafen-off icon now draws the whole headband (right side was missing) in the web icon and the Android drawable. Android call notification: when deafened the small status icon is the headphones-off icon (priority over screen share / mute) and the sub-text says "Deafened".
- Developer mode: update speed (every frame … 3 s, `qm-dev-rate`) in Account → Developer and on every live view (`devLoop`, `rateSelect`). Call panel is split per source: Microphone, Camera, Screen share, Screen share audio (inbound classified through the remote stream ids, outbound through the sender's track), plus Connection (ICE/DTLS, route, ping, bandwidth estimates, data, route changes) and a "This call" section; ~40 more WebRTC values (dropped frames /s, freezes, decode/encode time, QP, key frames, jitter buffer, concealment, NACK/PLI/FIR, limited-by durations…). Click any value with ⟿ to open a history graph (min/avg/max, hover read-out, 10 min / 1500 samples, stays open across refreshes): `devHistRow`, `devGraph` in `js/dev.js`. More rows in the chat and chat-list views.
- Encryption: chat list shows "🔑 No key: you, Carol" (everyone in the chat without a key copy) when encryption is on. A device without the chat key gets a banner, the composer is locked, and "Ask for the key" sends a readable request message (normal lastMessage + ping + push, 2 min cooldown) — `spec.plain` skips encryption for that one message. No rules change.
- Grid: `align-content: safe center` (overflow is no longer centred, which cut off top AND bottom), spotlight sizes never exceed the window, and `shrinkToFit()` shrinks tiles until nothing overflows (scrolling from the top as a last resort).

## Round 24
- Account: screen settings are split into **Receiving screen shares** (info only: always the best quality the sender provides; the browser lowers it by itself) and **Sending your screen: defaults**.
- Chat list no longer shows who lacks the key. Chat options → participants now show a **Has key / No key** badge per person.
- Keyless users can keep sending: messages (and files) go out **unencrypted** until the device gets the chat key. The "ask for the key" flow is gone. A warning banner says so and a **Why?** button explains it in detail.

## Round 25
- **Colours** (Account): *Midnight* (dark mode only: dark surfaces pure black, also the call screen), *Material You* (Android 12+ only, colours from the wallpaper via `QMApp.systemColors()`), and a custom **accent colour** (swatches + any colour). Stored per device. `js/themeboot.js` applies them before first paint in every page/frame and follows live changes.
- **Site refresh** (Account → Site updates): re-downloads every page/script/style the app uses (`js/refresh.js`), clears caches, reloads. In the Android app it also clears the WebView cache.
- **Screen sharing**: the "Receiving" card is gone. New **Max everything** preset (every knob at its top). A "What do these settings mean?" help section (Account and the start-sharing dialog) explains frame rate vs fps etc. Account shows only the controls that apply (browser: web controls; Android app: its own two).
- **Android**: audio devices are listed natively (no microphone access) and now refresh automatically when a headset/Bluetooth/USB device is plugged in or removed (`AudioDeviceCallback` → `__qmAudioDevices` → settings lists and the running call). The call notification already switches to the deafen icon when deafened (deafen > screen > muted > mic).
- **iPhone/iPad app** (`ios/`): SwiftUI + WKWebView, generated with XcodeGen; the `ios` job of `.github/workflows/quickmessage.yml` builds an **unsigned .ipa** on a macOS runner. Google sign-in goes through `ASWebAuthenticationSession`. No push notifications (needs APNs).
- **Import** (`import` job of `.github/workflows/quickmessage.yml`): upload a `quickmessage-callNN.zip` into `incoming/`; it unpacks over the project, commits, deletes the zip and starts the Android/iOS builds. `secrets.php` is never imported (and is in `.gitignore`). Add a `WORKFLOW_PAT` secret if the zip should also be able to update `.github/workflows/`.

## Round 26
- **Buttons** use the Google-Messages look: dark fill + white content in light mode, bright fill + dark content in dark mode (`--btn`, `--btn-hover`, `--on-btn`; follow the accent colour / Material You).
- **Own UI instead of Android's native popups** (`js/customui.js`): themed drop-down menus for every `<select>` (touch devices and the apps; desktop browsers keep native unless `qm-custom-ui` = 1) and a colour picker dialog (`pickColor`). The last native `confirm()` is now a themed dialog.
- **More colours** (Account → Colours): per light/dark mode, choose Background, Panels, Your messages, Other people's messages, Text; plus the accent colour. Unreadable combinations are corrected automatically.
- **Updatable Android builds**: every build is signed with the same key (`android/app/quickmessage.jks`, override with the `ANDROID_KEYSTORE_B64`, `ANDROID_STORE_PASS`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASS` secrets) and gets a higher `versionCode` (100 + run number). Builds signed with the old random CI key still need ONE uninstall.
- **iOS Simulator build**: the iOS job now also uploads `QuickMessage-simulator.zip` (`xcrun simctl install booted QuickMessage.app`).

## Round 27
- **Apple WebKit fix**: the page layered the chat list through the Account page because Safari before 17.5 doesn't know CSS `light-dark()`, so every colour variable was invalid (transparent backgrounds). Colours are now plain light / `prefers-color-scheme: dark` / `data-theme="dark"` rules in `style.css`, `offline.html` and `js/themeboot.js` (no `light-dark()` anywhere).
- **iPhone notifications** (`js/ios-notify.js`, `ios/QuickMessage/Notifier.swift`): inside an app's web view there is no web push, and real push (APNs) needs a paid Apple developer account. So: the bell in the app asks iOS for permission; while the app is in the background it plays inaudible silence (background-audio mode) so the page keeps receiving messages, and every new message becomes a local notification (tap → opens the chat). It pauses during calls and stops when the app is quit. In Safari, the free route is Share → Add to Home Screen (iOS 16.4+), then enable the bell there (normal web push).

## Round 28
- **Light-mode UI bug**: `style.css` had one unclosed `@media (prefers-color-scheme: dark) {` (left behind when the "No key" list line was removed), so every rule after it only applied in dark mode: the native `<select>` showed next to our menu, swatches collapsed, tabs were unstyled. Removed; a test now checks the braces balance and that the rules apply in light mode.
- **Screen sharing on iPhone** (needs a real iPhone: ReplayKit broadcasts don't run in the Simulator): `ios/QuickMessageBroadcast` is a ReplayKit *broadcast upload extension*. Tapping Share screen opens iOS's system "Start Broadcast" sheet; the extension sends JPEG pictures of the whole screen to the app over a loopback connection (127.0.0.1:47931), and the app passes them to the call page exactly like the Android app does (`js/native.js` → `nativeScreen()`, `ios/QuickMessage/ScreenReceiver.swift`). No screen sound on iPhone. The same quality settings as the Android app apply (largest side, picture quality, frames per second). The extension is signed along with the app by your sideloading tool (it has its own id `app.quickmessage.chat.broadcast`).

## Round 29
- `js/chatlog.js` → `js/catlog.js` (imports updated in `message.js`, `call.js`).
- **FTP deploy** (`deploy` job of `quickmessage.yml`): uploads the site on every push, and after each successful *Build Android app* / *Build iOS app* run uploads the APK, the unsigned .ipa and the Simulator zip to `downloads/` plus `android.json` / `ios.json` (version info) and a small `downloads/index.html` download page. Secrets: `FTP_SERVER`, `FTP_USERNAME`, `FTP_PASSWORD`, `FTP_DIR` (e.g. `/htdocs/message/`), optional `FTP_PROTOCOL`, `FTP_PORT`. `secrets.php` is never uploaded. Run it by hand from Actions → QuickMessage → Run workflow (what: all / site / android / ios).
- **In-app updates** (`js/update.js`): the apps compare their version with `downloads/android.json` / `ios.json`. Android: "Update available" bar → downloads the APK inside the app → installs it over the old one (`Updater.kt`, PackageInstaller; Android asks once to allow installs from QuickMessage; needs the same signing key, see Round 26). iPhone: iOS can't install itself, so the bar opens the new .ipa in Safari and you install it with your sideloading tool. Account → App also has "Check for app updates". Build numbers: `100 + run number` (Android versionCode, iOS CFBundleVersion).

## Round 30 – Download menu
- New **Download** button in the top bar (hidden inside the Android/iPhone apps). It opens a menu with: **Install as a web app** (browser install prompt, or Add to Home Screen steps on iPhone), **Android app** (only on Android; version read from `downloads/android.json`), **iPhone app** (only on iPhone/iPad; unsigned .ipa, needs sideloading), and **More…**, which shows `downloads/index.html` inside the app.
- Replaces the old separate "Android app" link and "Install" button. Code: `js/dl-menu.js`.
- Not tested on real devices; web side covered by `t45`.

## Round 31
- **Call page uses your colours**: it always uses the *dark* colours of your theme (accent, own colours, Midnight, Material You) instead of fixed indigo/grey (`call.css`, `themeboot.js` now always sets `--call-bg` when something is customised).
- **Link previews no longer shift the page**: every message is watched for size changes (`ResizeObserver` in `message.js`); anything that grows above what you are reading moves the scroll position by the same amount, and at the bottom the view stays at the bottom.
- **Loading badge**: where "Reconnecting…" shows, a tile now says "Loading camera…", "Loading mic…" or "Loading camera & mic…" when the camera/mic is on but hasn't arrived yet (after a 1.2 s grace period).
- **Live fps on videos**: Account → Call display → "Show live frame rate on videos" (per device).
- **Developer graphs**: history is cleared when the live view closes, numbers of people who left are dropped, an open graph stays under its row after a refresh, and the graph length is selectable (30 s … 1 hour) next to the update speed. Live views no longer stop updating after a touch scroll (the click guard now also lets go on `pointercancel`/after 1.5 s), when one connection's stats hang (timeouts) or throw.
- **Appearance preview**: choosing a theme without pressing "Save changes" is undone as soon as you leave the Account page.
- **Android call notification**: in group chats the text under the name shows who is in the call (instead of "Ongoing call"); 1:1 chats keep the default.
- **Call banner**: the "Join" button is gone (tap the banner).
- **Bubbles**: file picking and the camera now work (file chooser + camera permission; the microphone is still blocked).
- **iOS**: the build also makes `QuickMessage.tipa` for TrollStore (fake-signed with ldid); uploaded to `downloads/` and linked on the download page.
- Not tested on real devices (Android bubbles/notification, TrollStore); web side covered by `t46`.

## Round 32 – no manifest.json
- `manifest.json` is gone. `js/themeboot.js` (loaded in every page) builds the web-app manifest and adds it as a `data:` link; its addresses are made absolute from the page's own location (relative ones don't work inside a data: manifest). Install-as-app still works from the browser; test `t47`.

## Round 33 – updates through the web view
- Free hosts (InfinityFree) answer the app's own HTTP request with **403** (browser check). The update now downloads the APK with the **page's own `fetch()`** (inside the web view, which has passed the check) and hands it to the app in 192 KB pieces (`updateBegin/Chunk/End/Abort` on the bridge → `Updater.kt` writes `update.apk` and installs it). If the host still answers with its check page, the update bar says so ("reload the app once and try again"). The old native download stays as a fallback. Tests `t48`, `t44`.
- Not tested on a phone.

## Round 34
- **Call banner**: the Join button is back; it is hidden only inside Android chat bubbles.
- **Top bar**: buttons can no longer be pushed out (call / options / account stay put at phone widths; the Download button shows just its icon below 560 px; the title shrinks with "…").
- **Camera not displaying**: a camera switched off and on over the same stream (or a track added to a stream that is already playing) never fired "playing" again, so the avatar kept covering a working camera. Tiles now watch the frames themselves (`requestVideoFrameCallback` + a quick poll).
- **Developer views**
  - Update speed and graph length accept any number (preset list + "custom…").
  - Row arrows are drawn as little shapes (and the "open graph" marker is a CSS chevron) instead of text characters, which showed up as odd symbols with some fonts / host encodings. Dev code is also ASCII-escaped.
  - Graph scale is steady: starts at 0, tops out at a round number, grows at once and shrinks only slowly; the right edge is "now"; scale labels shown. Small dips no longer make the whole line jump.
  - Recording the graphs never pauses while the view is open (pressing / "Pause" only keep what is on screen still; hidden tab keeps recording); closing it clears everything.
  - Rates (bitrate, fps, dropped frames) no longer fall to 0 between the browser's once-a-second counter updates when updating every frame: the last real rate is kept until the counter moves.
- **iPhone app**
  - `challenge.js` (iOS app only) solves the host's JavaScript "browser check" when a script / stylesheet / fetch gets the test page back (runs the host's own aes.js, sets the cookie, retries the fetch or reloads once). The website and Android app don't have it. Test `t49`.
  - The download menu says "App on iOS".
  - Screen share upside down: the extension no longer applies 180° / mirrored orientation values (only sideways ones). This is a best guess without a device - tell me if it is still wrong.
  - Runs in the background: during a call the app now keeps its audio session (silence mixed with the call) and the page plays an inaudible sound, so the web page isn't suspended and the shared screen doesn't freeze when you leave the app. Needs a real device to verify.

## Round 35
- Call stats panel: title / tabs / Copy / Pause / Close stay on the first row; the update-speed and graph-length controls moved to their own row (they had pushed the Close button out). Test `t51`.
- The iPhone / iPad app now reports itself in calls as **App on iOS** (was "Browser on macOS"): `js/call/device.js` checks the app's user agent (`QuickMessageiOS`) / `window.__qmIosApp`.

## Round 36 – notifications
- **notify.php is much faster**: it used to make ~10 + (people × 2) requests one after the other. Now independent requests run at the same time (3 rounds), the sender gets its answer as soon as the message is marked as notified, and the pushes go out right after (all at once). Pushes are high priority (`android.priority`, `Urgency: high`, `apns-priority: 10`) and live a day instead of an hour, so phones deliver them immediately instead of batching them.
- **Sending the push request can't get lost any more** (`notifyServer` in message.js): retried up to 4 times with a fresh sign-in token and growing pauses, `keepalive` so leaving the chat doesn't cancel it.
- **"Failed to send" only when it really failed**: a slow connection used to show "Failed … Timed out" after 20 s although the database still delivered the message later. Now the bubble says "Waiting for connection…" (Retry / Cancel available) and completes by itself when the write lands; only a real refusal (no permission, bad data) shows as failed.
- **Bell (browser push)**: getting the token and saving it are retried (the service worker / network sometimes needs a moment) and no longer report an error when it worked; dismissing the permission prompt isn't an error; if the browser rotated the token while notifications are meant to be on, the device signs itself up again; a failed database read no longer makes the bell flip to "off"; the in-page toast is skipped when you are already looking at that chat.
- **Notification display** (service worker): several messages in a row stack up in one notification (last 5 lines) instead of each one wiping the previous, and it is replaced in place instead of closing and reopening (no flicker); the window / existing-notification lookups run together.
- Tests: `t52` (retry logic), `t53` (service worker). The PHP was syntax-checked and its parallel request helper tested against a local server; not run against the real Google endpoints. Android (own live stream) and iPhone (local notifications) were not changed.

## Round 37 – one workflow
- The four workflow files (build-android, build-ios, deploy-ftp, import-zip) are replaced by **one**: `.github/workflows/quickmessage.yml`. A `plan` job decides what to do, then the jobs `import` → `android` / `ios` → `deploy` run only as needed, all in one run. A zip in `incoming/` imports, builds both apps and deploys the site and downloads in the same run (no more chain of runs triggering each other). A normal push (not a README-only one) builds and deploys too; the commit the importer makes itself is skipped so nothing runs twice.
- By hand: Actions → QuickMessage → Run workflow, `what` = all / import / site / android / ios.
- Version numbers: the new workflow's run counter starts at 1, so builds are numbered `1000 + run number` (`QM_BUILD`, read by `android/app/build.gradle.kts`) so they stay above the old ones; Android refuses to install a lower versionCode.
- **Manual step**: importing a zip only touches `.github/` when `WORKFLOW_PAT` is set, and never deletes files. Add `quickmessage.yml` on GitHub yourself and delete the four old workflow files there, otherwise they keep running as well.
- Not run on GitHub yet - tell me if a job fails.

## Round 38 – workflow fixes
- Fixed "Unexpected symbol: '+'": GitHub expressions can't do arithmetic, so the `1000 + run number` build number is now computed in a shell step (`QM_BUILD` / `BUILD`).
- The importer now **deletes files** that are in the repo but not in the uploaded zip (it mirrors the zip). Never touched: `.git`, `incoming/`, `secrets.php`, and `.github/` unless `WORKFLOW_PAT` is set (with it, old workflow files that aren't in the zip are deleted too).

## Round 39 – uploads keep going
- **Leaving a chat no longer cancels its uploads.** The app shell keeps a chat's page (hidden, "parked") as long as it has an attachment in any state (uploading, waiting, failed); the upload and the final send finish there, and opening the chat again brings the same page back (Retry still works on a failed one). The parked page is dropped when its last attachment is done/cancelled. `QM.setUploads` in `js/shell.js`, reports from `reportUploads()` in `js/message.js`. Test `t54`.
- **Chat list**: every chat with an attachment uploading shows a small spinner + "Uploading" (or "Upload failed" in red) next to the preview.
- **Web**: closing / reloading the tab while something uploads brings up the browser's "leave site?" question; if you stay, a popup "Uploads still in progress" lists the files, their chat and progress. (Browsers don't allow custom text in their own question, so the list is a second popup.)
- **Android app**: the app's background notification turns into "Uploading N files" with a progress bar while anything uploads (so the app can be closed meanwhile), and a failure posts an "Upload failed" notification (`NotifyService.setUploads/uploadFailed`, bridge `QMApp.setUploads/uploadFailed`). Not compiled/tested here.
- **iPhone app**: uploads keep the app alive in the background (same silence trick as calls) and show a progress notification while in the background; failures post a notification (`Notifier.swift` ops `upload` / `uploadFailed`). Not compiled/tested here. iOS can still stop an app after a long time in the background.
- A call-panel chat's uploads (the chat shown inside the call page) aren't tracked by this.

## Round 40 – browser check everywhere, tour, AI note, faster workflow
- **Host "browser check" is handled in every page, web and apps** (`js/challenge.js`, first script in index / message / account / call / app-login / offline; the iPhone app still injects an identical copy, `ios/QuickMessage/challenge.js`). When a script, stylesheet, `fetch()` or the upload XHR gets the host's JavaScript test page instead of the answer, it is solved, the cookie stored and the request repeated (page assets: one reload). Also: the "notify the other people" request (`notifyServer`) now only counts as delivered when the answer is really JSON from our server, and ringing (`call-notify.php`) is tried up to 3 times with a fresh sign-in token before it says "Notification failed". Test `t55`.
- **Call stats panel**: the Pause button is gone.
- **AI disclosure** on the login screen (and on the app's Google sign-in page): "Made with AI".
- **Welcome tour** (`js/onboarding.js`): the first time a brand-new account signs in, 5 short pages: welcome (+ AI note), profile & colours, privacy settings, message encryption (recovery code, what isn't encrypted), calls / files / notifications. Buttons jump to Account. It is shown once per device (flag in this browser's storage; the database rules don't allow a new field) and only for accounts created in that sign-in; everyone can open it from Account → Welcome tour.
- **Workflow is shorter** (`quickmessage.yml`, 6 jobs): `plan` + `import` + `flags` are now one `prepare` job; the website upload (`site`) runs in parallel with the builds instead of after them; the iOS Simulator build (`ios-sim`) has its own runner so it doesn't delay the .ipa; one `publish` job uploads the APK / iOS files. Smaller things: brew installs `xcodegen ldid` together without self-updating, one xcodebuild step less per job, artifacts aren't re-compressed, the Android build log is only uploaded on failure, Gradle build cache on. Remember to replace the workflow file on GitHub (and it deletes nothing by itself unless `WORKFLOW_PAT` is set). Untested on GitHub.

## Round 41 – files: confirm, camera video, voice recorder, file hosts
- **Confirm before upload**: a file picked from the device opens "Send this file?" (preview, name, size, and whether it goes inside the chat or to a file host). Cancel sends nothing. Photos from the camera / voice recordings / pasted images already have their own review step.
- **Camera**: Photo | Video switch. The whole picture is shown (`object-fit: contain`, no more cropped top); video mode records with a timer, then Review → Send / Retake (mp4 where the browser supports it, else webm). Over 8 MB it goes to a file host like any other video.
- **Record audio** (attach dialog → "Record audio"): level meter + timer, review with a player, Send / Record again; sent as a normal audio message (inline when small, otherwise via a file host).
- **File hosting settings** (Account → File hosting, saved on this device — `js/hosts.js`): Litterbox, oshi.at, tmpfile.link, file.io. Per service: on/off, order (↑ ↓), limits and rules (with a link). Mode: *priority list* (first switched-on service that fits and works; on a failure it waits 1.5 s, tries once more, then moves on and says so) or *ask me every time* (a picker, then the rest of the list is the fallback). "Keep files for": longest possible (default) or 1 h … 90 days; each service gets the closest time it offers, never more than its maximum. Delete-after-first-download is always off (`autoDelete=false`, `autodestroy=0`). A service that can't take the file's size is skipped; if none can, the error says why.
- **How**: Litterbox still uploads directly (falls back to the relay); the others go through `upload.php`, which now knows a fixed list of hosts (nothing else can be requested), signs the request and returns `{url, expiresIn}`. Their relay size limit is the server's `upload_max_filesize` (shown by `upload.php?limits`), so on a small host only small files can use them. `fetch-file.php` and the message link checks accept the four hosts' links. Tests `t56` (+ `t28`, `t54`, `test4` updated for the confirmation step).
- **Not verified against the real services** (no access from here): oshi.at / tmpfile.link / file.io request and answer formats are from their public descriptions, parsed loosely. **file.io is OFF by default** because its links may open a download page instead of the file, so previews could fail; turn it on in Account if you want it. If a host's answer changes, the error text shows what it said.

## Round 42 – direct uploads from the browser
- **file.io and tmpfile.link now upload straight from the browser** (`uploadDirectHost` in `js/litter.js`, multipart POST, real progress bar), so the small upload limit of the web host no longer matters for them (file.io up to 2 GB, tmpfile.link up to 100 MB). Only when the browser can't reach them at all (blocked / no CORS) does it fall back to the `upload.php` relay, and only if the file fits through it. A real error answer from the host (rejected file, rate limit) is not retried through the relay; the normal retry-then-next-service logic applies.
- **oshi.at stays relay-only** (no browser access), so it only takes files that fit the server's upload limit; its rules text says so. In the settings list, services that work from the browser are no longer skipped for big files.
- Test `t56` updated (direct upload, 7-day expiry, blocked → relay fallback). Still not tried against the real services.

## Round 43 – interactive tour, more hosts, suggestions, read marker
- **Welcome tour** is now hands-on (`js/onboarding.js`, test `t57`): a dummy main screen (tap the highlighted account picture / "+ New chat"), a dummy chat (send a message and get a reply, attach sheet, call and lock buttons, a message's options, with "things to try" ticks), then *real* controls that save: display name, picture URL, appearance (light / dark / system) and accent colour; the email-add and link-preview switches; a visual of how end-to-end encryption works; and a last page. **Skip tour** (top right) closes it; **Skip this demo** jumps to the next page. The dialog now has its border and padding back (the pages sat directly in the `<dialog>` before).
- **More file hosts** (all **off** by default, Account → File hosting): **Catbox** (`files.catbox.moe`, 200 MB, no expiry), **0x0.st** (512 MB, 30 days to 1 year by size, can be shortened; relay only), **tempfile.org** (100 MB, 1 to 48 h, link is a download page; relay only). `upload.php` and the link checks know them. Their docs weren't reachable from here, so the request formats come from public descriptions (0x0.st `file` + optional `expires` hours; Catbox `reqtype=fileupload` + `fileToUpload`; tempfile.org `files` + `expiryHours`) and are untested. Other candidates found but not added (formats unverified or not suitable): x0.at, temp.sh, tmpfiles.org (1 h), uguu.se (3 h), filebin.net, fileditch, bashupload (deletes after one download).
- **Account → Suggest a feature**: a text box and "Open email" (a ready `mailto:` to bluetmaker@gmail.com with your text) / "Copy text". Nothing is sent by the page itself and no account details are included.
- **System messages are never marked as read**: the read marker (`messageRead`) only ever points at a real message; call / join / encryption lines (`type: "event"`) are skipped when working out the newest message (also after a message is deleted).

