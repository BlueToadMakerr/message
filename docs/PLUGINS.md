# Plugins

Developer mode lets you add small JavaScript plugins that change how QuickMessage looks and behaves **on your device**.

1. Account → Developer → turn on Developer mode → **Plugins**.
2. New plugin (templates included), choose its permissions, save, switch it on.

The complete reference is in the app: **`plugin-docs.html`** (also linked from the Plugins page). It covers the sandbox, every permission, every `qm.*` call, events, CSS hooks, examples, the plugin file format, versions and limits.

## Summary
- Each plugin runs in a sandboxed iframe (no access to the site, your login or Firebase). A Content-Security-Policy blocks all network access unless the `network` permission is given.
- Permissions: `toast`, `style`, `panel`, `me`, `chat`, `messages`, `network`, and (site 1.46.0) `page`, `buttons`, `calls`, `devinfo`. `page` can read the screen, click, type and scroll; `devinfo` can read developer info and add cards to the developer views. Reading messages plus network access can leak data: only install code you trust.
- Plugin API version (`apiVersion`) and `minSite` decide compatibility. Older plugins get an **Outdated** warning but run; plugins for a newer API than the site are blocked with an explanation.
- `updateUrl` lets the Plugins page check for a newer version of a plugin (it never installs by itself).
- Site version: `js/version.js` / `version.json`; a bar appears when a newer one is deployed.

## Releasing a new site version (maintainers)
1. Change `SITE_VERSION` in `js/version.js` and `version` in `version.json` (same number).
2. If a change could break plugins, raise `API_VERSION` as well and add a row to the table at the end of `plugin-docs.html`.

## What plugins can do (1.46.0+)
- **Control the page**: `qm.page.query / click / type / scroll / scrollUntil / highlight` on the open chat, the call page or the chat list. `scrollUntil` scrolls a chat up until a message with some text appears, letting the page load older messages, then flashes the message.
- **Add buttons**: `qm.buttons.add({id, label, where: 'chat' | 'list' | 'call'})`, then react to the `button` event (for example by asking with `qm.ask` and running a search).
- **Calls**: `qm.calls.state()` and the `call-state` event.
- **Developer info**: `qm.dev.read('env' | 'state' | 'call')` and `qm.dev.addCard('app' | 'chat' | 'message' | 'call', {id, title, rows})`; update cards on the `dev-view` event.

## What plugins can do (1.48.0+)
- Permissions added: `send`, `clipboard`, `notify`, `keys`, `commands`.
- **Messages**: `qm.messages.list / find / get / jump / reply`. **Chat**: `getText / setText / clearText / focus / list / info / send`.
- **Slash commands** (`qm.commands.add`, event `command`) and **keyboard shortcuts** (`qm.keys.add`, event `key`).
- **Look and feel**: CSS variables and named stylesheets, a top banner, panel progress bars, notifications, vibration, clipboard.
- **More page control**: `waitFor / text / attr / count / focus / press / select / check / hide / show / title`.
- **No permission needed**: `qm.every / after / now`, `qm.util.*`, `qm.bus.*` (plugin to plugin), `qm.app.info`, `qm.plugins.list`, `qm.storage.keys / clear / usage`.
- Switching a plugin off, deleting or editing it now takes effect immediately and removes everything it added.
