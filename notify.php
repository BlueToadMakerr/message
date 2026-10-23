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

// ---------------------------------------------------------------- HTTP helper
function http(string $method, string $url, array $headers = [], ?string $body = null): array {
    $respHeaders = [];
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST  => $method,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 15,
        CURLOPT_CONNECTTIMEOUT => 8,
        CURLOPT_HTTPHEADER     => $headers,
        CURLOPT_HEADERFUNCTION => function ($c, $line) use (&$respHeaders) {
            $parts = explode(':', $line, 2);
            if (count($parts) === 2) $respHeaders[strtolower(trim($parts[0]))] = trim($parts[1]);
            return strlen($line);
        },
    ]);
    if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
    $res  = curl_exec($ch);
    $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return [
        'code'    => $code,
        'body'    => $res === false ? null : $res,
        'json'    => is_string($res) ? json_decode($res, true) : null,
        'headers' => $respHeaders,
    ];
}

function b64url(string $s): string {
    return rtrim(strtr(base64_encode($s), '+/', '-_'), '=');
}

// ---------------------------------------------------------------- 1. verify caller
$lookup = http(
    'POST',
    'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' . urlencode($config['api_key']),
    ['Content-Type: application/json'],
    json_encode(['idToken' => $idToken])
);
$uid = $lookup['json']['users'][0]['localId'] ?? null;
if ($lookup['code'] !== 200 || !is_string($uid) || $uid === '') {
    out(401, ['error' => 'Invalid or expired ID token']);
}

// ---------------------------------------------------------------- 2. service-account token (cached)
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

function dbGet(string $db, array $auth, string $path): array {
    return http('GET', "$db/$path.json", $auth);
}

// ---------------------------------------------------------------- 3. participant check
$participants = dbGet($db, $auth, "privateChats/$chatId/participants")['json'];
if (!is_array($participants) || !isset($participants[$uid])) {
    out(403, ['error' => 'You are not a participant of this chat']);
}

// ---------------------------------------------------------------- 4. latest message + atomic "notified" flag
$res = http('GET', "$db/privateChats/$chatId/lastMessage.json", array_merge($auth, ['X-Firebase-ETag: true']));
$lastMessage = $res['json'];
$etag        = $res['headers']['etag'] ?? null;
if (!is_array($lastMessage) || !isset($lastMessage['text'])) {
    out(404, ['error' => 'No lastMessage found']);
}
if (($lastMessage['fromUid'] ?? '') !== $uid) {
    out(403, ['error' => 'Only the sender can trigger notifications for a message']);
}
if (!empty($lastMessage['notifSent'])) {
    out(200, ['status' => 'skipped', 'reason' => 'already sent']);
}

if ($etag !== null) {
    $flagged = $lastMessage + ['notifSent' => true];
    $flagged['notifSent'] = true;
    $put = http('PUT', "$db/privateChats/$chatId/lastMessage.json",
        array_merge($auth, ['Content-Type: application/json', 'if-match: ' . $etag]),
        json_encode($flagged, JSON_UNESCAPED_UNICODE));
    if ($put['code'] === 412) {
        out(200, ['status' => 'skipped', 'reason' => 'another request is already handling this message']);
    }
}

// ---------------------------------------------------------------- 5. sender name + recipient tokens
$senderName = dbGet($db, $auth, "accsettings/$uid/settings/displayName")['json'];
if (!is_string($senderName) || trim($senderName) === '') $senderName = 'New message';

$lastId = isset($lastMessage['id']) ? (string)$lastMessage['id'] : null;
$tokensByUser = [];
foreach (array_keys($participants) as $pUid) {
    $pUid = (string)$pUid;
    if ($pUid === $uid) continue;

    if ($lastId !== null) {
        $read = dbGet($db, $auth, "privateChats/$chatId/messageRead/" . rawurlencode($pUid))['json'];
        if ($read !== null && (string)$read === $lastId) continue; // already read it
    }
    $data = dbGet($db, $auth, 'FCM/' . rawurlencode($pUid))['json'];
    if (is_array($data) && $data) $tokensByUser[$pUid] = array_keys($data);
}

// ---------------------------------------------------------------- 6. send
$link    = rtrim($config['app_url'], '/') . '/message.html?chatId=' . rawurlencode($chatId);
$body    = !empty($lastMessage['enc']) ? '🔒 New message' : mb_strimwidth((string)$lastMessage['text'], 0, 100, '…');   // encrypted chats: the server can't read the text
$fcmUrl  = 'https://fcm.googleapis.com/v1/projects/' . $config['project_id'] . '/messages:send';
$results = [];

foreach ($tokensByUser as $pUid => $tokens) {
    foreach ($tokens as $deviceToken) {
        $payload = ['message' => [
            'token'        => (string)$deviceToken,
            'notification' => ['title' => $senderName, 'body' => $body],
            'android'      => ['collapse_key' => "chat_$chatId", 'notification' => ['tag' => "chat_$chatId"]],
            'webpush'      => [
                'headers'     => ['TTL' => '3600'],
                'notification'=> ['tag' => "chat_$chatId", 'renotify' => true, 'requireInteraction' => false],
                'fcm_options' => ['link' => $link],
            ],
            'apns'         => [
                'headers' => ['apns-collapse-id' => "chat_$chatId"],
                'payload' => ['aps' => ['alert' => ['title' => $senderName, 'body' => $body], 'sound' => 'default']],
            ],
            'data'         => ['link' => $link, 'chatId' => $chatId],
        ]];

        $r = http('POST', $fcmUrl,
            ['Authorization: Bearer ' . $token, 'Content-Type: application/json'],
            json_encode($payload, JSON_UNESCAPED_UNICODE));

        $removed = false;
        $status  = $r['json']['error']['status'] ?? null;
        $message = (string)($r['json']['error']['message'] ?? '');
        $dead = in_array($status, ['NOT_FOUND', 'UNREGISTERED'], true)
             || ($status === 'INVALID_ARGUMENT' && stripos($message, 'registration token') !== false);
        if ($dead) {
            http('DELETE', "$db/FCM/" . rawurlencode((string)$pUid) . '/' . rawurlencode((string)$deviceToken) . '.json', $auth);
            $removed = true;
        }
        $results[] = ['status' => $r['code'], 'removed' => $removed];
    }
}

out(200, ['status' => 'sent', 'results' => $results]);
