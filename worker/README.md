# QuickMessage worker (push notifications + bot API, run by you)

Firebase's free plan can't run Cloud Functions, so this small Python program does their job on a computer you control:

* listens to the database and sends **push notifications** (messages, call rings) to the Android app and to browsers / the installed web app,
* answers **bots** (requests through the database, see `docs/BOTS.md`), feeds them new messages and calls their **webhooks**,
* writes a **heartbeat** every 30 seconds so the **Status page** (`status.html`), the Account page and the Bots page can tell you when this computer is off (then notifications and bot calls don't work; chatting does).

**Use this *or* the Cloud Functions in `functions/`, never both**, or every notification arrives twice.

## Set up (about 10 minutes)
1. Python 3.9+ on the always-on computer: `cd worker && pip install -r requirements.txt` (a virtualenv is fine).
2. Firebase console → ⚙ Project settings → **Service accounts** → *Generate new private key*. Save the JSON next to the worker (e.g. `serviceAccount.json`). **It is full access to your project: keep it private, never put it on the website or in Git.**
3. Republish `database.rules.json` (Realtime Database → Rules). New: `serverStatus`, `bots`, `botKeys`, `botList`, `botInbox`, `botOutbox`, `botEvents`. **Bots made before this version need "New token"** (their token wasn't stored for the rules to check).
4. Run it: `python3 qm_worker.py --key serviceAccount.json --app-url https://msg.infinityfreeapp.com/`
   * `--db-url` if your database isn't the default one, `--port 8787` (local status page, 127.0.0.1 by default), `--catchup 600` (after downtime it still notifies for messages from the last 10 minutes).
5. Open `http://localhost:8787/` to see it running, and `status.html` on your site (it should say **Online** within a minute).
6. To keep it running and start it at boot, use `qm-worker.service` (systemd) or any process manager.

## Bots
Bots talk to the worker **through the database** (they write requests into `botInbox`, the worker answers in `botOutbox` and feeds new messages into `botEvents`), so **nothing has to be exposed**: no open port, tunnel or public address. The database rules only accept a request that carries the bot's real token, so only the bot can write requests, and the worker is the only thing that writes to chats on its behalf. See `docs/BOTS.md` and the ready-made client `docs/bots/qmbot.py`.

Optional: `--http-api` also serves the same bot API over HTTP (`/api/bot/...`, `--host 0.0.0.0`, `--public-url`), for tools that can't use the database. Webhooks (set on a bot) only go to `https://` addresses that resolve to public IPs, so nobody can aim the worker at your own network.

## Notes
* The worker needs no inbound connection at all: it only makes outgoing connections to Google.
* If the computer is off: nothing is lost in the chats; bots' requests wait in the inbox for up to 10 minutes (older ones are answered with "too old"). After it comes back it notifies for messages and rings newer than `--catchup` seconds (rings: 45 seconds). The Android app only gets pushes while the worker runs, but opening the app always catches up.
* Test it without Firebase: `python3 test_worker.py`.
* Not run against real Firebase during development (no access there): if something doesn't arrive, run with `QM_DEBUG=1` and read the console.

## When a call says "The notification couldn't be sent"

The call page now shows the reason. Look at the **Status page → "Last push error"** (or the worker's console; run with `QM_DEBUG=1` for details). Typical causes: the service account doesn't have the *Firebase Cloud Messaging API (V1)* enabled / permission, the device's token is stale (the person must re-enable notifications), or the computer's clock is far off (the status page shows a clock difference). "The notification server didn't answer" means the worker isn't running or can't reach the database.
