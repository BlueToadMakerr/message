# Keeping database usage low

The free Realtime Database plan allows 100 simultaneous connections, 1 GB stored and 10 GB downloaded per month. Most of the traffic of a chat app is media, so that is where the work went.

| What | How it is reduced |
|---|---|
| Photos / clips / voice notes | Stored in `privateChats/{chat}/media/{id}` instead of inside the message. Opening a chat downloads only the small message records. The body is fetched when it scrolls into view (600 px ahead) and kept in Cache Storage (150 items), so it is downloaded once per device. The sender caches its own upload. |
| Picture size | Re-encoded as WebP (JPEG where unsupported), the first of 1280/1100/900/720/560 px that fits about 300 KB (was up to 2.8 MB). |
| Listeners | One `chatData` listener instead of three per chat, one shared SDK connection for the whole app (every frame reuses the shell's), connection released after 2 minutes in a hidden tab. |
| Chat list | The listener is registered before the `get()` so the list is downloaded once. |
| Profiles | Cached in memory and in `localStorage` for 15 minutes. |
| Android background | One request per minute to `live/{you}` (rings + a "newest message" marker per chat) instead of one per chat every 15 s. The live stream is the real-time path. |
| Notifications | Sent by Cloud Functions on the server side of Firebase: the clients make no requests for them. |
| Writes | The read marker is written only when it changes; typing is one `set` + `remove` per burst; call heartbeats are one small update per 15 s while in a call. |

Messages written by older versions keep their inline pictures and still display; they simply stay heavy. Deleting a message also deletes its media node.

## Rules
`database.rules.json` has a new `media` block. After updating: Firebase console → Realtime Database → Rules → paste → Publish (or `firebase deploy --only database`). Without it, sending photos fails with "permission denied".

## Tips
- Delete old chats you don't need: stored data counts against the 1 GB limit.
- Put the project on the Blaze plan with a low budget alert if you want headroom; Cloud Functions need it anyway.
- Or use the [private server](SERVER-PRIVATE.md): no limits.
