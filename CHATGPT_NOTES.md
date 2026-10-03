# QuickMessage development notes

Last updated: 2026-10-03

## Current project state
- Firebase project: QuickMessage (quickmessage-ac953)
- Firebase JS SDK: 11.0.1
- Main frontend uses Firebase Authentication + Realtime Database.
- Shared UI helpers are in js/ui.js.
- Profile/database helpers are in js/users.js.
- Main chat page is message.html with js/message.js.
- Calling uses the chat ID as the call room (`calls/{chatId}`); individual 1-to-1 WebRTC sessions live underneath that room.
- WebRTC signaling uses `calls/{chatId}/sessions/{sessionId}` so the chat remains the room identity while each ring gets its own 1-to-1 session.
- Current WebRTC configuration has Google public STUN only. TURN has not been added yet.
- Group calling is intentionally deferred until 1-to-1 calling works.

## Important implementation conventions
- Reuse helpers from js/ui.js instead of duplicating avatar/icon code.
- avatarEl(name, url, cls) is exported from js/ui.js.
- hydrateIcons() is exported from js/ui.js.
- Do not assume helpers are exported from js/users.js.
- Keep changes focused; avoid unrelated UI/style rewrites while functionality is being debugged.

## Current call-page wiring
- call.html uses screenBtn for screen sharing.
- call.html uses audioOnlyBtn for the audio/video toggle.
- js/call.js must match those IDs.
- Caller URL: call.html?callId=CALL_ID&peerUid=USER_UID&caller=1
- Callee URL uses the same URL without caller=1.

## Firebase rules note
- The current Firebase rules supplied during development do not yet contain a calls section.
- The call client therefore requires appropriate Realtime Database rules before two users can signal through /calls.
- Do not loosen existing root rules just to make calling work; add a narrowly scoped /calls rule for authenticated call participants.

## Current call-system flow
- Opening `call.html?chatId=...` loads every member of that chat automatically.
- Every other member gets a **Ring** button.
- Ringing writes `calls/{chatId}/ringing/{targetUid}` and creates a session under `calls/{chatId}/sessions/{sessionId}`.
- `call-notify.php` verifies the Firebase ID token, verifies both users are chat participants, sends FCM to the target's saved device tokens, and returns a notification status.
- The ring list displays `Notification sent`, `No notification device`, or `Notification failed`.
- Incoming calls can be accepted or declined from the call page.
- The actual WebRTC connection remains 1-to-1 for now; the chat ID is the room identity so group-call signaling can be expanded later.
- WebRTC currently uses Google public STUN only. TURN has not been added yet.

## Next call-system steps
1. Add the `/calls` Realtime Database rules to the live Firebase rules.
2. Test ring notification delivery and accept/decline.
3. Test camera, microphone, ICE, hangup, and screen sharing.
4. Add TURN for connections that cannot establish a direct/STUN path.
5. Later, extend the existing chat room/session structure for true multi-party calls.
