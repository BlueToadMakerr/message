<?php
// "Private-server look-alike" for the Firebase setup. The compatibility client (legacy/) talks to this exactly like it talks to server/qm_server.py,
// so a very old browser can use the Firebase database with an email + password account (no Google sign-in).
//   POST proxy.php?r=auth/login|auth/signup   {email, password}  -> {token}
//   GET  proxy.php?r=lite/chats | lite/messages&chat=&after=      POST proxy.php?r=lite/send | lite/newchat
// Accounts are real Firebase Auth email/password accounts. Someone who only ever used Google sign-in must first add a password in the app (Account).
// Messages are plain text in chats that are NOT end-to-end encrypted (an old browser has no cryptography). Uses the service account in secrets.php.
declare(strict_types=1);
require __DIR__ . '/lib.php';
// Never answer with a bare "500": turn any PHP problem into a JSON message the compatibility page can show (and a PHP log line).
ini_set('display_errors', '0');
set_error_handler(function (int $no, string $msg, string $file, int $line) { if (!(error_reporting() & $no)) return false; throw new ErrorException($msg, 0, $no, $file, $line); });
set_exception_handler(function (Throwable $e) {
    error_log('proxy.php: ' . $e->getMessage() . ' @' . basename($e->getFile()) . ':' . $e->getLine());
    if (!headers_sent()) { http_response_code(500); header('Content-Type: application/json; charset=utf-8'); }
    echo json_encode(['error' => 'Server error: ' . $e->getMessage() . ' (' . basename($e->getFile()) . ':' . $e->getLine() . ')']);
});
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: Authorization, Content-Type');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') { http_response_code(204); exit; }

$config = require __DIR__ . '/config.php';
if (!is_file(__DIR__ . '/secrets.php')) qm_out(503, ['error' => 'secrets.php is missing on this server. proxy.php needs it: in Firebase console -> Project settings -> Service accounts -> Generate new private key, put the key in secrets.php (see secrets.php format in docs/SETUP-FIREBASE.md) and upload it next to proxy.php. The deploy never uploads it.']);
$sa = require __DIR__ . '/secrets.php';
$route = (string)($_GET['r'] ?? '');
$body = json_decode((string)file_get_contents('php://input'), true);
if (!is_array($body)) $body = [];
// Which Realtime Database: the built-in default (config.php), or the one the page asks for with &db= (same rule as the app: a Firebase database host, https, no path).
$db = rtrim($config['database_url'], '/');
$want = trim((string)($_GET['db'] ?? ''));
if ($want !== '' && preg_match('~^https://[a-z0-9-]+(\.[a-z0-9-]+)*\.(firebaseio\.com|firebasedatabase\.app)/?$~i', $want)) $db = strtolower(rtrim($want, '/'));
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
    if (!$t) qm_out(500, ['error' => 'Server could not get a Google access token (check secrets.php and that the host can reach oauth2.googleapis.com).']);
    return $t;
}
function lt_get(string $path, string $q = ''): mixed {
    global $db;
    $r = qm_http('GET', "$db/$path.json" . ($q ? "?$q" : ''), ['Authorization: Bearer ' . lt_db_token()]);
    if ($r['code'] === 0 || $r['code'] >= 400) qm_out(502, ['error' => 'Database read failed (HTTP ' . $r['code'] . ') at ' . $db . '. ' . substr((string)($r['json']['error'] ?? ''), 0, 120)]);
    return $r['json'];
}
function lt_update(array $updates): bool {
    global $db;
    $r = qm_http('PATCH', "$db/.json", ['Authorization: Bearer ' . lt_db_token(), 'Content-Type: application/json'], json_encode($updates, JSON_UNESCAPED_UNICODE | JSON_FORCE_OBJECT));
    return $r['code'] >= 200 && $r['code'] < 300;
}
/** Several GETs: [key => path-with-query] -> [key => decoded json]. Sequential on purpose: many free hosts disable curl_multi_*. */
function lt_multi(array $paths): array {
    global $db;
    $tok = lt_db_token(); $out = [];
    foreach ($paths as $k => $p) $out[$k] = qm_http('GET', "$db/$p", ['Authorization: Bearer ' . $tok])['json'];
    return $out;
}
function lt_push_id(): string {
    $c = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz'; $t = (int)(microtime(true) * 1000); $s = '';
    for ($i = 0; $i < 8; $i++) { $s = $c[$t % 64] . $s; $t = intdiv($t, 64); }
    for ($i = 0; $i < 12; $i++) $s .= $c[random_int(0, 63)];
    return $s;          // 20 chars like a Firebase push id (its first time char is already '-'); an extra '-' in front made the message sort BEFORE every real one
}
/** Tiny file cache (names, chat membership) so a chat that refreshes every 15 s does not re-read the same small things from the database each time. */
function lt_cache(string $k, ?callable $make = null, int $ttl = 600): mixed {
    global $db;
    $f = sys_get_temp_dir() . '/qm_lt_' . md5($db . '|' . $k) . '.json';
    if (is_readable($f) && filemtime($f) > time() - $ttl) { $c = json_decode((string)@file_get_contents($f), true); if (is_array($c) && array_key_exists('v', $c)) return $c['v']; }
    if (!$make) return null;
    $v = $make(); if ($v !== null) { @file_put_contents($f, json_encode(['v' => $v]), LOCK_EX); @chmod($f, 0600); }
    return $v;
}
function lt_name(string $uid): string {
    return (string)lt_cache('n:' . $uid, function () use ($uid) { return lt_name_raw($uid); });
}
function lt_name_raw(string $uid): string {
    $n = lt_get('accsettings/' . rawurlencode($uid) . '/settings/displayName');
    return is_string($n) && trim($n) !== '' ? $n : 'Unknown user';
}
function lt_member(string $chat, string $uid): bool {
    if (!preg_match('/^[A-Za-z0-9_-]{1,64}$/', $chat)) return false;
    return (bool)lt_cache('m:' . $chat . ':' . $uid, function () use ($chat, $uid) {
        $p = lt_get('privateChats/' . $chat . '/participants');
        return is_array($p) && !empty($p[$uid]) ? true : null;          // only "yes" is remembered
    });
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
    // Loaded once by the page. Only the time/sender of the last message is read (for ordering), never its content.
    $list = lt_get('chatList/' . rawurlencode($uid));
    $ids = is_array($list) ? array_slice(array_keys($list), 0, 40) : [];
    $req = [];
    foreach ($ids as $c) {
        if (!preg_match('/^[A-Za-z0-9_-]{1,64}$/', (string)$c)) continue;
        $req["p$c"] = "privateChats/$c/participants.json"; $req["d$c"] = "privateChats/$c/chatData.json"; $req["t$c"] = "privateChats/$c/lastMessage/timestamp.json"; $req["f$c"] = "privateChats/$c/lastMessage/fromUid.json";
    }
    $r = $req ? lt_multi($req) : [];
    $names = [];
    foreach ($ids as $c) {
        $p = $r["p$c"] ?? null;
        if (!is_array($p) || empty($p[$uid])) continue;
        foreach (array_keys($p) as $u) if ($u !== $uid && !isset($names[$u])) $names[$u] = null;
    }
    $nr = []; foreach (array_keys($names) as $u) $nr["u$u"] = lt_name((string)$u);          // cached for a few minutes
    $chats = [];
    foreach ($ids as $c) {
        $p = $r["p$c"] ?? null; if (!is_array($p) || empty($p[$uid])) continue;
        $cd = is_array($r["d$c"] ?? null) ? $r["d$c"] : [];
        $others = []; foreach (array_keys($p) as $u) if ($u !== $uid) $others[] = is_string($nr["u$u"] ?? null) ? $nr["u$u"] : 'Unknown user';
        $custom = $cd['name'] ?? null;
        $chats[] = ['id' => $c, 'name' => is_string($custom) && $custom !== '' ? $custom : (implode(', ', $others) ?: 'Chat'), 'enc' => !empty($cd['encrypted']),
                    'ts' => is_numeric($r["t$c"] ?? null) ? (int)$r["t$c"] : 0, 'mine' => ($r["f$c"] ?? null) === $uid];          // only the time and sender of the last message, never its text
    }
    qm_out(200, ['me' => lt_name($uid), 'chats' => $chats]);
}
if ($route === 'lite/messages') {
    $chat = (string)($_GET['chat'] ?? ''); $after = (string)($_GET['after'] ?? ''); $before = (string)($_GET['before'] ?? '');
    if (!lt_member($chat, $uid)) qm_out(403, ['messages' => []]);
    $page = 30;
    // $after: only newer messages (refresh). $before: one page of older ones. Neither: the newest page. One extra row tells whether more exist.
    $q = 'orderBy=' . rawurlencode('"$key"') . ($after !== '' ? '&startAt=' . rawurlencode('"' . $after . '"') . '&limitToFirst=200'
        : ($before !== '' ? '&endAt=' . rawurlencode('"' . $before . '"') . '&limitToLast=' . ($page + 2) : '&limitToLast=' . ($page + 1)));
    $node = lt_get('privateChats/' . $chat . '/messages', $q);
    $rows = [];
    if (is_array($node)) { ksort($node);
        foreach ($node as $k => $m) {
            if (!is_array($m) || ($after !== '' && strcmp((string)$k, $after) <= 0) || ($before !== '' && strcmp((string)$k, $before) >= 0)) continue;
            $rows[(string)$k] = $m;
        }
    }
    $more = false;
    if ($after === '' && count($rows) > $page) { $more = true; $rows = array_slice($rows, -$page, null, true); }
    $out = []; $nm = [];
    foreach ($rows as $k => $m) {
        $t = $m['type'] ?? 'text'; if ($t === 'event') continue;
        $text = !empty($m['enc']) ? '(encrypted message - open QuickMessage on a newer browser to read it)' : ($t === 'text' ? (string)($m['text'] ?? '') : ($t === 'file' ? '[file: ' . ($m['name'] ?? $m['text'] ?? '') . ']' : "[$t]"));
        $f = (string)($m['fromUid'] ?? ''); if (!isset($nm[$f])) $nm[$f] = lt_name($f);
        $out[] = ['key' => (string)$k, 'from' => $f, 'name' => $nm[$f], 'me' => $f === $uid, 'text' => $text, 'ts' => (int)($m['timestamp'] ?? 0)];
    }
    qm_out(200, ['messages' => $out, 'more' => $more]);
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
    $ok = lt_update($up);          // the Cloud Function sends the push notification for the new message
    qm_out(200, ['ok' => $ok, 'key' => $ok ? $key : null]);
}
if ($route === 'lite/delete') {
    $chat = (string)($body['chat'] ?? ''); $key = (string)($body['key'] ?? '');
    if (!preg_match('/^[A-Za-z0-9_-]{1,64}$/', $key) || !lt_member($chat, $uid)) qm_out(200, ['ok' => false]);
    $m = lt_get("privateChats/$chat/messages/$key");
    if (!is_array($m) || ($m['fromUid'] ?? '') !== $uid) qm_out(200, ['ok' => false]);          // only your own messages
    $up = ["privateChats/$chat/messages/$key" => null, "privateChats/$chat/media/$key" => null];
    $last = lt_get("privateChats/$chat/lastMessage");
    if (is_array($last) && ($last['id'] ?? '') === $key) {          // keep the chat list preview of the normal app right
        $prev = lt_get("privateChats/$chat/messages", 'orderBy=' . rawurlencode('"$key"') . '&endAt=' . rawurlencode('"' . $key . '"') . '&limitToLast=2');
        $pk = null; $pm = null;
        if (is_array($prev)) { ksort($prev); foreach ($prev as $k => $v) if ((string)$k !== $key && is_array($v)) { $pk = (string)$k; $pm = $v; } }
        $up["privateChats/$chat/lastMessage"] = $pm ? ['fromUid' => $pm['fromUid'] ?? '', 'text' => empty($pm['enc']) ? (string)($pm['text'] ?? '') : '', 'timestamp' => (int)($pm['timestamp'] ?? 0), 'id' => $pk]
            : ['fromUid' => '', 'text' => '(No messages yet)', 'timestamp' => (int)(microtime(true) * 1000)];
    }
    qm_out(200, ['ok' => lt_update($up)]);
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
