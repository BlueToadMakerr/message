<?php
// Add-by-email: POST email, idToken → {uid}. The email itself is never stored or sent anywhere; the account is looked up through the
// Firebase Admin API and only its UID is returned, and only when that person's email is verified and they allow being added by email
// (accsettings/{uid}/settings/emailAdd, default on).
declare(strict_types=1);
require __DIR__ . '/lib.php';
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') qm_out(405, ['error' => 'Use POST']);
$config = require __DIR__ . '/config.php';
$sa = require __DIR__ . '/secrets.php';
$caller = qm_caller($config, (string)($_POST['idToken'] ?? ''));
if (!$caller['verified']) qm_out(403, ['error' => 'Verify your own email first.']);
qm_rate('em:' . $caller['uid'], 20, 600);
$email = strtolower(trim((string)($_POST['email'] ?? '')));
if (!filter_var($email, FILTER_VALIDATE_EMAIL) || strlen($email) > 254) qm_out(400, ['error' => 'That doesn\'t look like a valid email address.']);
$notFound = ['error' => "No one can be added with that email. They may not have an account, or they don't allow being added by email."];

$tok = qm_service_token($sa, 'https://www.googleapis.com/auth/identitytoolkit https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email');
if (!$tok) qm_out(500, ['error' => 'Server could not authenticate.']);
$r = qm_http('POST', 'https://identitytoolkit.googleapis.com/v1/projects/' . $config['project_id'] . '/accounts:lookup',
    ['Authorization: Bearer ' . $tok, 'Content-Type: application/json'], json_encode(['email' => [$email]]));
$u = $r['json']['users'][0] ?? null;
if (!is_array($u) || empty($u['localId']) || empty($u['emailVerified'])) qm_out(404, $notFound);
$uid = (string)$u['localId'];
if ($uid === $caller['uid']) qm_out(400, ['error' => "That's your own email."]);
$flag = qm_http('GET', rtrim($config['database_url'], '/') . '/accsettings/' . rawurlencode($uid) . '/settings/emailAdd.json', ['Authorization: Bearer ' . $tok]);
if ($flag['json'] === false) qm_out(404, $notFound);
$has = qm_http('GET', rtrim($config['database_url'], '/') . '/accsettings/' . rawurlencode($uid) . '/settings/displayName.json?shallow=true', ['Authorization: Bearer ' . $tok]);
if (!is_string($has['json'] ?? null)) qm_out(404, $notFound);
qm_out(200, ['uid' => $uid]);
