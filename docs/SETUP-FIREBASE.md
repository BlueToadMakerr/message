# Setting up with Google Firebase (the default)

## 1. Firebase project
1. [console.firebase.google.com](https://console.firebase.google.com) → Add project.
2. **Authentication** → Sign-in method: enable *Email/Password* and *Google*. Settings → **Authorized domains**: add your site's domain (e.g. `msg.infinityfreeapp.com`) and `localhost` for testing.
3. **Realtime Database** → Create database (any region). Copy its URL.
4. **Rules**: paste `database.rules.json` → Publish. The rules require a verified email to write, and include the `media` block (needed for photos). Replace the admin uid on line 4 with yours (or remove that line).
5. **Project settings → General → Your apps → Web**: copy the config into `js/firebase.js` (`firebaseConfig`). Also `config.php` (`project_id`, `database_url`, `api_key`) and the Android `Api.kt` / iOS `WebView.swift` constants if you use the apps.
6. **Cloud Messaging → Web Push certificates**: generate a key pair and put the public key in `js/firebase.js` (`VAPID_KEY`).

## 2. Notifications: Cloud Functions
Push notifications and call rings are sent by two Cloud Functions in `functions/` that react to database writes (`onMessage`, `onRing`).
1. Upgrade the project to the **Blaze** plan (pay-as-you-go; normal use stays inside the free quota, set a budget alert).
2. Install the CLI: `npm i -g firebase-tools`, then `firebase login`.
3. From the project folder: `cd functions && npm install && cd .. && firebase deploy --only functions,database`.
4. Region: `us-central1` by default. If your database is in another region set `QM_REGION` / `QM_DB_INSTANCE` (the database instance name) in `functions/.env`. Site address for notification links: `QM_APP_URL` (default `https://msg.infinityfreeapp.com/`).

The functions skip system lines, the sender, and people who already read the message; encrypted chats get a generic "🔒 New message"; dead device tokens are removed. Photos appear in the notification when they were uploaded to a public file host and the chat is not encrypted.
They were **not run against real Firebase in the development environment** (no access there): if a notification doesn't arrive, `firebase functions:log` is the first place to look.

## 3. The website
Upload the files to any static host. With InfinityFree and the included GitHub workflow: set repository secrets `FTP_SERVER`, `FTP_USERNAME`, `FTP_PASSWORD`, `FTP_DIR`. The PHP files that remain (`upload.php`, `fetch-file.php`, `link-preview.php`, `email-lookup.php`, `mark-verified.php`, `lib.php`, `config.php`, `secrets.php`) are only used when you attach a big file, download an encrypted file, preview a link, add someone by email or mark your email verified; **messages, calls and notifications never need them**. `secrets.php` holds the service account for those helpers: rotate it if it was ever public.

## 4. Apps
See [APPS.md](APPS.md).

## 5. Database usage
See [DATABASE-USAGE.md](DATABASE-USAGE.md).

## secrets.php (service account)
`secrets.php` is never committed and the GitHub deploy never uploads it, so you add it once by hand (File Manager / FTP) next to `index.html`. It is a PHP file that returns the service-account key as an array:

```php
<?php
return [
  "type" => "service_account",
  "project_id" => "YOUR-PROJECT",
  "private_key" => "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
  "client_email" => "firebase-adminsdk-xxxxx@YOUR-PROJECT.iam.gserviceaccount.com",
  "token_uri" => "https://oauth2.googleapis.com/token",
];
```
Get the values from Firebase console → Project settings → Service accounts → Generate new private key (the downloaded JSON has the same fields). It is needed by `proxy.php` (compatibility client on Firebase) and the optional helpers above. Without it those features answer "secrets.php is missing".
