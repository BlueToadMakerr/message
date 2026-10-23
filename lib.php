<?php
// Shared helpers for link-preview.php, email-lookup.php and fetch-file.php.
declare(strict_types=1);

function qm_out(int $code, array $data): never {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function qm_http(string $method, string $url, array $headers = [], ?string $body = null): array {
    $ch = curl_init($url);
    curl_setopt_array($ch, [CURLOPT_CUSTOMREQUEST => $method, CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 15,
        CURLOPT_CONNECTTIMEOUT => 8, CURLOPT_HTTPHEADER => $headers]);
    if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
    $res = curl_exec($ch);
    $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return ['code' => $code, 'body' => $res === false ? null : $res, 'json' => is_string($res) ? json_decode($res, true) : null];
}

function qm_b64url(string $s): string { return rtrim(strtr(base64_encode($s), '+/', '-_'), '='); }

/** Verifies the caller's Firebase ID token. Returns ['uid' => …, 'verified' => bool, 'email' => …] or ends the request with 401. */
function qm_caller(array $config, string $idToken): array {
    if ($idToken === '') qm_out(401, ['error' => 'Missing sign-in token. Reload the page and try again.']);
    $r = qm_http('POST', 'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' . urlencode($config['api_key']),
        ['Content-Type: application/json'], json_encode(['idToken' => $idToken]));
    $u = $r['json']['users'][0] ?? null;
    if ($r['code'] !== 200 || !is_array($u) || empty($u['localId'])) qm_out(401, ['error' => 'Invalid or expired token']);
    return ['uid' => (string)$u['localId'], 'verified' => !empty($u['emailVerified']), 'email' => (string)($u['email'] ?? '')];
}

/** Very small per-key rate limit kept in the temp dir. */
function qm_rate(string $key, int $max, int $windowSec): void {
    $f = sys_get_temp_dir() . '/qm_rate_' . md5($key) . '.json';
    $now = time();
    $hits = [];
    if (is_readable($f)) { $d = json_decode((string)@file_get_contents($f), true); if (is_array($d)) $hits = array_filter($d, fn($t) => $t > $now - $windowSec); }
    if (count($hits) >= $max) qm_out(429, ['error' => 'Too many requests. Try again in a little while.']);
    $hits[] = $now;
    @file_put_contents($f, json_encode(array_values($hits)), LOCK_EX);
}

/** Service-account access token (cached) for the given scopes. */
function qm_service_token(array $sa, string $scope): ?string {
    $cache = sys_get_temp_dir() . '/qm_tok_' . md5($sa['client_email'] . $scope) . '.json';
    if (is_readable($cache)) { $c = json_decode((string)@file_get_contents($cache), true); if (isset($c['token'], $c['exp']) && $c['exp'] > time() + 120) return $c['token']; }
    $now = time();
    $claim = ['iss' => $sa['client_email'], 'scope' => $scope, 'aud' => $sa['token_uri'], 'iat' => $now, 'exp' => $now + 3600];
    $unsigned = qm_b64url(json_encode(['alg' => 'RS256', 'typ' => 'JWT'])) . '.' . qm_b64url(json_encode($claim));
    if (!openssl_sign($unsigned, $sig, $sa['private_key'], 'SHA256')) return null;
    $res = qm_http('POST', $sa['token_uri'], ['Content-Type: application/x-www-form-urlencoded'], http_build_query([
        'grant_type' => 'urn:ietf:params:oauth:grant-type:jwt-bearer', 'assertion' => $unsigned . '.' . qm_b64url($sig)]));
    $t = $res['json']['access_token'] ?? null;
    if (!$t) return null;
    @file_put_contents($cache, json_encode(['token' => $t, 'exp' => $now + (int)($res['json']['expires_in'] ?? 3000)]), LOCK_EX);
    @chmod($cache, 0600);
    return $t;
}

/** Is this IP a public address (not private / loopback / link-local / reserved)? */
function qm_public_ip(string $ip): bool {
    return filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) !== false;
}

/**
 * Fetches a public web page without letting it reach internal addresses: the host is resolved here, every address must be public,
 * the connection is pinned to the checked address, redirects are followed by hand (and re-checked), and the body is size-capped.
 * Returns ['url' => final url, 'type' => content-type, 'body' => string] or null.
 */
/** $head: only the first ~128 KB (a Range request, and we hang up as soon as </head> has arrived) so a huge page never fills memory. */
function qm_safe_fetch(string $url, int $maxBytes = 700000, int $redirects = 4, bool $head = false): ?array {
    if ($head) $maxBytes = min($maxBytes, 131072);
    for ($i = 0; $i <= $redirects; $i++) {
        $p = parse_url($url);
        if (!$p || empty($p['host']) || !in_array(strtolower($p['scheme'] ?? ''), ['http', 'https'], true)) return null;
        if (isset($p['user']) || isset($p['pass'])) return null;
        $https = strtolower($p['scheme']) === 'https';
        $port = $p['port'] ?? ($https ? 443 : 80);
        if (!in_array($port, [80, 443], true)) return null;
        $host = $p['host'];
        $ips = filter_var($host, FILTER_VALIDATE_IP) ? [$host] : (gethostbynamel($host) ?: []);
        if (!$ips) return null;
        foreach ($ips as $ip) if (!qm_public_ip($ip)) return null;
        $body = ''; $type = ''; $loc = null;
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => false, CURLOPT_FOLLOWLOCATION => false, CURLOPT_TIMEOUT => 7, CURLOPT_CONNECTTIMEOUT => 4,
            CURLOPT_RESOLVE => ["$host:$port:" . $ips[0]], CURLOPT_USERAGENT => 'Mozilla/5.0 (compatible; QuickMessageBot/1.0; +link preview)',
            CURLOPT_HTTPHEADER => array_merge(['Accept: text/html,application/xhtml+xml;q=0.9,application/json;q=0.8,*/*;q=0.5', 'Accept-Language: en'], $head ? ['Range: bytes=0-' . ($maxBytes - 1)] : []),
            CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
            CURLOPT_HEADERFUNCTION => function ($c, $h) use (&$type, &$loc) {
                if (stripos($h, 'content-type:') === 0) $type = strtolower(trim(substr($h, 13)));
                if (stripos($h, 'location:') === 0) $loc = trim(substr($h, 9));
                return strlen($h);
            },
            CURLOPT_WRITEFUNCTION => function ($c, $d) use (&$body, $maxBytes, $head) {
                $body .= $d;
                if (strlen($body) > $maxBytes) { $body = substr($body, 0, $maxBytes); return 0; }
                if ($head) {                                                          // the <head> has what a preview needs (plus a little after it for JSON-LD)
                    $hp = stripos($body, '</head>');
                    if ($hp !== false && strlen($body) > $hp + 24000) return 0;
                }
                return strlen($d);
            },
        ]);
        curl_exec($ch);
        $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        if ($code >= 300 && $code < 400 && $loc) {
            // resolve a relative redirect
            if (!preg_match('#^https?://#i', $loc)) {
                $base = ($https ? 'https' : 'http') . '://' . $host . (isset($p['port']) ? ':' . $p['port'] : '');
                $loc = $loc[0] === '/' ? $base . $loc : $base . rtrim(dirname($p['path'] ?? '/'), '/') . '/' . $loc;
            }
            $url = $loc;
            continue;
        }
        if ($code < 200 || $code >= 300) return null;
        return ['url' => $url, 'type' => $type, 'body' => $body];
    }
    return null;
}
