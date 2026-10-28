<?php
declare(strict_types=1);

/**
 * Sends push notifications for the newest message in a chat.
 *
 * POST params: chatId, idToken (the caller's Firebase ID token)
 *
 * Differences from the previous version:
 *  - The caller is authenticated by verifying their ID token; the old version trusted a ?uid= query value,
 *    so anyone could impersonate any participant.
 *  - No hard-coded admin e-mail/password: the service account itself is used for Realtime Database access.
 *  - The "already notified" flag is set with a conditional (ETag) write, so concurrent calls can't double-send.
 *  - Only tokens FCM reports as dead are deleted (INVALID_ARGUMENT used to wipe tokens on any payload error).
 *
 * Speed: the slow part used to be ~10 + (people × 2) requests one after another. Now independent requests run at the same time
 * (curl_multi: 3 rounds before the answer), the caller gets its answer as soon as the "notified" flag is set, and the pushes go out
 * right after that. Pushes are sent with high priority so Android / Chrome / iOS deliver them at once instead of batching them.
 */

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function out(int $code, array $data): never {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    out(405, ['error' => 'Use POST']);
}

$config         = require __DIR__ . '/config.php';
$serviceAccount = require __DIR__ . '/secrets.php';

$chatId  = (string)($_POST['chatId'] ?? '');
$idToken = (string)($_POST['idToken'] ?? '');
if (!preg_match('/^[A-Za-z0-9_-]{1,64}$/', $chatId) || $idToken === '') {
    out(400, ['error' => 'Missing or invalid chatId / idToken']);
}

// ---------------------------------------------------------------- HTTP helpers
/** Runs several requests at the same time. $reqs: key => [method, url, headers, body]. Returns key => [code, body, json, headers]. */
function httpMulti(array $reqs): array {
    if (!$reqs) return [];
    $mh = curl_multi_init();
    $handles = []; $hdrs = [];
    foreach ($reqs as $k => $r) {
        [$method, $url, $headers, $body] = $r + [null, null, [], null];
        $hdrs[$k] = [];
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST  => $method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 12,
            CURLOPT_CONNECTTIMEOUT => 6,
            CURLOPT_HTTPHEADER     => $headers,
            CURLOPT_HEADERFUNCTION => function ($c, $line) use (&$hdrs, $k) {
                $parts = explode(':', $line, 2);
                if (count($parts) === 2) $hdrs[$k][strtolower(trim($parts[0]))] = trim($parts[1]);
                return strlen($line);
            },
        ]);
        if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        curl_multi_add_handle($mh, $ch);
        $handles[$k] = $ch;
    }
    $running = 0;
    do {
        $st = curl_multi_exec($mh, $running);
        if ($running > 0 && curl_multi_select($mh, 1.0) === -1) usleep(2000);
    } while ($running > 0 && $st === CURLM_OK);
    $out = [];
    foreach ($handles as $k => $ch) {
        $res = curl_multi_getcontent($ch);
        $ok  = curl_errno($ch) === 0;
        $out[$k] = [
            'code'    => (int)curl_getinfo($ch, CURLINFO_HTTP_CODE),
            'body'    => $ok && is_string($res) ? $res : null,
            'json'    => $ok && is_string($res) ? json_decode($res, true) : null,
            'headers' => $hdrs[$k],
        ];
        curl_multi_remove_handle($mh, $ch);
        curl_close($ch);
    }
    curl_multi_close($mh);
    return $out;
}

function http(string $method, string $url, array $headers = [], ?string $body = null): array {
    return httpMulti(['x' => [$method, $url, $headers, $body]])['x'];
}

function b64url(string $s): string {
    return rtrim(strtr(base64_encode($s), '+/', '-_'), '=');
}

/** Answers the caller now and keeps working in the background (so the sender's app never waits for the pushes to be delivered). */
function respondEarly(array $data): void {
    ignore_user_abort(true);
    @set_time_limit(60);
    $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    if (function_exists('fastcgi_finish_request')) { echo $json; fastcgi_finish_request(); return; }
    header('Connection: close');
    header('Content-Length: ' . strlen($json));
    echo $json;
    while (ob_get_level() > 0) @ob_end_flush();
    flush();
}

// ---------------------------------------------------------------- 1. service-account token (cached)
function getAccessToken(array $sa): ?string {
    $cache = sys_get_temp_dir() . '/qm_token_' . md5($sa['client_email']) . '.json';
    if (is_readable($cache)) {
        $c = json_decode((string)@file_get_contents($cache), true);
        if (isset($c['token'], $c['exp']) && $c['exp'] > time() + 120) return $c['token'];
    }

    $now   = time();
    $claim = [
        'iss'   => $sa['client_email'],
        'scope' => 'https://www.googleapis.com/auth/firebase.messaging '
                 . 'https://www.googleapis.com/auth/firebase.database '
                 . 'https://www.googleapis.com/auth/userinfo.email',
        'aud'   => $sa['token_uri'],
        'iat'   => $now,
        'exp'   => $now + 3600,
    ];
    $unsigned = b64url(json_encode(['alg' => 'RS256', 'typ' => 'JWT'])) . '.' . b64url(json_encode($claim));
    if (!openssl_sign($unsigned, $sig, $sa['private_key'], 'SHA256')) return null;

    $res = http('POST', $sa['token_uri'], ['Content-Type: application/x-www-form-urlencoded'], http_build_query([
        'grant_type' => 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        'assertion'  => $unsigned . '.' . b64url($sig),
    ]));
    $token = $res['json']['access_token'] ?? null;
    if (!$token) return null;

    @file_put_contents($cache, json_encode([
        'token' => $token,
        'exp'   => $now + (int)($res['json']['expires_in'] ?? 3000),
    ]), LOCK_EX);
    @chmod($cache, 0600);
    return $token;
}

$token = getAccessToken($serviceAccount);
if (!$token) out(500, ['error' => 'Could not obtain service-account access token']);

$db   = rtrim($config['database_url'], '/');
$auth = ['Authorization: Bearer ' . $token];
$dbGet = fn(string $path, array $extra = []) => ['GET', "$db/$path.json", array_merge($auth, $extra), null];

// ---------------------------------------------------------------- 2. round 1 (together): who is calling · who is in the chat · the newest message
$r1 = httpMulti([
    'who'  => ['POST', 'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' . urlencode($config['api_key']), ['Content-Type: application/json'], json_encode(['idToken' => $idToken])],
    'part' => $dbGet("privateChats/$chatId/participants"),
    'last' => $dbGet("privateChats/$chatId/lastMessage", ['X-Firebase-ETag: true']),
]);
$uid = $r1['who']['json']['users'][0]['localId'] ?? null;
if ($r1['who']['code'] !== 200 || !is_string($uid) || $uid === '') {
    out(401, ['error' => 'Invalid or expired ID token']);
}
$participants = $r1['part']['json'];
if (!is_array($participants) || !isset($participants[$uid])) {
    out(403, ['error' => 'You are not a participant of this chat']);
}
$lastMessage = $r1['last']['json'];
$etag        = $r1['last']['headers']['etag'] ?? null;
if (!is_array($lastMessage) || !isset($lastMessage['text'])) {
    out(404, ['error' => 'No lastMessage found']);
}
if (($lastMessage['fromUid'] ?? '') !== $uid) {
    out(403, ['error' => 'Only the sender can trigger notifications for a message']);
}
if (!empty($lastMessage['notifSent'])) {
    out(200, ['status' => 'skipped', 'reason' => 'already sent']);
}

// ---------------------------------------------------------------- 3. round 2 (together): mark as notified · sender name · who has read it · everybody's push tokens
$lastId = isset($lastMessage['id']) ? (string)$lastMessage['id'] : null;
$reqs = [];
if ($etag !== null) {
    $flagged = $lastMessage;
    $flagged['notifSent'] = true;
    $reqs['flag'] = ['PUT', "$db/privateChats/$chatId/lastMessage.json",
        array_merge($auth, ['Content-Type: application/json', 'if-match: ' . $etag]), json_encode($flagged, JSON_UNESCAPED_UNICODE)];
}
$reqs['name'] = $dbGet("accsettings/" . rawurlencode($uid) . "/settings/displayName");
$others = [];
foreach (array_keys($participants) as $pUid) {
    $pUid = (string)$pUid;
    if ($pUid === $uid) continue;
    $others[] = $pUid;
    if ($lastId !== null) $reqs["read:$pUid"] = $dbGet("privateChats/$chatId/messageRead/" . rawurlencode($pUid));
    $reqs["fcm:$pUid"] = $dbGet('FCM/' . rawurlencode($pUid));
}
$r2 = httpMulti($reqs);

if (isset($r2['flag']) && $r2['flag']['code'] === 412) {
    out(200, ['status' => 'skipped', 'reason' => 'another request is already handling this message']);
}
$senderName = $r2['name']['json'] ?? null;
if (!is_string($senderName) || trim($senderName) === '') $senderName = 'New message';

$tokensByUser = [];
foreach ($others as $pUid) {
    if ($lastId !== null) {
        $read = $r2["read:$pUid"]['json'] ?? null;
        if ($read !== null && (string)$read === $lastId) continue; // already read it
    }
    $data = $r2["fcm:$pUid"]['json'] ?? null;
    if (is_array($data) && $data) $tokensByUser[$pUid] = array_keys($data);
}

// The sender's app doesn't need to wait for the pushes to be handed over.
respondEarly(['status' => 'sending', 'devices' => array_sum(array_map('count', $tokensByUser))]);

// ---------------------------------------------------------------- 4. round 3 (together): every push at once
$link    = rtrim($config['app_url'], '/') . '/message.html?chatId=' . rawurlencode($chatId);
$body    = !empty($lastMessage['enc']) ? '🔒 New message' : mb_strimwidth((string)$lastMessage['text'], 0, 100, '…');   // encrypted chats: the server can't read the text
$fcmUrl  = 'https://fcm.googleapis.com/v1/projects/' . $config['project_id'] . '/messages:send';
$sends = []; $who = [];
foreach ($tokensByUser as $pUid => $tokens) {
    foreach ($tokens as $deviceToken) {
        $payload = ['message' => [
            'token'        => (string)$deviceToken,
            'notification' => ['title' => $senderName, 'body' => $body],
            'android'      => ['priority' => 'HIGH', 'collapse_key' => "chat_$chatId", 'notification' => ['tag' => "chat_$chatId"]],
            'webpush'      => [
                'headers'     => ['TTL' => '86400', 'Urgency' => 'high'],   // high urgency: delivered at once, not held back to save battery
                'notification'=> ['tag' => "chat_$chatId", 'renotify' => true, 'requireInteraction' => false],
                'fcm_options' => ['link' => $link],
            ],
            'apns'         => [
                'headers' => ['apns-collapse-id' => "chat_$chatId", 'apns-priority' => '10'],
                'payload' => ['aps' => ['alert' => ['title' => $senderName, 'body' => $body], 'sound' => 'default']],
            ],
            'data'         => ['link' => $link, 'chatId' => $chatId],
        ]];
        $key = count($sends);
        $sends["s$key"] = ['POST', $fcmUrl, ['Authorization: Bearer ' . $token, 'Content-Type: application/json'], json_encode($payload, JSON_UNESCAPED_UNICODE)];
        $who["s$key"] = [(string)$pUid, (string)$deviceToken];
    }
}
$r3 = httpMulti($sends);

$cleanup = [];
foreach ($r3 as $k => $r) {
    $status  = $r['json']['error']['status'] ?? null;
    $message = (string)($r['json']['error']['message'] ?? '');
    $dead = in_array($status, ['NOT_FOUND', 'UNREGISTERED'], true)
         || ($status === 'INVALID_ARGUMENT' && stripos($message, 'registration token') !== false);
    if ($dead) $cleanup["d$k"] = ['DELETE', "$db/FCM/" . rawurlencode($who[$k][0]) . '/' . rawurlencode($who[$k][1]) . '.json', $auth, null];
}
httpMulti($cleanup);
exit;
