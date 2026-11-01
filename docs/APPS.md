# Android and iPhone apps

Both apps are thin native shells around the website (`android/`, `ios/`). One workflow, `.github/workflows/quickmessage.yml`, builds everything:

```
prepare (what changed? unpack an uploaded zip) ─┬─► site  (website → FTP)
                                                ├─► android (APK) ──► publish (APK / iOS files → FTP)
                                                ├─► ios (unsigned IPA)
                                                └─► ios-sim
```
- Upload a zip into `incoming/` (or push) and the matching parts run; unneeded files are removed.
- Build number = 1000 + workflow run number (`versionCode` / `BUILD`).
- Repository secrets: `FTP_SERVER`, `FTP_USERNAME`, `FTP_PASSWORD`, `FTP_DIR`, optional `FTP_PROTOCOL`, `FTP_PORT`, `WORKFLOW_PAT` (lets the importer update `.github`).
- Site address: `Config.SITE_URL` in `android/.../Api.kt`, `siteURL` in `ios/QuickMessage/WebView.swift`.
- Details for Android: [`android/README.md`](../android/README.md).

The apps are built for the Firebase setup. They do **not** support the [private server](SERVER-PRIVATE.md).
The Android and iPhone code is not compiled or run in the environment where it is written; the workflow is the first real build.

## Private server
Both apps can point at a [private Python server](SERVER-PRIVATE.md) instead of Firebase: on the login screen, **Use a private server instead of Firebase**. Android stores it in `Config`, iOS in UserDefaults `qmServer`. Untested on real devices.

## Android Auto
Messages: new-message notifications are `MessagingStyle` notifications with the two actions Android Auto needs — a voice **Reply** and **Mark as read**, both set not to open the app — and `res/xml/automotive_app_desc.xml` declares the app as a notification-based messaging app. In the car the messages are read aloud and you can answer by voice (not in end-to-end encrypted chats that this phone has no key for, same as the phone's own Reply button).

Calls: ringing and running calls are also registered with Android's Telecom framework as self-managed calls (`Telecomm.kt`, `QmConnectionService`), next to the existing incoming-call / ongoing-call notifications. The car, a Bluetooth headset or the system can then show the call, **answer**, **decline**, **hang up** and **mute**; those requests do exactly what the notification buttons do. If the system refuses (old Android, missing permission) nothing else changes.

Honest limits: Android Auto only offers third-party voice-call screens to apps approved for it by Google, so how much of the call UI shows in a given car can differ; the call itself still runs in the app (WebView), and the audio goes through the phone's normal call audio. None of this was compiled or tried in a car here — please test it with the Android Auto desktop head unit or a real car and report what is missing.
