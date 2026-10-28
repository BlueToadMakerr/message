# QuickMessage (Android app)

A standalone app: the website runs inside a WebView, and the app adds what a WebView can't do by itself. Everything else
(chat, calls, settings) is the website, so site updates show up in the app automatically.

| Feature | How |
|---|---|
| Screen sharing in calls | `ScreenService` captures the screen (MediaProjection) and streams small JPEG frames into the page, which turns them into the screen-share track (`js/call/media.js`) |
| Message notifications | `NotifyService` listens to your chats' `lastMessage` and notifies (only while the app isn't on screen) |
| Full-screen call alerts | `NotifyService` watches `live/{you}/rings` and raises a full-screen "Incoming call" that opens the app on the call |
| Camera / microphone | WebView permission requests are mapped to Android permissions |
| Status & navigation bars | `js/bars.js` tells the app the site's background colour (`QMApp.setBars`) |
| Offline / errors | `assets/offline.html` is shown for network errors, with the `net::` code |
| Google sign-in | opens `app-login.html` in the browser, returns an ID token via `quickmessage://auth` |
| Stays connected | WebView never paused, wake lock + foreground service, one-time battery-optimisation prompt |
| Picture-in-picture | Android PiP of a person's video (ratio follows the video) or the whole call |
| Refresh cache | Account → App → *Refresh app cache* |
| Rotation | the call (and everything else) follows the device orientation |

Signing in happens on the website. `js/app-bridge.js` hands the signed-in account's token to the app so notifications work
when the page isn't open; signing out removes it.

## Build
GitHub Actions: the `android` job of `.github/workflows/quickmessage.yml` builds `app-debug.apk`. Or open `android/` in Android Studio.
Set `Config.SITE_URL` (your site, with trailing slash), `API_KEY` and `DB_URL` in `Api.kt`.
No Firebase Android SDK or `google-services.json` is used.

## Notes
* Not compiled or run on a device by the author: expect to fix small compile errors on the first build.
* Notifications run through a small foreground service (a quiet "Listening for messages and calls" notification). Android may stop it on aggressive battery savers; exclude the app from battery optimisation if notifications stop.
* Screen share is a frame stream (about 5 fps, 1024 px wide): fine for slides and apps, not for video.
