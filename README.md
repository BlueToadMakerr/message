# QuickMessage

Lightweight private chat on Firebase Realtime Database. Static front-end (HTML + ES modules, no build step) plus one PHP endpoint (`notify.php`) for push notifications. Upload the whole folder to your host (it's laid out to live at `/message/`).

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
3. **Add a database rule for typing** (otherwise typing writes are rejected and the indicator silently does nothing). Inside `privateChats/$chatId` add:

   ```json
   "typing": {
     "$uid": {
       ".read": "root.child('privateChats/'+$chatId+'/participants/'+auth.uid).exists()",
       ".write": "$uid === auth.uid && root.child('privateChats/'+$chatId+'/participants/'+auth.uid).exists()"
     }
   }
   ```
   (If your existing rules already let participants read/write everything under their chat, nothing is needed.) Also make sure `messages` has `".indexOn": ["timestamp"]`, which the paginated queries rely on.
4. Hard-refresh once (or unregister the old service worker) so devices pick up the new `firebase-messaging-sw.js`.

## Notes

- Notifications need HTTPS; on iOS the site must be installed to the home screen first.
- Photos/videos are stored inline in the database (as before). That's fine for a tiny app but will grow your DB quickly; a storage bucket would be the next step if usage grows.
- `notify.php` caches its short-lived Google access token in the system temp dir to avoid a token request on every message.
