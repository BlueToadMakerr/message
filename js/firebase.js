// Shared Firebase initialisation. The web config below is public by design
// (security comes from your Realtime Database rules, not from hiding this).
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-database.js";

export const firebaseConfig = {
  apiKey: "AIzaSyBNynmpC9-jTZd56WnpsjnbJa7THeyTMWY",
  authDomain: "quickmessage-ac953.firebaseapp.com",
  projectId: "quickmessage-ac953",
  storageBucket: "quickmessage-ac953.firebasestorage.app",
  messagingSenderId: "841093269538",
  appId: "1:841093269538:web:9679b67cfd0939a02ea27b",
  measurementId: "G-B1Z5T0H4PR"
};

export const VAPID_KEY =
  "BI-mhcctjGRymM3U9kCjsrEma7n6572wBZrZDcFm-PlMNKis7REyQabUTBbpFeKg61WtBb60L1y3VwWzsqTVF8s";

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getDatabase(app);
