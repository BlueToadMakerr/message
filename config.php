<?php
// Public-ish configuration for the PHP helpers (no secrets here — those live in secrets.php).
return [
    // Same web API key that's already in the client config. Used only to verify the caller's ID token.
    'api_key'      => 'AIzaSyBNynmpC9-jTZd56WnpsjnbJa7THeyTMWY',
    'project_id'   => 'quickmessage-ac953',
    'database_url' => 'https://quickmessage-ac953-default-rtdb.firebaseio.com',
    // Where the app is hosted (must end with a slash). Used for notification click-through links.
    'app_url'      => 'https://msg.infinityfreeapp.com/',
];
