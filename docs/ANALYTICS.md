# Usage statistics (analytics)

QuickMessage can send anonymous usage statistics to **Google Analytics for Firebase** on this app's own Firebase project (`measurementId` in `js/firebase.js`). Nothing goes anywhere else and no database changes are involved except one setting.

## The setting (account based, on by default)
`accsettings/{uid}/settings/analytics` (boolean, **republish `database.rules.json`**). Missing or `true` = on, `false` = off. It belongs to the account, so turning it off on one device turns it off on every device (open pages react within moments; the Android app is told by the website). It is offered in:
- the **welcome tour** (a page right after "Your privacy", for new accounts) with an explanation, and
- **Account → Privacy → Share anonymous usage statistics** (any time).

Nothing is collected, and the Analytics SDK isn't even downloaded, while: signed out, the choice isn't known yet, it is off, the device uses a private server / own database (`docs/SERVER-PRIVATE.md`), or the browser sends *Do Not Track*. Ad features are off (consent mode: `analytics_storage` only; no advertising id on Android).

## What is collected
Events are tied to the account's random Firebase id as GA `user_id` (web) / user id (Android), so one account's activity can be followed live in GA (Realtime, User explorer; turn on developer mode in Account for DebugView). It is a random id, not a name or email, and it is removed the moment analytics is switched off or the user signs out. Never: message text, names, email address, friend codes, file names, links, who talks to whom. Error text has links, email addresses and friend codes stripped and is cut to 100 characters.

| Event | Parameters | Why |
|---|---|---|
| `screen_view` | `screen_name` (index, message, call, account, …) | which parts are used |
| `ui_click` | `control` (a button's fixed id / label, never typed text), `page` | which controls are used and which never are (max 300 per page load) |
| `page_time`, `page_timing` | `page`, `secs` (bucket) / `ms`, `ttfb` | time spent per screen, load speed |
| `media_control` (Android) | `op` | media notification buttons |
| `app_error` | `kind` (js / promise / console), `file`, `line`, `msg`, `page` | errors found before people report them (max 5 per page load) |
| `app_fatal`, `page_load_failed` | `kind`, `detail`, `page`, `code` | the "This page hit a problem" screens |
| `message_sent` | `type` (text / image / video / audio / file / code), `reply`, `encrypted`, `group` | feature use |
| `tray_send` | `files` (bucket) | attachment tray use |
| `file_upload` | `host`, `ok`, `size` (bucket), `tries`, `reason` | which file hosts work |
| `pin_toggled`, `mute_set`, `message_action`, `chat_menu_tab`, `search_used`, `code_viewer_open`, `encryption_toggled` | small flags (on/off, tab, language) | feature use |
| `call_joined`, `call_left` | `video`, `audio`, `length` (bucket) | call use |
| `login`, `sign_up`, `notifications_enabled`, `tour_page`, `tour_done`, `setting_changed` (`setting` = the control's name), `full_refresh`, `pwa_installed` | method / page / platform | onboarding and settings use |
| user properties | `site_version`, `platform` (desktop_web / mobile_web / android_app / ios_app), `standalone` | versions and platforms in use |
| Android app (native SDK) | `push_received` (`type`, `priority` as given/original, `late` bucket), `push_event` (`type` of the diagnostics line), `app_crash` (`kind` = exception class, `file`) | push delays and crashes; the app version is added by Analytics itself |

Add your own with `track("name", { small: "values" })` from `js/analytics.js` (snake_case, no personal data).

## Seeing it
Firebase console → Analytics (Realtime / DebugView / Events). To break events down by the parameters above, register them once as **custom definitions** (Analytics → Custom definitions): `site_version`, `platform` (user scope) and e.g. `page`, `file`, `type`, `host`, `kind` (event scope). GA4's "enhanced measurement" (scrolls, outbound clicks…) can be switched off on the web data stream if you don't want it. For the Android app, the Android app must be registered in the Firebase project (`google-services.json`, see `docs/APPS.md`).
