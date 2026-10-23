<?php
// Same-origin relay for Litterbox uploads. Gives the page a real upload progress bar (a direct cross-origin upload can't report one
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
$ch = curl_init('https://litterbox.catbox.moe/resources/internals/api.php');
curl_setopt_array($ch, [CURLOPT_POST => true, CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 600, CURLOPT_CONNECTTIMEOUT => 10,
  CURLOPT_POSTFIELDS => ['reqtype' => 'fileupload', 'time' => '72h', 'fileNameLength' => '16',
    'fileToUpload' => new CURLFile($f['tmp_name'], (string)($f['type'] ?: 'application/octet-stream'), $name)]]);
$out = trim((string)curl_exec($ch));
$code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);
if ($code < 200 || $code >= 300) fail(502, $out !== '' ? $out : 'Litterbox error');
echo $out;
