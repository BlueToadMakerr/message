# Plugins

Developer mode lets you add small JavaScript plugins that change how QuickMessage looks and behaves **on your device**.

1. Account → Developer → turn on Developer mode → **Plugins**.
2. New plugin (templates included), choose its permissions, save, switch it on.

The complete reference is in the app: **`plugin-docs.html`** (also linked from the Plugins page). It covers the sandbox, every permission, every `qm.*` call, events, CSS hooks, examples, the plugin file format, versions and limits.

## Summary
- Each plugin runs in a sandboxed iframe (no access to the site, your login or Firebase). A Content-Security-Policy blocks all network access unless the `network` permission is given.
- Permissions: `toast`, `style`, `panel`, `me`, `chat`, `messages`, `network`. Reading messages plus network access can leak data: only install code you trust.
- Plugin API version (`apiVersion`) and `minSite` decide compatibility. Older plugins get an **Outdated** warning but run; plugins for a newer API than the site are blocked with an explanation.
- `updateUrl` lets the Plugins page check for a newer version of a plugin (it never installs by itself).
- Site version: `js/version.js` / `version.json`; a bar appears when a newer one is deployed.

## Releasing a new site version (maintainers)
1. Change `SITE_VERSION` in `js/version.js` and `version` in `version.json` (same number).
2. If a change could break plugins, raise `API_VERSION` as well and add a row to the table at the end of `plugin-docs.html`.
