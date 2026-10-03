<?php
declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function out(int $code, array $data): never {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') out(405, ['error' => 'Use POST']);

$config = require __DIR__ . '/config.php';
$serviceAccount = require __DIR__ . '/secrets.php';
$chatId = (string)($_POST['chatId'] ?? '');
$targetUid = (string)($_POST['targetUid'] ?? '');
$sessionId = (string)($_POST['sessionId'] ?? '');
$idToken = (string)($_POST['idToken'] ?? '');

if (!preg_match('/^[A-Za-z0-9_-]{1,64}$/', $chatId) ||
    !preg_match('/^[A-Za-z0-9_-]{1,128}$/', $targetUid) ||
    !preg_match('/^[A-Za-z0-9_-]{1,128}$/', $sessionId) || $idToken === '') {
    out(400, ['error' => 'Missing or invalid call parameters']);
}

function http(string $method, string $url, array $headers = [], ?string $body = null): array {
    $respHeaders = [];
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST => $method, CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 15, CURLOPT_CONNECTTIMEOUT => 8,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_HEADERFUNCTION => function ($c, $line) use (&$respHeaders) {
            $parts = explode(':', $line, 2);
            if (count($parts) === 2) $respHeaders[strtolower(trim($parts[0]))] = trim($parts[1]);
            return strlen($line);
        },
    ]);
    if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
    $res = curl_exec($ch);
    $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return ['code' => $code, 'body' => $res === false ? null : $res, 'json' => is_string($res) ? json_decode($res, true) : null, 'headers' => $respHeaders];
}
function b64url(string $s): string { return rtrim(strtr(base64_encode($s), '+/', '-_'), '='); }

$lookup = http(
    'POST',
    'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' . urlencode($config['api_key']),
    ['Content-Type: application/json'],
    json_encode(['idToken' => $idToken])
);
$uid = $lookup['json']['users'][0]['localId'] ?? null;
if ($lookup['code'] !== 200 || !is_string($uid) || $uid === '') out(401, ['error' => 'Invalid or expired ID token']);

function getAccessToken(array $sa): ?string {
    $cache = sys_get_temp_dir() . '/qm_token_' . md5($sa['client_email']) . '.json';
    if (is_readable($cache)) {
        $c = json_decode((string)@file_get_contents($cache), true);
        if (isset($c['token'], $c['exp']) && $c['exp'] > time() + 120) return $c['token'];
    }
    $now = time();
    $claim = [
        'iss' => $sa['client_email'],
        'scope' => 'https://www.googleapis.com/auth/firebase.messaging https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
        'aud' => $sa['token_uri'], 'iat' => $now, 'exp' => $now + 3600,
    ];
    $unsigned = b64url(json_encode(['alg' => 'RS256', 'typ' => 'JWT'])) . '.' . b64url(json_encode($claim));
    if (!openssl_sign($unsigned, $sig, $sa['private_key'], 'SHA256')) return null;
    $res = http('POST', $sa['token_uri'], ['Content-Type: application/x-www-form-urlencoded'], http_build_query([
        'grant_type' => 'urn:ietf:params:oauth:grant-type:jwt-bearer', 'assertion' => $unsigned . '.' . b64url($sig)
    ]));
    $token = $res['json']['access_token'] ?? null;
    if (!$token) return null;
    @file_put_contents($cache, json_encode(['token' => $token, 'exp' => $now + (int)($res['json']['expires_in'] ?? 3000)]), LOCK_EX);
    @chmod($cache, 0600);
    return $token;
}

$token = getAccessToken($serviceAccount);
if (!$token) out(500, ['error' => 'Could not obtain service-account access token']);
$db = rtrim($config['database_url'], '/');
$auth = ['Authorization: Bearer ' . $token];

function dbGet(string $db, array $auth, string $path): array {
    return http('GET', "$db/$path.json", $auth);
}

$participants = dbGet($db, $auth, 'privateChats/' . rawurlencode($chatId) . '/participants')['json'];
if (!is_array($participants) || !isset($participants[$uid]) || !isset($participants[$targetUid])) {
    out(403, ['error' => 'Both users must be members of this chat']);
}
if ($uid === $targetUid) out(400, ['error' => 'You cannot call yourself']);

$senderName = dbGet($db, $auth, 'accsettings/' . rawurlencode($uid) . '/settings/displayName')['json'];
if (!is_string($senderName) || trim($senderName) === '') $senderName = 'QuickMessage';

$tokens = dbGet($db, $auth, 'FCM/' . rawurlencode($targetUid))['json'];
if (!is_array($tokens) || !$tokens) out(200, ['status' => 'no_token', 'accepted' => 0, 'failed' => 0]);

$link = rtrim($config['app_url'], '/') . '/call.html?chatId=' . rawurlencode($chatId) . '&session=' . rawurlencode($sessionId);
$fcmUrl = 'https://fcm.googleapis.com/v1/projects/' . $config['project_id'] . '/messages:send';
$accepted = 0; $failed = 0; $removed = 0;

foreach (array_keys($tokens) as $deviceToken) {
    $payload = ['message' => [
        'token' => (string)$deviceToken,
        'notification' => ['title' => 'Incoming call', 'body' => $senderName . ' is calling you'],
        'webpush' => [
            'headers' => ['TTL' => '60'],
            'notification' => ['title' => 'Incoming call', 'body' => $senderName . ' is calling you', 'tag' => 'call_' . $chatId, 'renotify' => true, 'requireInteraction' => true],
            'fcm_options' => ['link' => $link]
        ],
        'data' => ['call' => '1', 'chatId' => $chatId, 'sessionId' => $sessionId, 'link' => $link]
    ]];

    $r = http('POST', $fcmUrl, ['Authorization: Bearer ' . $token, 'Content-Type: application/json'], json_encode($payload, JSON_UNESCAPED_UNICODE));
    if ($r['code'] >= 200 && $r['code'] < 300) { $accepted++; continue; }

    $failed++;
    $status = $r['json']['error']['status'] ?? null;
    $message = (string)($r['json']['error']['message'] ?? '');
    $dead = in_array($status, ['NOT_FOUND', 'UNREGISTERED'], true)
         || ($status === 'INVALID_ARGUMENT' && stripos($message, 'registration token') !== false);
    if ($dead) {
        http('DELETE', "$db/FCM/" . rawurlencode($targetUid) . '/' . rawurlencode((string)$deviceToken) . '.json', $auth);
        $removed++;
    }
}
out(200, $accepted > 0
    ? ['status' => 'sent', 'accepted' => $accepted, 'failed' => $failed, 'removed' => $removed]
    : ['status' => 'failed', 'accepted' => 0, 'failed' => $failed, 'removed' => $removed]);
