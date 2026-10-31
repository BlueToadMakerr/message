# Private server (Python, offline)

`server/qm_server.py` is a replacement for Firebase that also serves the website. Python 3.8+, **standard library only**, no internet and no accounts needed. Use it for a home / office / school network, a Raspberry Pi, or a machine with no connection at all.

## Quick start
```bash
cd QuickMessage                      # the folder with index.html and server/
python3 server/qm_server.py          # http://localhost:8080 , data in ./qm-data
```
Open `http://<this-computer's-ip>:8080/` on any device on the network, press **Sign up**, done. The first page load includes `window.__QM_PRIVATE=1`, which makes the site use the server instead of Firebase.

Options: `--port 9000`, `--host 127.0.0.1`, `--data /srv/qm`, `--no-signup` (only accounts you add can log in).
```bash
python3 server/qm_server.py adduser me@home 'a password'
python3 server/qm_server.py passwd me@home 'new password'     # replaces "forgot password"
python3 server/qm_server.py listusers
```
Emails only have to *look* like emails (`me@home` is fine); they are never used for sending mail.

## Keep it running
- Linux: a systemd unit `ExecStart=/usr/bin/python3 /opt/quickmessage/server/qm_server.py --data /var/lib/quickmessage` with `Restart=always`.
- Back up the data folder (`db.json`, `users.json`, `secret.key`, `files/`). Stopping with Ctrl+C saves immediately; otherwise changes are written about a second after they happen.

## HTTPS
The server speaks plain HTTP. Browsers allow camera, microphone, notifications and service workers only on `localhost` or **HTTPS**, so for calls and notifications from other devices put a reverse proxy in front (Caddy: `caddy reverse-proxy --from chat.example.com --to localhost:8080`; for a LAN-only name use Caddy's internal CA or a self-signed certificate you install on the devices). The Wii and other old browsers should use plain HTTP (they cannot do modern TLS).

## What works
Accounts, chats, groups, messages, edits, deletes, typing, read receipts, **end-to-end encryption** (it happens in the browser), photos / clips / voice notes, **files up to 40 MB stored on the server** (`qm-data/files`, no expiry), calls (WebRTC works on a LAN without internet; the default Google STUN servers are only needed across networks), themes, plugins and developer mode, the compatibility client for old browsers, notifications **while a tab is open** (browser notifications created by the page).

## What is hidden or different
| Feature | In private mode |
|---|---|
| Google sign-in, linking Google | Hidden (needs Google) |
| E-mail verification / password reset | Accounts are verified on creation; reset with the `passwd` command |
| Push notifications with the page closed | Not possible (no push service). Notifications show while QuickMessage is open in a tab or window |
| Link previews | Hidden (the server would need the internet) |
| File hosts (Litterbox etc.) | Replaced by uploads to the server |
| "Download app" menu, Firebase database option | Hidden |
| Android / iPhone apps | Not supported: they are built for Firebase |
| Cloud Functions | Not used |

## Permission model (simplified)
Firebase's `database.rules.json` is *not* evaluated. The server applies a hand-written equivalent: you must be signed in; you read and write only your own `accsettings`, `userKeys`, `chatList`, `FCM`, `live`; chat data and calls only if you are a participant; messages only as yourself; edits / deletes only of your own messages; `typing` and `messageRead` only for yourself. It is meant for people you trust on a network you control, not for the open internet. Passwords are stored as salted PBKDF2-SHA256; sessions are signed tokens valid 60 days (`secret.key` signs them: keep it private).

## How it talks
- `POST /api/auth/*` accounts; `POST /api/db/{get,update,tx}` data; `GET /api/stream` Server-Sent Events for live listeners (+ `POST /api/listen`, `/unlisten`, `/ondisconnect`); `POST /api/upload`; `GET /api/lookup`; `/api/lite/*` for the compatibility client.
- In the browser, `js/private/sdk-private.js` implements the same functions the site uses from the Firebase SDK (`ref`, `get`, `set`, `update`, `onValue`, `onChildAdded`, `query`, `onDisconnect`, auth…), so the rest of the code is unchanged.

## Pointing the hosted site at your server
Open the hosted site, then in the browser console: `localStorage.setItem('qm-private','http://192.168.1.10:8080')` and reload. The server sends CORS headers for this. (Mixed content rules block an `https://` site from calling an `http://` server, so this is mainly for `localhost`.)

## Limits and honesty
- Whole database in memory (JSON file on disk): fine for a household or a team, not for thousands of users. A write rewrites the file (debounced), so keep it on an SSD / SD card with care.
- Single process; one thread per open connection.
- Tested with the real site in Chromium (sign-up, chats, live messages, photos, files, the compatibility client). Not load-tested, not security-audited.
