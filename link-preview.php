<?php
// Link previews: POST url, idToken → {title, description, image, site, embed?}. Only public web pages; good previews are cached in linkPreviews/{id} (see lp_store).
declare(strict_types=1);
require __DIR__ . '/lib.php';
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') qm_out(405, ['error' => 'Use POST']);
$config = require __DIR__ . '/config.php';
$caller = qm_caller($config, (string)($_POST['idToken'] ?? ''));
qm_rate('lp:' . $caller['uid'], 90, 600);
$url = trim((string)($_POST['url'] ?? ''));
if (!preg_match('#^https?://[^\s]{4,2000}$#i', $url)) qm_out(400, ['error' => 'Bad link']);

$private = ($_POST['private'] ?? '') === '1';      // links from encrypted chats are never stored on the server
$id = substr(hash('sha256', $url), 0, 32);          // same id the app computes, to look the preview up in the database first

/** Stores a good preview in the shared cache (linkPreviews/{id}); the app reads it from there for a week before asking again. */
function lp_store(string $id, string $url, array $out): void {
    global $private;
    if ($private || !$out) return;
    try {
        $config = require __DIR__ . '/config.php';
        $sa = require __DIR__ . '/secrets.php';
        $tok = qm_service_token($sa, 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email');
        if (!$tok) return;
        qm_http('PUT', rtrim($config['database_url'], '/') . '/linkPreviews/' . $id . '.json', ['Authorization: Bearer ' . $tok],
            json_encode(['u' => $url, 'd' => $out, 't' => (int)round(microtime(true) * 1000)], JSON_UNESCAPED_UNICODE));
    } catch (Throwable $e) { /* the cache is best effort */ }
}

// YouTube: the page itself is huge and mostly script; its oEmbed answer is tiny and has the video's name and channel.
$h0 = strtolower((string)parse_url($url, PHP_URL_HOST));
$h0 = preg_replace('/^(www\.|m\.)/', '', $h0);
if (in_array($h0, ['youtube.com', 'music.youtube.com', 'youtu.be'], true)) {
    $o = qm_safe_fetch('https://www.youtube.com/oembed?format=json&url=' . rawurlencode($url), 60000, 2);
    $j = $o ? json_decode($o['body'], true) : null;
    if (is_array($j) && !empty($j['title'])) {
        $out = array_filter([
            'title' => mb_substr((string)$j['title'], 0, 160), 'creator' => mb_substr((string)($j['author_name'] ?? ''), 0, 80),
            'image' => (string)($j['thumbnail_url'] ?? ''), 'site' => 'YouTube',
        ], fn($v) => $v !== '');
        lp_store($id, $url, $out);
        qm_out(200, $out);
    }
    qm_out(200, []);       // unknown / removed video: no preview (and nothing cached)
}

$res = qm_safe_fetch($url, 700000, 4, true);
if (!$res || !str_contains($res['type'], 'html')) qm_out(200, []);
$html = $res['body'];
// charset → UTF-8
$cs = 'UTF-8';
if (preg_match('/charset=([\w-]+)/i', $res['type'], $m) || preg_match('/<meta[^>]+charset=["\']?([\w-]+)/i', substr($html, 0, 4096), $m)) $cs = $m[1];
if (strcasecmp($cs, 'utf-8') !== 0 && @mb_list_encodings() && in_array(strtolower($cs), array_map('strtolower', mb_list_encodings()), true)) $html = mb_convert_encoding($html, 'UTF-8', $cs);
$doc = new DOMDocument();
libxml_use_internal_errors(true);
@$doc->loadHTML('<?xml encoding="utf-8" ?>' . $html, LIBXML_NONET | LIBXML_NOWARNING | LIBXML_NOERROR);
libxml_clear_errors();

// ---- collect <meta> (first value wins; repeated properties such as article:tag are kept as lists) and <link> tags
$meta = []; $multi = [];
foreach ($doc->getElementsByTagName('meta') as $mt) {
    $k = strtolower($mt->getAttribute('property') ?: $mt->getAttribute('name') ?: $mt->getAttribute('itemprop'));
    $v = trim($mt->getAttribute('content'));
    if ($k === '' || $v === '') continue;
    if (!isset($meta[$k])) $meta[$k] = $v;
    $multi[$k][] = $v;
}
$links = [];
foreach ($doc->getElementsByTagName('link') as $lk) {
    $rel = strtolower(trim($lk->getAttribute('rel'))); $hrefv = trim($lk->getAttribute('href'));
    if ($rel !== '' && $hrefv !== '') foreach (preg_split('/\s+/', $rel) as $r) $links[$r][] = ['href' => $hrefv, 'sizes' => $lk->getAttribute('sizes'), 'type' => $lk->getAttribute('type')];
}
$M = fn(string ...$keys): string => (function () use ($keys, $meta) { foreach ($keys as $k) if (isset($meta[$k]) && $meta[$k] !== '') return $meta[$k]; return ''; })();
$L = function (string ...$keys) use ($multi): array { $o = []; foreach ($keys as $k) foreach ($multi[$k] ?? [] as $v) foreach (preg_split('/\s*,\s*/', $v) as $x) if ($x !== '') $o[$x] = true; return array_slice(array_keys($o), 0, 6); };
$dec = fn(string $t, int $n): string => mb_substr(trim(html_entity_decode($t, ENT_QUOTES | ENT_HTML5, 'UTF-8')), 0, $n);

$abs = function (string $u) use ($res): string {
    $u = trim($u);
    if ($u === '') return '';
    if (preg_match('#^https?://#i', $u)) return $u;
    $p = parse_url($res['url']);
    $base = $p['scheme'] . '://' . $p['host'] . (isset($p['port']) ? ':' . $p['port'] : '');
    if (str_starts_with($u, '//')) return $p['scheme'] . ':' . $u;
    return $u[0] === '/' ? $base . $u : $base . rtrim(dirname($p['path'] ?? '/'), '/') . '/' . $u;
};
$http = fn(string $u): string => preg_match('#^https?://#i', $u) ? $u : '';

// ---- JSON-LD (schema.org): products, articles, movies, places, events, people ...
$ld = [];
$flat = function ($n) use (&$flat, &$ld) {
    if (!is_array($n)) return;
    if (isset($n['@graph']) && is_array($n['@graph'])) { foreach ($n['@graph'] as $g) $flat($g); }
    if (isset($n['@type'])) $ld[] = $n;
    elseif (array_is_list($n)) foreach ($n as $g) $flat($g);
};
$count = 0;
foreach ($doc->getElementsByTagName('script') as $sc) {
    if (strtolower($sc->getAttribute('type')) !== 'application/ld+json' || ++$count > 6) continue;
    $j = json_decode(trim($sc->textContent), true);
    if ($j) $flat($j);
}
$types = fn(array $n): array => array_map('strval', (array)($n['@type'] ?? []));
$ldFind = function (array $want) use ($ld, $types): ?array { foreach ($ld as $n) if (array_intersect($want, $types($n))) return $n; return null; };
$str = function ($v): string { if (is_array($v)) { $v = $v['name'] ?? ($v[0]['name'] ?? ($v[0] ?? '')); } return is_scalar($v) ? trim((string)$v) : ''; };
$names = function ($v): array { $o = []; if (is_array($v) && !array_is_list($v)) $v = [$v]; foreach ((array)$v as $x) { $s = is_array($x) ? ($x['name'] ?? '') : $x; if (is_scalar($s) && trim((string)$s) !== '') $o[] = trim((string)$s); } return array_slice($o, 0, 6); };
$imgOf = function ($v) use ($str): string { if (is_array($v) && isset($v['url'])) return (string)$v['url']; if (is_array($v) && isset($v[0])) return is_array($v[0]) ? (string)($v[0]['url'] ?? '') : (string)$v[0]; return is_string($v) ? $v : ''; };

$product = $ldFind(['Product', 'Offer', 'IndividualProduct', 'SoftwareApplication', 'Course']);
$article = $ldFind(['Article', 'NewsArticle', 'BlogPosting', 'TechArticle', 'ScholarlyArticle', 'Report', 'Review']);
$movie = $ldFind(['Movie', 'TVSeries', 'TVEpisode', 'VideoGame']);
$music = $ldFind(['MusicRecording', 'MusicAlbum', 'MusicPlaylist', 'PodcastEpisode', 'PodcastSeries']);
$bookLd = $ldFind(['Book']);
$person = $ldFind(['Person', 'ProfilePage']);
$place = $ldFind(['Place', 'LocalBusiness', 'Restaurant', 'Hotel', 'Store', 'TouristAttraction', 'Organization', 'Event']);
$videoLd = $ldFind(['VideoObject']);
$audioLd = $ldFind(['AudioObject']);
$recipe = $ldFind(['Recipe']);

// ---- basics
$title = $M('og:title', 'twitter:title');
if ($title === '') { $t = $doc->getElementsByTagName('title')->item(0); if ($t) $title = trim($t->textContent); }
if ($title === '') foreach ([$product, $article, $movie, $music, $bookLd, $recipe, $videoLd] as $n) if ($n && ($x = $str($n['name'] ?? ($n['headline'] ?? '')))) { $title = $x; break; }
$desc = $M('og:description', 'twitter:description', 'description');
if ($desc === '') foreach ([$product, $article, $movie, $music, $bookLd, $recipe, $videoLd] as $n) if ($n && ($x = $str($n['description'] ?? ''))) { $desc = $x; break; }
$image = $M('og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src');
if ($image === '') foreach ([$product, $article, $movie, $music, $bookLd, $recipe] as $n) if ($n && ($x = $imgOf($n['image'] ?? ''))) { $image = $x; break; }
$image = $http($abs($image));
$site = $M('og:site_name', 'application-name') ?: (parse_url($res['url'], PHP_URL_HOST) ?: '');
$host = strtolower(parse_url($res['url'], PHP_URL_HOST) ?: '');
$icon = '';
foreach (['apple-touch-icon', 'icon', 'shortcut'] as $r) if (!empty($links[$r])) { $icon = $http($abs($links[$r][0]['href'])); if ($icon) break; }
$canon = !empty($links['canonical']) ? $http($abs($links['canonical'][0]['href'])) : '';

// ---- embeddable players: only from sites known to allow it
$embed = '';
$cand = $abs($M('og:video:secure_url', 'og:video:url', 'twitter:player'));
$allowed = '#^https://(www\.youtube(-nocookie)?\.com/embed/|player\.vimeo\.com/video/|open\.spotify\.com/embed/|w\.soundcloud\.com/player/|streamable\.com/e/|www\.dailymotion\.com/embed/|www\.loom\.com/embed/|embed\.music\.apple\.com/|clips\.twitch\.tv/embed|player\.twitch\.tv/)#i';
if ($cand !== '' && preg_match($allowed, $cand)) $embed = $cand;
if ($embed === '') {
    $path = parse_url($res['url'], PHP_URL_PATH) ?: '';
    if (str_ends_with($host, 'open.spotify.com') && preg_match('#^/(track|album|playlist|episode|show|artist)/(\w+)#', $path, $m)) $embed = "https://open.spotify.com/embed/{$m[1]}/{$m[2]}";
    elseif ($host === 'streamable.com' && preg_match('#^/(\w+)$#', $path, $m)) $embed = "https://streamable.com/e/{$m[1]}";
    elseif (str_ends_with($host, 'loom.com') && preg_match('#^/share/(\w+)#', $path, $m)) $embed = "https://www.loom.com/embed/{$m[1]}";
    elseif ($host === 'music.apple.com') $embed = 'https://embed.music.apple.com' . $path;
}

// ---- video / audio files the page points at (played with our own player)
$video = null;
$vu = $http($abs($M('og:video:secure_url', 'og:video:url', 'og:video', 'twitter:player:stream')));
$vt = strtolower($M('og:video:type', 'twitter:player:stream:content_type'));
if ($vu === '' && $videoLd) { $vu = $http($abs($str($videoLd['contentUrl'] ?? ''))); }
if ($vu !== '' && !$embed && (preg_match('#\.(mp4|webm|m4v|mov|ogv)(\?|$)#i', $vu) || str_starts_with($vt, 'video/'))) {
    $video = array_filter(['url' => $vu, 'type' => $vt, 'w' => (int)$M('og:video:width'), 'h' => (int)$M('og:video:height'), 'duration' => (int)($M('video:duration', 'og:video:duration') ?: 0)], fn($v) => $v !== '' && $v !== 0);
}
$audio = null;
$au = $http($abs($M('og:audio:secure_url', 'og:audio:url', 'og:audio')));
if ($au === '' && $audioLd) $au = $http($abs($str($audioLd['contentUrl'] ?? '')));
if ($au === '' && $music) $au = $http($abs($str($music['audio']['contentUrl'] ?? '')));
if ($au !== '' && !$embed) $audio = array_filter(['url' => $au, 'type' => strtolower($M('og:audio:type'))], fn($v) => $v !== '');

// ---- price
$price = null;
$amt = $M('product:price:amount', 'og:price:amount', 'product:sale_price:amount', 'price');
$cur = $M('product:price:currency', 'og:price:currency', 'product:sale_price:currency', 'pricecurrency');
$avail = $M('product:availability', 'og:availability', 'availability');
$orig = $M('product:original_price:amount');
if ($amt === '' && $product) {
    $o = $product['offers'] ?? $product;
    if (isset($o[0])) $o = $o[0];
    if (is_array($o)) {
        $amt = (string)($o['price'] ?? ($o['lowPrice'] ?? ($o['priceSpecification']['price'] ?? '')));
        $cur = $cur ?: (string)($o['priceCurrency'] ?? ($o['priceSpecification']['priceCurrency'] ?? ''));
        $avail = $avail ?: (string)($o['availability'] ?? '');
    }
}
if ($amt !== '' && preg_match('/^[\d.,]+$/', $amt)) {
    $price = array_filter(['amount' => $amt, 'currency' => strtoupper(substr($cur, 0, 3)), 'availability' => preg_replace('#^https?://schema.org/#i', '', mb_substr($avail, 0, 40)), 'was' => $orig], fn($v) => $v !== '');
}
$rating = null;
$rv = $product['aggregateRating']['ratingValue'] ?? ($movie['aggregateRating']['ratingValue'] ?? ($bookLd['aggregateRating']['ratingValue'] ?? null));
$ag = $product['aggregateRating'] ?? ($movie['aggregateRating'] ?? ($bookLd['aggregateRating'] ?? []));
$rc = $ag['ratingCount'] ?? ($ag['reviewCount'] ?? null);
if (is_numeric($rv)) $rating = array_filter(['value' => (float)$rv, 'count' => is_numeric($rc) ? (int)$rc : 0, 'best' => (float)($ag['bestRating'] ?? 5)], fn($v) => $v !== 0 && $v !== 0.0);

// ---- Android app link
$android = null;
$apkg = $M('al:android:package', 'twitter:app:id:googleplay');
if ($apkg !== '' && preg_match('/^[A-Za-z][\w]*(\.[\w]+)+$/', $apkg)) {
    $android = array_filter(['package' => $apkg, 'app' => $dec($M('al:android:app_name', 'twitter:app:name:googleplay'), 40), 'url' => mb_substr($M('al:android:url', 'twitter:app:url:googleplay'), 0, 300)], fn($v) => $v !== '');
}

// ---- location
$loc = null;
$lat = $M('place:location:latitude', 'og:latitude', 'latitude'); $lng = $M('place:location:longitude', 'og:longitude', 'longitude');
$addr = trim(implode(', ', array_filter([$M('og:street-address'), $M('og:locality'), $M('og:region'), $M('og:postal-code'), $M('og:country-name')])));
if ($place) {
    if ($lat === '' && isset($place['geo']['latitude'])) { $lat = (string)$place['geo']['latitude']; $lng = (string)($place['geo']['longitude'] ?? ''); }
    if ($addr === '') { $a = $place['address'] ?? ''; $addr = is_array($a) ? implode(', ', array_filter([$a['streetAddress'] ?? '', $a['addressLocality'] ?? '', $a['addressRegion'] ?? '', $a['addressCountry'] ?? ''], 'is_string')) : (is_string($a) ? $a : ''); }
}
if (is_numeric($lat) && is_numeric($lng) && abs((float)$lat) <= 90 && abs((float)$lng) <= 180) $loc = array_filter(['lat' => round((float)$lat, 6), 'lng' => round((float)$lng, 6), 'address' => $dec($addr, 160), 'name' => $place ? $dec($str($place['name'] ?? ''), 80) : ''], fn($v) => $v !== '');
elseif ($addr !== '') $loc = ['address' => $dec($addr, 160)];
if ($place && $loc !== null) {
    foreach (['telephone' => 'phone', 'priceRange' => 'priceRange'] as $k => $o) if (!empty($place[$k]) && is_string($place[$k])) $loc[$o] = mb_substr($place[$k], 0, 40);
    if (!empty($place['openingHours'])) $loc['hours'] = mb_substr(implode('; ', (array)$place['openingHours']), 0, 120);
    if (!empty($place['startDate'])) $loc['starts'] = (string)$place['startDate'];
}

// ---- entertainment (movies, shows, songs, albums, artists, podcasts)
$ogType = strtolower($M('og:type'));
$ent = null;
if (preg_match('#^(video\.|music\.)#', $ogType) || $movie || $music) {
    $n = $movie ?: $music ?: [];
    $ent = array_filter([
        'kind' => $ogType ?: strtolower($types($n)[0] ?? ''),
        'artists' => $L('music:musician') ?: $names($n['byArtist'] ?? ($n['author'] ?? [])),
        'album' => $dec($str($n['inAlbum'] ?? ''), 80),
        'actors' => $L('video:actor') ?: $names($n['actor'] ?? []),
        'directors' => $L('video:director') ?: $names($n['director'] ?? []),
        'released' => $M('video:release_date', 'music:release_date') ?: (string)($n['datePublished'] ?? ($n['dateCreated'] ?? '')),
        'duration' => (int)($M('video:duration', 'music:duration') ?: 0) ?: $str($n['duration'] ?? ''),
        'genres' => $L('video:tag', 'music:genre') ?: $names($n['genre'] ?? []),
        'creator' => $dec($M('og:video:series', 'video:series'), 80),
    ], fn($v) => $v !== '' && $v !== [] && $v !== 0);
}

// ---- article
$art = null;
if ($ogType === 'article' || $article || isset($meta['article:published_time'])) {
    $n = $article ?: [];
    $words = (int)($n['wordCount'] ?? 0);
    $art = array_filter([
        'published' => $M('article:published_time', 'og:article:published_time', 'datepublished') ?: (string)($n['datePublished'] ?? ''),
        'modified' => $M('article:modified_time', 'og:updated_time', 'og:article:modified_time', 'datemodified') ?: (string)($n['dateModified'] ?? ''),
        'authors' => array_map(fn($a) => $dec($a, 60), array_values(array_filter($L('article:author', 'author', 'og:article:author') ?: $names($n['author'] ?? []), fn($a) => !preg_match('#^https?://#', $a)))),
        'section' => $dec($M('article:section') ?: $str($n['articleSection'] ?? ''), 60),
        'tags' => array_map(fn($a) => $dec($a, 30), $L('article:tag', 'keywords') ?: $names($n['keywords'] ?? [])),
        'minutes' => $words ? max(1, (int)round($words / 220)) : (is_numeric($M('twitter:data1')) ? 0 : (preg_match('/(\d+)\s*min/i', $M('twitter:data1'), $m) ? (int)$m[1] : 0)),
    ], fn($v) => $v !== '' && $v !== [] && $v !== 0);
}

// ---- profile
$prof = null;
if ($ogType === 'profile' || $person) {
    $pn = $person ?: [];
    $prof = array_filter([
        'name' => $dec(trim($M('profile:first_name') . ' ' . $M('profile:last_name')) ?: $str($pn['name'] ?? ''), 80),
        'username' => $dec($M('profile:username') ?: $str($pn['alternateName'] ?? ''), 60),
        'job' => $dec($str($pn['jobTitle'] ?? ''), 80),
        'works' => $dec($str($pn['worksFor'] ?? ''), 80),
        'followers' => is_numeric($M('profile:followers')) ? (int)$M('profile:followers') : 0,
    ], fn($v) => $v !== '' && $v !== 0);
}

// ---- book
$book = null;
if ($ogType === 'book' || $bookLd) {
    $bn = $bookLd ?: [];
    $book = array_filter([
        'authors' => $L('book:author') ?: $names($bn['author'] ?? []),
        'isbn' => $dec($M('book:isbn') ?: $str($bn['isbn'] ?? ''), 20),
        'released' => $M('book:release_date') ?: (string)($bn['datePublished'] ?? ''),
        'pages' => (int)($bn['numberOfPages'] ?? 0),
        'tags' => $L('book:tag') ?: $names($bn['genre'] ?? []),
    ], fn($v) => $v !== '' && $v !== [] && $v !== 0);
}
$recipeOut = null;
if ($recipe) $recipeOut = array_filter(['time' => $str($recipe['totalTime'] ?? ''), 'yield' => $str($recipe['recipeYield'] ?? ''), 'calories' => $str($recipe['nutrition']['calories'] ?? '')], fn($v) => $v !== '');

// ---- "label: value" pairs some sites publish (twitter:label1/data1 ...)
$facts = [];
for ($i = 1; $i <= 4; $i++) { $l = $M("twitter:label$i"); $d = $M("twitter:data$i"); if ($l !== '' && $d !== '') $facts[] = [$dec($l, 30), $dec($d, 60)]; }

$out = array_filter([
    'title' => $dec($title, 160), 'description' => $dec($desc, 300),
    'image' => $image, 'imageAlt' => $dec($M('og:image:alt', 'twitter:image:alt'), 200),
    'imageW' => (int)$M('og:image:width'), 'imageH' => (int)$M('og:image:height'),
    'site' => mb_substr($site, 0, 60), 'icon' => $icon, 'canonical' => $canon, 'color' => preg_match('/^#[0-9a-f]{3,8}$/i', $M('theme-color')) ? $M('theme-color') : '',
    'type' => mb_substr($ogType, 0, 30), 'embed' => $embed,
    'video' => $video, 'audio' => $audio, 'price' => $price, 'rating' => $rating, 'android' => $android, 'location' => $loc,
    'entertainment' => $ent, 'article' => $art, 'profile' => $prof, 'book' => $book, 'recipe' => $recipeOut, 'facts' => $facts,
], fn($v) => $v !== '' && $v !== null && $v !== [] && $v !== 0);
if (!($out['title'] ?? '') && !($out['description'] ?? '') && !($out['image'] ?? '') && !($out['video'] ?? '') && !($out['audio'] ?? '')) qm_out(200, []);   // nothing to show: don't keep it
lp_store($id, $url, $out);
qm_out(200, $out);
