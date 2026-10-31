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
