// ICE servers for WebRTC.
//
// STUN alone connects most home/mobile networks. Symmetric NATs, some corporate/school networks and
// some carrier-grade NATs need a TURN relay. When you have one (self-hosted coturn, Cloudflare Calls,
// Metered, Twilio, …) add it below — the call UI will show "Connection failed" for peers that can't
// connect directly, which is the sign you need it.
export const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" }
  // {
  //   urls: ["turn:turn.example.com:3478?transport=udp", "turns:turn.example.com:5349?transport=tcp"],
  //   username: "…",
  //   credential: "…"
  // }
];

export const RTC_CONFIG = { iceServers: ICE_SERVERS, bundlePolicy: "max-bundle" };
