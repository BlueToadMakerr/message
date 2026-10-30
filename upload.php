<?php
// Same-origin relay for file-host uploads (Litterbox, oshi.at, tmpfile.link, file.io). Gives the page a real upload progress bar (a direct cross-origin upload can't report one
// without triggering a CORS preflight that Litterbox rejects). Also the fallback when the browser can't reach Litterbox directly.
declare(strict_types=1);
header('Content-Type: text/plain; charset=utf-8');
header('Cache-Control: no-store');
function fail(int $c, string $m): never { http_response_code($c); echo $m; exit; }
function iniBytes(string $v): int { $v = trim($v); $n = (float)$v; switch (strtolower(substr($v, -1))) { case 'g': $n *= 1024; case 'm': $n *= 1024; case 'k': $n *= 1024; } return (int)$n; }
// GET ?limits tells the page how big a file this server can relay, so it can pick the proxy (real progress bar) or go direct.
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'GET' && isset($_GET['limits'])) {
  header('Content-Type: application/json');
  $pm = iniBytes((string)ini_get('post_max_size')); $um = iniBytes((string)ini_get('upload_max_filesize'));
  echo json_encode(['max' => max(0, min($pm ?: PHP_INT_MAX, $um ?: PHP_INT_MAX) - 65536)]);
  exit;
}
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') fail(405, 'Use POST');
$config = require __DIR__ . '/config.php';
$idToken = (string)($_POST['idToken'] ?? '');
$lim = ini_get('post_max_size');
// A body bigger than post_max_size makes PHP drop $_POST and $_FILES entirely, which used to look like "Missing file or token".
if (empty($_POST) && empty($_FILES) && (int)($_SERVER['CONTENT_LENGTH'] ?? 0) > 0)
  fail(413, 'This server only accepts uploads up to ' . $lim . " through the upload helper (the file was " . round(((int)$_SERVER['CONTENT_LENGTH']) / 1048576, 1) . ' MB).');
if ($idToken === '') fail(400, 'Missing sign-in token. Reload the page and try again.');
if (empty($_FILES['fileToUpload'])) fail(400, 'No file was received.');
$errs = [UPLOAD_ERR_INI_SIZE => 'The file is bigger than the server allows (upload_max_filesize ' . ini_get('upload_max_filesize') . ').',
  UPLOAD_ERR_FORM_SIZE => 'The file is too big.', UPLOAD_ERR_PARTIAL => 'The upload was interrupted. Try again.',
  UPLOAD_ERR_NO_FILE => 'No file was received.', UPLOAD_ERR_NO_TMP_DIR => 'Server has no temp folder.', UPLOAD_ERR_CANT_WRITE => 'Server could not write the file.'];
$ec = $_FILES['fileToUpload']['error'];
if ($ec !== UPLOAD_ERR_OK) fail($ec === UPLOAD_ERR_INI_SIZE || $ec === UPLOAD_ERR_FORM_SIZE ? 413 : 400, $errs[$ec] ?? ('Upload error ' . $ec));

// Only signed-in users may use the proxy.
$ch = curl_init('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' . urlencode($config['api_key']));
curl_setopt_array($ch, [CURLOPT_POST => true, CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 10,
  CURLOPT_HTTPHEADER => ['Content-Type: application/json'], CURLOPT_POSTFIELDS => json_encode(['idToken' => $idToken])]);
$res = json_decode((string)curl_exec($ch), true);
$ok = curl_getinfo($ch, CURLINFO_HTTP_CODE) === 200 && !empty($res['users'][0]['localId']);
curl_close($ch);
if (!$ok) fail(401, 'Invalid or expired token');

$f = $_FILES['fileToUpload'];
$name = preg_match('/^[A-Za-z0-9]{16}(\.[A-Za-z0-9]{1,8})?$/', (string)$f['name']) ? $f['name'] : bin2hex(random_bytes(8));
$mime = (string)($f['type'] ?: 'application/octet-stream');

// The file hosts this relay may talk to (the page lists the same ones in js/hosts.js). `ttl` = retention the page asked for in seconds (0 = longest);
// the host gets the closest time it offers, never longer than it can. Delete-after-first-download is always switched off.
$D = 86400; $H = 3600;
$hosts = [
  'litterbox' => ['url' => 'https://litterbox.catbox.moe/resources/internals/api.php', 'times' => [1 * $H, 12 * $H, 24 * $H, 72 * $H]],
  'oshi'      => ['url' => 'https://oshi.at/', 'range' => [1 * $H, 90 * $D]],
  'tmpfile'   => ['url' => 'https://tmpfile.link/api/upload', 'times' => [7 * $D]],
  'fileio'    => ['url' => 'https://file.io/', 'times' => [1 * $D, 7 * $D, 14 * $D]],
  'catbox'    => ['url' => 'https://catbox.moe/user/api.php', 'times' => [3650 * $D]],          // never expires
  'zerox'     => ['url' => 'https://0x0.st', 'range' => [1 * $H, 365 * $D], 'bysize' => true],
  'tempfile'  => ['url' => 'https://tempfile.org/api/upload/local', 'range' => [1 * $H, 48 * $H]],
];
$hostId = (string)($_POST['host'] ?? 'litterbox');
if (!isset($hosts[$hostId])) fail(400, 'Unknown file host.');
$h = $hosts[$hostId];
$want = max(0, (int)($_POST['ttl'] ?? 0));
if (!empty($h['bysize'])) {     // 0x0.st: the smaller the file, the longer it is kept (30..365 days, 512 MiB = shortest)
  $max = (int)round(max(30 * $D, min(365 * $D, 30 * $D + (30 * $D - 365 * $D) * pow(((float)$f['size']) / (512 * 1048576) - 1, 3))));
  $ttl = ($want <= 0 || $want >= $max) ? $max : max(1 * $H, $want);
} elseif (isset($h['range'])) { $max = $h['range'][1]; $ttl = ($want <= 0 || $want >= $max) ? $max : max($h['range'][0], min($max, $want)); }
else {
  $max = max($h['times']); $ttl = $max;
  if ($want > 0 && $want < $max) { $ttl = $h['times'][0]; foreach ($h['times'] as $t) if (abs($t - $want) < abs($ttl - $want)) $ttl = $t; }
}
$cf = new CURLFile($f['tmp_name'], $mime, $name);
switch ($hostId) {
  case 'litterbox':
    $label = [3600 => '1h', 43200 => '12h', 86400 => '24h', 259200 => '72h'][$ttl];
    $post = ['reqtype' => 'fileupload', 'time' => $label, 'fileNameLength' => '16', 'fileToUpload' => $cf]; break;
  case 'oshi':
    $post = ['f' => $cf, 'expire' => (string)intdiv($ttl, 60), 'autodestroy' => '0', 'shorturl' => '0']; break;
  case 'tmpfile':
    $post = ['file' => $cf]; break;
  case 'catbox':
    $post = ['reqtype' => 'fileupload', 'fileToUpload' => $cf]; break;
  case 'zerox':
    $post = ['file' => $cf]; if ($ttl < $max) $post['expires'] = (string)max(1, (int)ceil($ttl / 3600)); break;
  case 'tempfile':
    $post = ['files' => $cf, 'expiryHours' => (string)max(1, min(48, intdiv($ttl, 3600)))]; break;
  case 'fileio':
    $post = ['file' => $cf, 'expires' => (string)intdiv($ttl, 86400) . 'd', 'autoDelete' => 'false', 'maxDownloads' => '1000']; break;
}
$ch = curl_init($h['url']);
curl_setopt_array($ch, [CURLOPT_POST => true, CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 600, CURLOPT_CONNECTTIMEOUT => 10, CURLOPT_FOLLOWLOCATION => false,
  CURLOPT_PROTOCOLS => CURLPROTO_HTTPS, CURLOPT_USERAGENT => 'QuickMessage-upload/1.0', CURLOPT_POSTFIELDS => $post]);
$out = trim((string)curl_exec($ch));
$code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);
if ($code < 200 || $code >= 300) fail($code === 429 ? 429 : 502, $out !== '' ? substr($out, 0, 300) : 'The file host answered with an error (' . $code . ').');

// Every host answers differently: pull out the download link.
$url = '';
$j = json_decode($out, true);
if (is_array($j)) {
  if (isset($j['files'][0]['url']) && is_string($j['files'][0]['url'])) $url = $j['files'][0]['url'];            // tempfile.org
  if ($url === '') foreach (['link', 'downloadLink', 'url', 'download_url'] as $k) if (!empty($j[$k]) && is_string($j[$k])) { $url = $j[$k]; break; }
  if ($url === '' && isset($j['data']) && is_array($j['data'])) foreach (['link', 'downloadLink', 'url'] as $k) if (!empty($j['data'][$k]) && is_string($j['data'][$k])) { $url = $j['data'][$k]; break; }
  if ($url === '' && isset($j['success']) && $j['success'] === false) fail(502, (string)($j['message'] ?? $j['error'] ?? 'The file host refused the file.'));
} elseif (preg_match('/^DL:\s*(https:\/\/\S+)/mi', $out, $m)) $url = $m[1];       // oshi.at
elseif (preg_match('#https://\S+#', $out, $m)) $url = $m[0];                    // Litterbox: the whole answer is the link
$url = rtrim($url, " \t\r\n\"'<>.,;");
$domains = ['litter.catbox.moe', 'files.catbox.moe', 'oshi.at', 'tmpfile.link', 'file.io', 'www.file.io', '0x0.st', 'tempfile.org'];
$host = strtolower((string)parse_url($url, PHP_URL_HOST));
if ($url === '' || strpos($url, 'https://') !== 0 || !in_array($host, $domains, true) || strlen($url) > 300) fail(502, 'The file host did not return a usable link: ' . substr($out, 0, 160));
if (($_POST['json'] ?? '') === '1') { header('Content-Type: application/json'); echo json_encode(['url' => $url, 'expiresIn' => $ttl, 'host' => $hostId]); }
else echo $url;
