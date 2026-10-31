<?php
// "Private-server look-alike" for the Firebase setup. The compatibility client (legacy/) talks to this exactly like it talks to server/qm_server.py,
// so a very old browser can use the Firebase database with an email + password account (no Google sign-in).
//   POST lite.php?r=auth/login|auth/signup   {email, password}  -> {token}
//   GET  lite.php?r=lite/chats | lite/messages&chat=&after=      POST lite.php?r=lite/send | lite/newchat
// Accounts are real Firebase Auth email/password accounts. Someone who only ever used Google sign-in must first add a password in the app (Account).
// Messages are plain text in chats that are NOT end-to-end encrypted (an old browser has no cryptography). Uses the service account in secrets.php.
declare(strict_types=1);
require __DIR__ . '/lib.php';
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: Authorization, Content-Type');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') { http_response_code(204); exit; }

$config = require __DIR__ . '/config.php';
$sa = require __DIR__ . '/secrets.php';
$route = (string)($_GET['r'] ?? '');
$body = json_decode((string)file_get_contents('php://input'), true);
if (!is_array($body)) $body = [];
$db = rtrim($config['database_url'], '/');
$SECRET = hash('sha256', 'qm-lite|' . $sa['private_key'], true);       // signs this script's session tokens; never leaves the server

function lt_token(string $uid): string {
    global $SECRET;
    $b = qm_b64url(json_encode(['u' => $uid, 'e' => time() + 60 * 86400]));
    return $b . '.' . hash_hmac('sha256', $b, $SECRET);
}
function lt_uid(): ?string {
    global $SECRET;
    $h = $_SERVER['HTTP_AUTHORIZATION'] ?? ($_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '');
    if (!$h && function_exists('getallheaders')) { foreach (getallheaders() as $k => $v) if (strtolower($k) === 'authorization') $h = $v; }
    $t = stripos($h, 'Bearer ') === 0 ? substr($h, 7) : (string)($_GET['token'] ?? '');       // some free hosts strip the Authorization header: the client also sends ?token=
    $p = explode('.', $t);
    if (count($p) !== 2 || !hash_equals(hash_hmac('sha256', $p[0], $SECRET), $p[1])) return null;
    $d = json_decode((string)base64_decode(strtr($p[0], '-_', '+/')), true);
    return is_array($d) && ($d['e'] ?? 0) > time() && is_string($d['u'] ?? null) ? $d['u'] : null;
}
function lt_db_token(): string {
    global $sa;
    $t = qm_service_token($sa, 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email');
    if (!$t) qm_out(500, ['error' => 'Server could not authenticate.']);
    return $t;
}
function lt_get(string $path, string $q = ''): mixed {
    global $db;
    return qm_http('GET', "$db/$path.json" . ($q ? "?$q" : ''), ['Authorization: Bearer ' . lt_db_token()])['json'];
}
function lt_update(array $updates): bool {
    global $db;
    $r = qm_http('PATCH', "$db/.json", ['Authorization: Bearer ' . lt_db_token(), 'Content-Type: application/json'], json_encode($updates, JSON_UNESCAPED_UNICODE | JSON_FORCE_OBJECT));
    return $r['code'] >= 200 && $r['code'] < 300;
}
/** Several GETs at once: [key => path-with-query] -> [key => decoded json]. */
function lt_multi(array $paths): array {
    global $db;
    $tok = lt_db_token(); $mh = curl_multi_init(); $hs = [];
    foreach ($paths as $k => $p) {
        $ch = curl_init("$db/$p"); curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 15, CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . $tok]]);
        curl_multi_add_handle($mh, $ch); $hs[$k] = $ch;
    }
    do { $st = curl_multi_exec($mh, $run); if ($run) curl_multi_select($mh, 1.0); } while ($run && $st === CURLM_OK);
    $out = [];
    foreach ($hs as $k => $ch) { $out[$k] = json_decode((string)curl_multi_getcontent($ch), true); curl_multi_remove_handle($mh, $ch); curl_close($ch); }
    curl_multi_close($mh);
    return $out;
}
function lt_push_id(): string {
    $c = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz'; $t = (int)(microtime(true) * 1000); $s = '';
    for ($i = 0; $i < 8; $i++) { $s = $c[$t % 64] . $s; $t = intdiv($t, 64); }
    for ($i = 0; $i < 12; $i++) $s .= $c[random_int(0, 63)];
    return '-' . $s;
}
function lt_name(string $uid): string {
    $n = lt_get('accsettings/' . rawurlencode($uid) . '/settings/displayName');
    return is_string($n) && trim($n) !== '' ? $n : 'Unknown user';
}
function lt_member(string $chat, string $uid): bool {
    if (!preg_match('/^[A-Za-z0-9_-]{1,64}$/', $chat)) return false;
    $p = lt_get('privateChats/' . $chat . '/participants');
    return is_array($p) && !empty($p[$uid]);
}

// ---------------------------------------------------------------- accounts
if ($route === 'ping') qm_out(200, ['ok' => true, 'server' => 'quickmessage-lite-php', 'signup' => true]);
if ($route === 'auth/login' || $route === 'auth/signup') {
    qm_rate('lite:' . ($_SERVER['REMOTE_ADDR'] ?? '?'), 30, 600);
    $email = trim((string)($body['email'] ?? '')); $pw = (string)($body['password'] ?? '');
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) qm_out(400, ['error' => 'Enter a valid email address.']);
    if (strlen($pw) < 6) qm_out(400, ['error' => 'The password needs at least 6 characters.']);
    $kind = $route === 'auth/signup' ? 'signUp' : 'signInWithPassword';
    $r = qm_http('POST', 'https://identitytoolkit.googleapis.com/v1/accounts:' . $kind . '?key=' . urlencode($config['api_key']), ['Content-Type: application/json'],
        json_encode(['email' => $email, 'password' => $pw, 'returnSecureToken' => true]));
    $uid = $r['json']['localId'] ?? null;
    if ($r['code'] !== 200 || !is_string($uid)) {
        $m = (string)($r['json']['error']['message'] ?? '');
        qm_out(401, ['error' => str_contains($m, 'EMAIL_EXISTS') ? 'That email already has an account. Log in instead.' : (str_contains($m, 'OPERATION_NOT_ALLOWED') ? 'Email/password sign-in is not enabled for this project.' : 'Wrong email or password.')]);
    }
    if ($kind === 'signUp') {
        qm_http('POST', 'https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=' . urlencode($config['api_key']), ['Content-Type: application/json'],
            json_encode(['requestType' => 'VERIFY_EMAIL', 'idToken' => $r['json']['idToken'] ?? '']));          // so the same account can use the full app later
    }
    if (!is_string(lt_get('accsettings/' . rawurlencode($uid) . '/settings/displayName')))
        lt_update(['accsettings/' . $uid . '/settings/displayName' => substr(explode('@', $email)[0], 0, 40)]);
    qm_out(200, ['token' => lt_token($uid), 'user' => ['uid' => $uid, 'email' => $email]]);
}

$uid = lt_uid();
if (!$uid) qm_out(401, ['error' => 'Not signed in', 'code' => 'auth/expired']);

if ($route === 'lite/chats') {
    $list = lt_get('chatList/' . rawurlencode($uid));
    $ids = is_array($list) ? array_slice(array_keys($list), 0, 40) : [];
    $req = [];
    foreach ($ids as $c) {
        if (!preg_match('/^[A-Za-z0-9_-]{1,64}$/', (string)$c)) continue;
        $req["p$c"] = "privateChats/$c/participants.json"; $req["l$c"] = "privateChats/$c/lastMessage.json";
        $req["n$c"] = "privateChats/$c/chatData/name.json"; $req["e$c"] = "privateChats/$c/chatData/encrypted.json";
    }
    $r = $req ? lt_multi($req) : [];
    $names = []; $chats = [];
    foreach ($ids as $c) {
        $p = $r["p$c"] ?? null;
        if (!is_array($p) || empty($p[$uid])) continue;
        foreach (array_keys($p) as $u) if ($u !== $uid && !isset($names[$u])) $names[$u] = null;
    }
    $nm = []; foreach (array_keys($names) as $u) $nm["u$u"] = 'accsettings/' . rawurlencode((string)$u) . '/settings/displayName.json';
    $nr = $nm ? lt_multi($nm) : [];
    foreach ($ids as $c) {
        $p = $r["p$c"] ?? null; if (!is_array($p) || empty($p[$uid])) continue;
        $last = is_array($r["l$c"] ?? null) ? $r["l$c"] : [];
        $others = []; foreach (array_keys($p) as $u) if ($u !== $uid) $others[] = is_string($nr["u$u"] ?? null) ? $nr["u$u"] : 'Unknown user';
        $custom = $r["n$c"] ?? null;
        $chats[] = ['id' => $c, 'name' => is_string($custom) && $custom !== '' ? $custom : (implode(', ', $others) ?: 'Chat'), 'last' => !empty($last['enc']) ? '(encrypted)' : (string)($last['text'] ?? ''),
                    'ts' => (int)($last['timestamp'] ?? 0), 'enc' => !empty($r["e$c"])];
    }
    usort($chats, fn($a, $b) => $b['ts'] <=> $a['ts']);
    qm_out(200, ['me' => lt_name($uid), 'chats' => $chats]);
}
if ($route === 'lite/messages') {
    $chat = (string)($_GET['chat'] ?? ''); $after = (string)($_GET['after'] ?? '');
    if (!lt_member($chat, $uid)) qm_out(403, ['messages' => []]);
    $q = 'orderBy=' . rawurlencode('"$key"') . '&limitToLast=' . ($after === '' ? 60 : 200);
    $node = lt_get('privateChats/' . $chat . '/messages', $q);
    $out = []; $nm = [];
    if (is_array($node)) { ksort($node);
        foreach ($node as $k => $m) {
            if (!is_array($m) || ($after !== '' && strcmp((string)$k, $after) <= 0) || ($m['type'] ?? '') === 'event') continue;
            $t = $m['type'] ?? 'text';
            $text = !empty($m['enc']) ? '(encrypted message - open QuickMessage on a newer browser to read it)' : ($t === 'text' ? (string)($m['text'] ?? '') : ($t === 'file' ? '[file: ' . ($m['name'] ?? $m['text'] ?? '') . ']' : "[$t]"));
            $f = (string)($m['fromUid'] ?? ''); if (!isset($nm[$f])) $nm[$f] = lt_name($f);
            $out[] = ['key' => (string)$k, 'from' => $f, 'name' => $nm[$f], 'me' => $f === $uid, 'text' => $text, 'ts' => (int)($m['timestamp'] ?? 0)];
        }
    }
    qm_out(200, ['messages' => $out]);
}
if ($route === 'lite/send') {
    $chat = (string)($body['chat'] ?? ''); $text = mb_substr((string)($body['text'] ?? ''), 0, 4000);
    if (trim($text) === '' || !lt_member($chat, $uid)) qm_out(200, ['ok' => false]);
    if (lt_get('privateChats/' . $chat . '/chatData/encrypted')) qm_out(200, ['ok' => false]);
    $key = lt_push_id(); $ts = (int)(microtime(true) * 1000);
    $up = ["privateChats/$chat/messages/$key" => ['fromUid' => $uid, 'text' => $text, 'timestamp' => $ts, 'deliveredAt' => $ts],
           "privateChats/$chat/lastMessage" => ['fromUid' => $uid, 'text' => $text, 'timestamp' => $ts, 'id' => $key],
           "privateChats/$chat/messageRead/$uid" => $key];
    foreach ((array)lt_get('privateChats/' . $chat . '/participants') as $u => $_) if ($u !== $uid) $up["live/$u/pings/$chat"] = ['id' => $key, 'ts' => $ts, 'from' => $uid];
    qm_out(200, ['ok' => lt_update($up)]);          // the Cloud Function sends the push notification for the new message
}
if ($route === 'lite/newchat') {
    $email = strtolower(trim((string)($body['email'] ?? '')));
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) qm_out(404, ['error' => 'No account with that email.']);
    $tok = lt_db_token();
    $r = qm_http('POST', 'https://identitytoolkit.googleapis.com/v1/projects/' . $config['project_id'] . '/accounts:lookup', ['Authorization: Bearer ' . $tok, 'Content-Type: application/json'], json_encode(['email' => [$email]]));
    $other = $r['json']['users'][0]['localId'] ?? null;
    $okMail = !empty($r['json']['users'][0]['emailVerified']) && lt_get('accsettings/' . rawurlencode((string)$other) . '/settings/emailAdd') !== false;     // same privacy rule as the app: verified and "let people add me by email"
    if (!is_string($other) || $other === $uid || !$okMail) qm_out(404, ['error' => 'No one can be added with that email.']);
    $chat = lt_push_id(); $ts = (int)(microtime(true) * 1000);
    $ok = lt_update(["privateChats/$chat" => ['participants' => [$uid => true, $other => true], 'lastMessage' => ['fromUid' => '', 'text' => '(No messages yet)', 'timestamp' => $ts]],
                     "chatList/$uid/$chat" => true, "chatList/$other/$chat" => true]);
    qm_out($ok ? 200 : 500, ['chat' => $ok ? $chat : null]);
}
qm_out(404, ['error' => 'unknown route']);
