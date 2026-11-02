# Features

## Chat
- Private one-to-one and group chats on Firebase Realtime Database (or your own [private server](SERVER-PRIVATE.md)).
- Live typing indicator, read receipts (a small avatar under the last message each person has read), edit and delete, replies, link previews, system lines for calls and events.
- **End-to-end encryption** per chat (switch in the chat's options). Keys live on your devices; a recovery code unlocks them elsewhere.
- Photos, short clips and voice notes are sent inside the chat (stored apart from the message, loaded when visible). Bigger files go to free anonymous file hosts (priority list, per-host expiry, "ask me every time"); a confirmation appears before anything is uploaded.
- Camera (photo and video, full frame) and a voice recorder.
- Uploads keep going if you leave the chat; closing the page asks for confirmation and lists unfinished uploads; chat-list badges and (apps) a progress notification.

- **Swipe to reply / @mentions:** swipe a message right to reply; type `@` to pick someone and notify only them. Messages without an `@` notify everyone.

## Calls
- Voice, video and screen-sharing group calls (WebRTC mesh) that survive switching chats; picture-in-picture; full call statistics in developer mode.
- Incoming calls ring on every device of the account.

## App shell
- Chat list + open chat side by side on wide screens, a persistent call layer, an offline page, themes (light, dark, midnight, Material You, custom accent).
- First-login interactive tour with a dummy chat; real settings are saved from it.

## Notifications
- Web push, Android (live stream, reply and "mark as read" actions, chat bubbles, photos shown big) and iPhone local notifications. Sent by Firebase Cloud Functions: see [SETUP-FIREBASE.md](SETUP-FIREBASE.md).

## Apps
- Android (WebView, package `app.quickmessage.chat`) and iPhone (WKWebView) apps, built by one GitHub Actions workflow: see [APPS.md](APPS.md).

## For developers
- Developer mode: `{ }` buttons with raw data, live graphs, call statistics.
- **Plugins** (sandboxed, permissioned) with full docs: [PLUGINS.md](PLUGINS.md).
- Site version and update checks.

## Other ways to run it
- Firebase + any static host (default).
- A private Python server, fully offline: [SERVER-PRIVATE.md](SERVER-PRIVATE.md).
- Compatibility mode for very old browsers: [OLD-BROWSERS.md](OLD-BROWSERS.md).
