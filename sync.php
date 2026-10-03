<?php
ini_set('display_errors', 1);
ini_set('display_startup_errors', 1);
error_reporting(E_ALL);
header("Content-Type: application/json");

// ------------------------------
// ADMIN LOGIN (Firebase Auth)
// ------------------------------
function firebaseLogin($email, $password, $apiKey) {
    $url = "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=" . $apiKey;
    $data = [
        "email" => $email,
        "password" => $password,
        "returnSecureToken" => true
    ];
    $ch = curl_init($url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_HTTPHEADER, ["Content-Type: application/json"]);
    curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($data));
    $res = curl_exec($ch);
    curl_close($ch);
    $decoded = json_decode($res, true);
    return $decoded["idToken"] ?? null;
}

$adminEmail = "adminaccount@admin.com";
$adminPassword = "ib*giF6JC%8h#8R3*B8B%";
$apiKey = "AIzaSyBNynmpC9-jTZd56WnpsjnbJa7THeyTMWY";

$adminToken = firebaseLogin($adminEmail, $adminPassword, $apiKey);
if (!$adminToken) {
    http_response_code(500);
    echo json_encode(["error" => "Failed to log in as admin"]);
    exit;
}

// ------------------------------
// HELPER: Fetch from DB
// ------------------------------
function firebaseGet($url, $authToken) {
    $ch = curl_init($url . '?auth=' . $authToken);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    $res = curl_exec($ch);
    curl_close($ch);
    return json_decode($res, true);
}

function firebasePatch($url, $data, $authToken) {
    $ch = curl_init($url . '?auth=' . $authToken);
    curl_setopt($ch, CURLOPT_CUSTOMREQUEST, "PATCH");
    curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($data));
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_HTTPHEADER, ["Content-Type: application/json"]);
    $res = curl_exec($ch);
    curl_close($ch);
    return json_decode($res, true);
}

// ------------------------------
// MAIN SCRIPT
// ------------------------------
$databaseUrl = "https://quickmessage-ac953-default-rtdb.firebaseio.com";

// 1. Fetch privateChats
$privateChats = firebaseGet("$databaseUrl/privateChats.json", $adminToken);
if (!$privateChats) {
    http_response_code(500);
    echo json_encode(["error" => "Failed to fetch privateChats"]);
    exit;
}

// 2. Build new chatList from privateChats
$newChatList = [];
foreach ($privateChats as $chatId => $chatData) {
    if (!isset($chatData["participants"])) continue;
    foreach ($chatData["participants"] as $participantUid => $_) {
        if (!isset($newChatList[$participantUid])) $newChatList[$participantUid] = [];
        $newChatList[$participantUid][$chatId] = true;
    }
}

// 3. Update chatList in DB
$updateResult = firebasePatch("$databaseUrl/chatList.json", $newChatList, $adminToken);

// 4. Return results
echo json_encode([
    "status" => "success",
    "updatedChatList" => $newChatList,
    "firebaseResponse" => $updateResult
], JSON_PRETTY_PRINT);
