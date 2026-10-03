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
- Calling now uses a chat-wide room with a WebRTC mesh: each connected member has one direct peer connection to every other connected member.

## Important implementation conventions
- Reuse helpers from js/ui.js instead of duplicating avatar/icon code.
- avatarEl(name, url, cls) is exported from js/ui.js.
- hydrateIcons() is exported from js/ui.js.
- Do not assume helpers are exported from js/users.js.
- Keep changes focused; avoid unrelated UI/style rewrites while functionality is being debugged.

## Current call-page wiring
- call.html uses screenBtn for screen sharing.
- Call page URL: `call.html?chatId=CHAT_ID`; push notifications may add `&session=SESSION_ID`.

## Firebase rules note
- The current Firebase rules supplied during development do not yet contain a calls section.
- The call client therefore requires appropriate Realtime Database rules before two users can signal through /calls.
- Do not loosen existing root rules just to make calling work; add a narrowly scoped /calls rule for authenticated call participants.

## Current call-system flow
- Opening call.html?chatId=... authenticates, loads the chat participants, and automatically joins the chat call room.
- The room is calls/{chatId}.
- Active callers are tracked at calls/{chatId}/members/{uid}.
- When a member appears, every other connected member creates/accepts a direct WebRTC peer connection with them.
- This is a mesh group call: each participant has one direct peer connection to every other connected participant.
- A participant who is not currently in the room can be rung through calls/{chatId}/ringing/{uid}.
- The notification still uses call-notify.php; its ring ID identifies the invitation. The recipient then opens the chat call and automatically joins the existing room.
- The participant list shows In call, Not in call, or You. Only people not already in the call get a Ring button.
- The old one-remote-video/single-session architecture has been removed.
- The call page now has explicit Firebase auth-state initialization. The previous version never initialized me, which is why it displayed only “Call / Loading…” and no participants.
- WebRTC currently uses Google public STUN only. TURN has not been added yet.

## Next call-system steps
1. Replace the old /calls rules with rules matching members, peers, and ringing.
2. Test two users entering the same chat call and verify they connect automatically without ringing.
3. Test a third user joining an existing call and verify all three mesh connections form.
4. Test ringing another chat member who is not currently in the call.
5. Test camera, microphone, ICE, hangup, and screen sharing with multiple participants.
6. Add TURN if direct/STUN connections fail on restrictive networks.
7. Later, consider an SFU if group calls become large; mesh connection count grows with each participant.

## /calls rules required in Firebase
The client changes are committed, but the live Realtime Database rules still need a `calls` section. Do not put a broad `.read` or `.write` on `calls/$chatId`, because Realtime Database rules cascade from parent paths. citeturn2search0turn2search6

Add this inside the existing top-level `rules` object:

```json
"calls": {
  "$chatId": {
    "ringing": {
      "$uid": {
        ".read": "auth != null && root.child('privateChats').child($chatId).child('participants').child(auth.uid).exists() && ($uid === auth.uid || (data.child('fromUid').val() === auth.uid))",
        ".write": "auth != null && root.child('privateChats').child($chatId).child('participants').child(auth.uid).exists() && root.child('privateChats').child($chatId).child('participants').child($uid).exists() && ($uid === auth.uid || data.child('fromUid').val() === auth.uid || newData.child('fromUid').val() === auth.uid)",
        ".validate": "newData.hasChildren(['sessionId','fromUid','createdAt']) && newData.child('sessionId').isString() && newData.child('fromUid').val() === auth.uid && newData.child('createdAt').isNumber()"
      }
    },
    "sessions": {
      "$sessionId": {
        ".read": "auth != null && root.child('privateChats').child($chatId).child('participants').child(auth.uid).exists() && (data.child('fromUid').val() === auth.uid || data.child('toUid').val() === auth.uid)",
        ".write": "!data.exists() && auth != null && root.child('privateChats').child($chatId).child('participants').child(auth.uid).exists() && newData.child('fromUid').val() === auth.uid && root.child('privateChats').child($chatId).child('participants').child(newData.child('toUid').val()).exists()",
        ".validate": "newData.hasChildren(['fromUid','toUid','state','createdAt']) && newData.child('fromUid').isString() && newData.child('toUid').isString() && newData.child('fromUid').val() !== newData.child('toUid').val() && newData.child('state').isString() && newData.child('createdAt').isNumber()",
        "offer": {
          ".write": "auth != null && data.parent().child('fromUid').val() === auth.uid",
          ".validate": "newData.hasChildren(['type','sdp']) && newData.child('type').val() === 'offer' && newData.child('sdp').isString()"
        },
        "answer": {
          ".write": "auth != null && data.parent().child('toUid').val() === auth.uid",
          ".validate": "newData.hasChildren(['type','sdp']) && newData.child('type').val() === 'answer' && newData.child('sdp').isString()"
        },
        "state": {
          ".write": "auth != null && (data.parent().child('fromUid').val() === auth.uid || data.parent().child('toUid').val() === auth.uid)",
          ".validate": "newData.val() === 'ringing' || newData.val() === 'accepted' || newData.val() === 'connected' || newData.val() === 'declined' || newData.val() === 'ended'"
        },
        "candidates": {
          "$uid": {
            ".read": "auth != null && (data.parent().parent().child('fromUid').val() === auth.uid || data.parent().parent().child('toUid').val() === auth.uid)",
            ".write": "auth != null && $uid === auth.uid && (data.parent().parent().child('fromUid').val() === auth.uid || data.parent().parent().child('toUid').val() === auth.uid)",
            "$candidateId": {
              ".validate": "newData.hasChildren(['candidate']) && newData.child('candidate').isString()"
            }
          }
        }
      }
    }
  }
}
```

These rules intentionally grant only the session participants access to their signaling data and let the caller write the initial session while the callee writes the answer. Realtime Database uses `auth.uid`, `data`, `newData`, and `root` for these checks. citeturn2search1turn2search5
