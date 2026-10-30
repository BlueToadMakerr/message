<?php
// Same-origin relay for downloading (encrypted) uploads from the file hosts when the browser can't fetch them directly (no CORS).
declare(strict_types=1);
require __DIR__ . '/lib.php';
$config = require __DIR__ . '/config.php';
$caller = qm_caller($config, (string)($_GET['t'] ?? ''));
qm_rate('ff:' . $caller['uid'], 300, 600);
$u = (string)($_GET['u'] ?? '');
if (strlen($u) > 300 || !preg_match('#^https://(?:litter\.catbox\.moe|files\.catbox\.moe|oshi\.at|tmpfile\.link|(?:www\.)?file\.io|0x0\.st|tempfile\.org)/[\w.\-/%~+]+$#i', $u)) qm_out(400, ['error' => 'Only files from the supported file hosts']);
header('Content-Type: application/octet-stream');
header('Cache-Control: private, max-age=3600');
$ch = curl_init($u);
curl_setopt_array($ch, [CURLOPT_FOLLOWLOCATION => false, CURLOPT_TIMEOUT => 600, CURLOPT_CONNECTTIMEOUT => 10, CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
    CURLOPT_WRITEFUNCTION => function ($c, $d) { echo $d; return strlen($d); }]);
curl_exec($ch);
$code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);
if ($code < 200 || $code >= 300) { if (!headers_sent()) http_response_code(502); }
