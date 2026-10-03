# QuickMessage development notes

Last updated: 2026-10-03

## Current project state
- Firebase project: QuickMessage (quickmessage-ac953)
- Firebase JS SDK: 11.0.1
- Main frontend uses Firebase Authentication + Realtime Database.
- Shared UI helpers are in js/ui.js.
- Profile/database helpers are in js/users.js.
- Main chat page is message.html with js/message.js.
- 1-to-1 calling is being implemented on call.html with js/call.js.
- WebRTC signaling currently uses Realtime Database under calls/{callId}.
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

## Next call-system steps
1. Test the corrected call page initialization.
2. Add or verify the /calls Realtime Database rules.
3. Add a call-start button/action from the existing chat UI.
4. Test camera, microphone, ICE, answer, hangup, and screen sharing.
5. Add TURN for connections that cannot establish a direct/STUN path.
6. Only after 1-to-1 calling is stable, design group-call signaling.
