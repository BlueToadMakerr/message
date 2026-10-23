<?php
// Marks an email account verified once it has a Google sign-in with the SAME verified email (Google already proved the address).
declare(strict_types=1);
require __DIR__ . '/lib.php';
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') qm_out(405, ['error' => 'Use POST']);
$config = require __DIR__ . '/config.php';
$sa = require __DIR__ . '/secrets.php';
$idToken = (string)($_POST['idToken'] ?? '');
$r = qm_http('POST', 'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' . urlencode($config['api_key']), ['Content-Type: application/json'], json_encode(['idToken' => $idToken]));
$u = $r['json']['users'][0] ?? null;
if ($r['code'] !== 200 || !is_array($u)) qm_out(401, ['error' => 'Invalid token']);
if (!empty($u['emailVerified'])) qm_out(200, ['status' => 'already']);
$email = strtolower((string)($u['email'] ?? ''));
$ok = false;
foreach (($u['providerUserInfo'] ?? []) as $p) if (($p['providerId'] ?? '') === 'google.com' && strtolower((string)($p['email'] ?? '')) === $email && $email !== '') $ok = true;
if (!$ok) qm_out(403, ['error' => 'No matching Google account']);
$tok = qm_service_token($sa, 'https://www.googleapis.com/auth/identitytoolkit https://www.googleapis.com/auth/userinfo.email');
if (!$tok) qm_out(500, ['error' => 'Server could not authenticate']);
$up = qm_http('POST', 'https://identitytoolkit.googleapis.com/v1/projects/' . $config['project_id'] . '/accounts:update',
    ['Authorization: Bearer ' . $tok, 'Content-Type: application/json'], json_encode(['localId' => (string)$u['localId'], 'emailVerified' => true]));
qm_out($up['code'] === 200 ? 200 : 502, ['status' => $up['code'] === 200 ? 'verified' : 'failed']);
