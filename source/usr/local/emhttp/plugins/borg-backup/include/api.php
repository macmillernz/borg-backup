<?php
/**
 * Borg Backup for Unraid - JSON API used by the plugin pages.
 *
 * All calls are POST requests (Unraid validates csrf_token for every POST
 * through its local_prepend.php) with an `action` field and an optional
 * JSON `data` field. Responses: {"ok":true, ...} or {"ok":false,"error":"..."}.
 */
ini_set('display_errors', '0'); // a stray notice must never corrupt the JSON response
require __DIR__ . '/lib.php';
header('Content-Type: application/json');

/** Send a JSON response and stop. */
function out(array $d): void {
  echo json_encode(['ok' => true] + $d, JSON_UNESCAPED_SLASHES);
  exit;
}
function fail(string $msg, int $code = 400): void {
  http_response_code($code);
  echo json_encode(['ok' => false, 'error' => $msg], JSON_UNESCAPED_SLASHES);
  exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') fail('POST required', 405);
$action = $_POST['action'] ?? '';
$in = json_decode($_POST['data'] ?? '{}', true) ?: [];

/** Fetch and validate an id parameter. */
function req_id(array $in, string $k = 'id'): string {
  $id = $in[$k] ?? '';
  if (!bb_valid_id($id)) fail("Invalid $k");
  return $id;
}

/** Validate an absolute host path (no traversal tricks). */
function req_path($p): string {
  if (!is_string($p) || $p === '' || $p[0] !== '/' || strpos($p, "\0") !== false || preg_match('#(^|/)\.\.(/|$)#', $p)) fail('Invalid path: ' . $p);
  return rtrim($p, '/') ?: '/';
}

/** Validate a script spec coming from the wizard. */
function clean_script($s): array {
  $type = in_array($s['type'] ?? 'none', ['none', 'script', 'inline'], true) ? $s['type'] : 'none';
  $r = ['type' => $type, 'abort' => !empty($s['abort'] ?? true), 'timeout' => max(10, min(86400, (int)($s['timeout'] ?? 3600)))];
  if ($type === 'script') {
    if (!bb_valid_script_name($s['script'] ?? '')) fail('Invalid script name');
    $r['script'] = $s['script'];
  }
  if ($type === 'inline') $r['inline'] = (string)($s['inline'] ?? '');
  return $r;
}

/** Validate a schedule object. */
function clean_schedule($s): array {
  $preset = in_array($s['preset'] ?? 'manual', ['manual', 'hourly', 'daily', 'weekly', 'monthly', 'custom'], true) ? $s['preset'] : 'manual';
  $r = ['preset' => $preset];
  if (preg_match('/^\d{1,2}:\d{2}$/', $s['time'] ?? '')) $r['time'] = $s['time'];
  foreach (['minute', 'dow', 'dom'] as $k) if (isset($s[$k])) $r[$k] = (int)$s[$k];
  if ($preset === 'custom') {
    if (!bb_cron_valid($s['cron'] ?? '')) fail('Invalid cron expression (5 fields, digits and * , - / only)');
    $r['cron'] = trim($s['cron']);
  }
  return $r;
}

/** Archive name sanity check (used in borg ::archive arguments). */
function req_archive($a): string {
  if (!is_string($a) || $a === '' || strlen($a) > 200 || preg_match('/[\x00-\x1f\/]/', $a) || $a[0] === '-') fail('Invalid archive name');
  return $a;
}

/** Job list with computed status for the UI. */
function jobs_view(array $status, array $tasks): array {
  $running = array_column($tasks, null, 'key');
  return array_map(function ($j) use ($status, $running) {
    $cron = bb_schedule_cron($j['schedule'] ?? null);
    $j['schedule_text'] = bb_schedule_text($j['schedule'] ?? null);
    $j['next_run'] = !empty($j['enabled']) ? bb_cron_next($cron) : null;
    $j['last'] = $status['jobs'][$j['id']] ?? null;
    $j['running'] = $running['job-' . $j['id']] ?? null;
    return $j;
  }, bb_load('jobs'));
}

switch ($action) {

/* ---------------------------- overview --------------------------- */
case 'state':
  $status = bb_load('status');
  $tasks = bb_tasks();
  $repos = array_map(function ($r) use ($status) {
    $r = bb_public_repo($r);
    $r['info'] = $status['repos'][$r['id']] ?? null;
    return $r;
  }, bb_load('repos'));
  $running = array_column($tasks, null, 'key');
  $tests = array_map(function ($t) use ($status, $running) {
    $t['schedule_text'] = bb_schedule_text($t['schedule'] ?? null);
    $t['next_run'] = !empty($t['enabled']) ? bb_cron_next(bb_schedule_cron($t['schedule'] ?? null)) : null;
    $t['last'] = $status['tests'][$t['id']] ?? null;
    $t['running'] = $running['test-' . $t['id']] ?? null;
    return $t;
  }, bb_load('tests'));
  out(['jobs' => jobs_view($status, $tasks), 'repos' => $repos, 'tests' => $tests, 'tasks' => $tasks,
       'history' => array_slice(bb_load('history'), 0, (int)($in['history'] ?? 25)),
       'scripts' => bb_scripts(), 'borg' => bb_borg_bin(), 'now' => time()]);

case 'tasks':
  out(['tasks' => bb_tasks()]);

case 'history':
  $h = bb_load('history');
  if (!empty($in['kind'])) $h = array_values(array_filter($h, fn($e) => $e['kind'] === $in['kind'] && (empty($in['ref']) || $e['ref'] === $in['ref'])));
  out(['history' => array_slice($h, 0, 200)]);

case 'log':
  $file = $in['log'] ?? '';
  $root = realpath(bb_log_dir());
  $real = realpath($file);
  if (!$real || !$root || strpos($real, $root . '/') !== 0) fail('Log not found', 404);
  $size = filesize($real);
  $max = 256 * 1024;
  $fh = fopen($real, 'r');
  if ($size > $max) fseek($fh, -$max, SEEK_END);
  $text = stream_get_contents($fh);
  fclose($fh);
  $running = false;
  foreach (bb_tasks() as $t) if ($t['log'] === $file) $running = $t;
  out(['text' => $text, 'truncated' => $size > $max, 'running' => $running]);

case 'cancel':
  $key = $in['key'] ?? '';
  if (!preg_match('/^(job|test|restore)-[a-z0-9]{4,32}$/', $key)) fail('Invalid task');
  out(['cancelled' => bb_task_cancel($key)]);

/* ----------------------------- sources --------------------------- */
case 'containers':
  out(['containers' => bb_containers()]);

case 'container_mounts':
  $name = $in['name'] ?? '';
  if (!preg_match('/^[A-Za-z0-9][A-Za-z0-9_.-]*$/', $name)) fail('Invalid container');
  out(['mounts' => bb_container_mounts([$name])]);

case 'stacks':
  out(['stacks' => array_values(array_map(function ($s) {
    if (!$s['containers']) $s['containers'] = bb_project_containers($s['project']);
    return $s;
  }, bb_compose_stacks()))]);

case 'stack_mounts':
  $stacks = bb_compose_stacks();
  $p = $in['project'] ?? '';
  if (!isset($stacks[$p])) fail('Stack not found');
  out(bb_compose_mounts($stacks[$p]));

case 'browse':
  $path = req_path($in['path'] ?? '/mnt');
  if (!is_dir($path)) fail('Not a directory');
  $dirs = []; $files = 0;
  foreach (@scandir($path) ?: [] as $e) {
    if ($e === '.' || $e === '..') continue;
    if (is_dir("$path/$e")) $dirs[] = $e; else $files++;
  }
  natcasesort($dirs);
  out(['path' => $path, 'parent' => $path === '/' ? null : (dirname($path) ?: '/'), 'dirs' => array_values($dirs), 'files' => $files]);

/* ------------------------------ jobs ----------------------------- */
case 'job_save':
  $j = $in['job'] ?? [];
  $name = trim($j['name'] ?? '');
  if ($name === '' || strlen($name) > 80) fail('Job name is required');
  $type = $j['source']['type'] ?? '';
  if (!in_array($type, ['container', 'compose', 'custom'], true)) fail('Invalid source type');
  $paths = [];
  foreach ($j['source']['paths'] ?? [] as $p) {
    $paths[] = ['path' => req_path($p['path'] ?? ''), 'include' => !empty($p['include']),
                'target' => (string)($p['target'] ?? ''), 'type' => (string)($p['type'] ?? 'bind')];
  }
  if (!array_filter($paths, fn($p) => $p['include'])) fail('Select at least one path to back up');
  if (!bb_repo($j['repo_id'] ?? '')) fail('Select a repository');
  $stopContainers = array_values(array_filter((array)($j['stop']['containers'] ?? []), fn($n) => is_string($n) && preg_match('/^[A-Za-z0-9][A-Za-z0-9_.-]*$/', $n)));
  $ret = [];
  foreach (['hourly', 'daily', 'weekly', 'monthly', 'yearly'] as $k) $ret[$k] = max(0, min(1000, (int)($j['retention'][$k] ?? 0)));
  $comp = (string)($j['compression'] ?? '');
  if ($comp !== '' && !preg_match('/^(none|lz4|zstd(,\d{1,2})?|zlib(,\d)?|lzma(,\d)?|auto,[a-z0-9,]+)$/', $comp)) fail('Invalid compression');
  $job = [
    'id' => bb_valid_id($j['id'] ?? '') ? $j['id'] : bb_id(),
    'name' => $name,
    'enabled' => !empty($j['enabled'] ?? true),
    'source' => ['type' => $type, 'name' => (string)($j['source']['name'] ?? ''), 'paths' => $paths],
    'stop' => ['enabled' => !empty($j['stop']['enabled']), 'timeout' => max(5, min(600, (int)($j['stop']['timeout'] ?? 60))), 'containers' => $stopContainers],
    'repo_id' => $j['repo_id'],
    'schedule' => clean_schedule($j['schedule'] ?? []),
    'retention' => $ret,
    'compression' => $comp ?: null,
    'excludes' => array_values(array_filter(array_map('trim', (array)($j['excludes'] ?? [])), fn($e) => $e !== '' && $e[0] !== '-')),
    'pre' => clean_script($j['pre'] ?? []),
    'post' => clean_script($j['post'] ?? []),
  ];
  $jobs = bb_update('jobs', function ($jobs) use ($job) {
    foreach ($jobs as $i => $old) {
      if ($old['id'] === $job['id']) {
        $job['prefix'] = $old['prefix'] ?? bb_slug($old['name']);
        $job['created'] = $old['created'] ?? time();
        $jobs[$i] = $job;
        return $jobs;
      }
    }
    // unique archive prefix per repo so prune never touches another job's archives
    $prefix = bb_slug($job['name']); $base = $prefix; $n = 2;
    while (array_filter($jobs, fn($o) => ($o['prefix'] ?? '') === $prefix && $o['repo_id'] === $job['repo_id'])) $prefix = $base . '-' . $n++;
    $job['prefix'] = $prefix;
    $job['created'] = time();
    $jobs[] = $job;
    return $jobs;
  });
  foreach ($jobs as $saved) if ($saved['id'] === $job['id']) $job = $saved;
  bb_write_cron();
  if (!empty($in['run'])) bb_spawn(['job', $job['id']]);
  out(['job' => $job]);

case 'job_get':
  $j = bb_job(req_id($in));
  if (!$j) fail('Job not found', 404);
  out(['job' => $j]);

case 'job_delete':
  $id = req_id($in);
  bb_update('jobs', fn($jobs) => array_values(array_filter($jobs, fn($j) => $j['id'] !== $id)));
  bb_update('status', function ($s) use ($id) { unset($s['jobs'][$id]); return $s; });
  bb_write_cron();
  out([]);

case 'job_toggle':
  $id = req_id($in);
  bb_update('jobs', function ($jobs) use ($id, $in) {
    foreach ($jobs as &$j) if ($j['id'] === $id) $j['enabled'] = !empty($in['enabled']);
    return $jobs;
  });
  bb_write_cron();
  out([]);

case 'job_run':
  $id = req_id($in);
  if (!bb_job($id)) fail('Job not found', 404);
  if (bb_task_running("job-$id")) fail('Job is already running');
  bb_spawn(['job', $id]);
  out([]);

/* --------------------------- repositories ------------------------ */
case 'repo_save':
  $r = $in['repo'] ?? [];
  $name = trim($r['name'] ?? '');
  if ($name === '') fail('Repository name is required');
  $existing = bb_valid_id($r['id'] ?? '') ? bb_repo($r['id']) : null;
  if (!empty($r['id']) && !$existing) fail('Repository not found', 404);
  // the location of an existing repository is never changed
  $loc = $existing ? $existing['location'] : trim($r['location'] ?? '');
  $isRemote = preg_match('#^(ssh://|[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:)#', $loc) === 1;
  if (!$isRemote) $loc = req_path($loc);
  if (strpos($loc, "\n") !== false || $loc[0] === '-') fail('Invalid location');
  $enc = $r['encryption'] ?? 'repokey-blake2';
  if (!in_array($enc, ['repokey-blake2', 'repokey', 'keyfile-blake2', 'keyfile', 'none'], true)) fail('Invalid encryption');
  $repo = [
    'id' => $existing['id'] ?? bb_id(),
    'name' => $name,
    'location' => $loc,
    'encryption' => $existing['encryption'] ?? $enc,
    'passphrase' => ($r['passphrase'] ?? '') !== '' ? (string)$r['passphrase'] : ($existing['passphrase'] ?? ''),
    'remote_path' => preg_match('#^[A-Za-z0-9/._-]*$#', $r['remote_path'] ?? '') ? ($r['remote_path'] ?? '') : '',
    'ssh_key' => ($r['ssh_key'] ?? '') !== '' ? req_path($r['ssh_key']) : '',
    'created' => $existing['created'] ?? time(),
  ];
  if (!$existing) {
    if ($repo['encryption'] !== 'none' && strlen($repo['passphrase']) < 8 && ($r['mode'] ?? 'new') === 'new') fail('Passphrase must be at least 8 characters');
    if (($r['mode'] ?? 'new') === 'new') {
      $args = ['init', '--encryption', $repo['encryption'], '--make-parent-dirs'];
      [$rc, , $err] = bb_borg($repo, $args, ['timeout' => 180]);
      if ($rc !== 0) fail("borg init failed:\n" . bb_borg_error($err));
    } else {
      [$rc, , $err] = bb_borg($repo, ['info', '--json'], ['timeout' => 180]);
      if ($rc !== 0) fail("Could not open repository:\n" . bb_borg_error($err));
    }
  }
  bb_update('repos', function ($repos) use ($repo) {
    foreach ($repos as $i => $o) if ($o['id'] === $repo['id']) { $repos[$i] = $repo; return $repos; }
    $repos[] = $repo;
    return $repos;
  });
  $info = bb_repo_refresh($repo);
  out(['repo' => bb_public_repo($repo), 'info' => $info]);

case 'repo_delete':
  $id = req_id($in);
  $users = array_filter(bb_load('jobs'), fn($j) => $j['repo_id'] === $id);
  if ($users) fail('Repository is used by job(s): ' . implode(', ', array_column($users, 'name')));
  bb_update('repos', fn($repos) => array_values(array_filter($repos, fn($r) => $r['id'] !== $id)));
  bb_update('tests', fn($t) => array_values(array_filter($t, fn($x) => $x['repo_id'] !== $id)));
  bb_update('status', function ($s) use ($id) { unset($s['repos'][$id]); return $s; });
  bb_write_cron();
  out([]);

case 'repo_refresh':
  $repo = bb_repo(req_id($in)) ?: fail('Repository not found', 404);
  out(['info' => bb_repo_refresh($repo)]);

case 'repo_key':
  $repo = bb_repo(req_id($in)) ?: fail('Repository not found', 404);
  $args = ['key', 'export'];
  if (!empty($in['paper'])) $args[] = '--paper';
  [$rc, $out, $err] = bb_borg($repo, $args, ['timeout' => 60]);
  if ($rc !== 0) fail(bb_borg_error($err));
  out(['key' => $out]);

case 'archives':
  $repo = bb_repo(req_id($in)) ?: fail('Repository not found', 404);
  [$rc, $out, $err] = bb_borg($repo, ['list', '--json', '--bypass-lock'], ['timeout' => 180]);
  if ($rc !== 0) fail(bb_borg_error($err));
  $arch = array_reverse(json_decode($out, true)['archives'] ?? []);
  out(['archives' => array_map(fn($a) => ['name' => $a['name'], 'time' => strtotime($a['time'])], $arch)]);

case 'archive_browse':
  // The full listing is cached once per archive in /tmp; each request filters one directory level.
  $repo = bb_repo(req_id($in, 'repo')) ?: fail('Repository not found', 404);
  $archive = req_archive($in['archive'] ?? '');
  $dir = trim((string)($in['path'] ?? ''), '/');
  $cache = bb_dir(BB_TMP . '/lists') . '/' . $repo['id'] . '-' . md5($archive) . '.tsv';
  if (!is_file($cache) || filesize($cache) === 0) {
    $rc = bb_exec([bb_borg_bin(), 'list', '--bypass-lock', '--format', "{type}\t{size}\t{mtime}\t{path}{NL}", "::$archive"],
      bb_borg_env($repo), ['timeout' => 900, 'stdout_file' => "$cache.part"], $o, $err);
    if ($rc !== 0) { @unlink("$cache.part"); fail(bb_borg_error($err)); }
    rename("$cache.part", $cache);
    foreach (glob(BB_TMP . '/lists/*.tsv') ?: [] as $f) if (filemtime($f) < time() - 86400) @unlink($f);
  }
  $entries = []; $seenDirs = [];
  $prefix = $dir === '' ? '' : "$dir/";
  $fh = fopen($cache, 'r');
  while (($l = fgets($fh)) !== false) {
    $p = explode("\t", rtrim($l, "\n"), 4);
    if (count($p) < 4) continue;
    [$t, $size, $mtime, $path] = $p;
    if ($prefix !== '' && strpos($path, $prefix) !== 0) continue;
    $rest = substr($path, strlen($prefix));
    if ($rest === '' || $rest === false) continue;
    $slash = strpos($rest, '/');
    if ($slash !== false) {
      // implied directory (parents are not always listed, e.g. "mnt")
      $child = substr($rest, 0, $slash);
      if (!isset($seenDirs[$child])) { $seenDirs[$child] = count($entries); $entries[] = ['name' => $child, 'dir' => true, 'size' => 0, 'mtime' => '']; }
      continue;
    }
    if ($t === 'd') {
      if (isset($seenDirs[$rest])) { $entries[$seenDirs[$rest]]['mtime'] = $mtime; continue; }
      $seenDirs[$rest] = count($entries);
      $entries[] = ['name' => $rest, 'dir' => true, 'size' => 0, 'mtime' => $mtime];
    } else {
      $entries[] = ['name' => $rest, 'dir' => false, 'size' => (int)$size, 'mtime' => $mtime, 'type' => $t];
    }
    if (count($entries) > 5000) break;
  }
  fclose($fh);
  usort($entries, fn($a, $b) => [$b['dir'], strtolower($a['name'])] <=> [$a['dir'], strtolower($b['name'])]);
  out(['path' => $dir, 'entries' => $entries]);

case 'archive_delete':
  $repo = bb_repo(req_id($in, 'repo')) ?: fail('Repository not found', 404);
  $archive = req_archive($in['archive'] ?? '');
  [$rc, , $err] = bb_borg($repo, ['delete', '--lock-wait', '30', "::$archive"], ['timeout' => 600]);
  if ($rc !== 0) fail(bb_borg_error($err));
  bb_borg($repo, ['compact', '--lock-wait', '30'], ['timeout' => 1800]);
  bb_repo_refresh($repo);
  out([]);

case 'restore':
  $repo = bb_repo(req_id($in, 'repo')) ?: fail('Repository not found', 404);
  $archive = req_archive($in['archive'] ?? '');
  $paths = [];
  foreach ((array)($in['paths'] ?? []) as $p) {
    $p = trim((string)$p, '/');
    if ($p === '' || preg_match('#(^|/)\.\.(/|$)#', $p) || $p[0] === '-') fail("Invalid path $p");
    $paths[] = $p;
  }
  $mode = ($in['mode'] ?? 'dir') === 'original' ? 'original' : 'dir';
  $dest = $mode === 'dir' ? req_path($in['dest'] ?? '') : '/';
  if ($mode === 'dir' && in_array($dest, ['/', '/boot', '/mnt', '/mnt/user', '/usr', '/etc'], true)) fail('Choose a sub directory as restore destination');
  $stop = array_values(array_filter((array)($in['stop'] ?? []), fn($n) => is_string($n) && preg_match('/^[A-Za-z0-9][A-Za-z0-9_.-]*$/', $n)));
  $id = bb_id();
  bb_dir(BB_RUN . '/restores');
  file_put_contents(BB_RUN . "/restores/$id.json", json_encode(['repo_id' => $repo['id'], 'archive' => $archive,
    'paths' => $paths, 'mode' => $mode, 'dest' => $dest, 'stop' => $stop]));
  bb_spawn(['restore', $id]);
  out(['id' => $id]);

/* ------------------------------ tests ---------------------------- */
case 'test_save':
  $t = $in['test'] ?? [];
  if (trim($t['name'] ?? '') === '') fail('Name is required');
  if (!bb_repo($t['repo_id'] ?? '')) fail('Select a repository');
  $test = ['id' => bb_valid_id($t['id'] ?? '') ? $t['id'] : bb_id(), 'name' => trim($t['name']),
    'repo_id' => $t['repo_id'], 'type' => in_array($t['type'] ?? '', ['check', 'verify', 'extract'], true) ? $t['type'] : 'check',
    'job_id' => bb_valid_id($t['job_id'] ?? '') ? $t['job_id'] : null,
    'enabled' => !empty($t['enabled'] ?? true), 'schedule' => clean_schedule($t['schedule'] ?? [])];
  bb_update('tests', function ($tests) use ($test) {
    foreach ($tests as $i => $o) if ($o['id'] === $test['id']) { $tests[$i] = $test; return $tests; }
    $tests[] = $test;
    return $tests;
  });
  bb_write_cron();
  out(['test' => $test]);

case 'test_delete':
  $id = req_id($in);
  bb_update('tests', fn($t) => array_values(array_filter($t, fn($x) => $x['id'] !== $id)));
  bb_write_cron();
  out([]);

case 'test_run':
  $id = req_id($in);
  if (bb_task_running("test-$id")) fail('Test is already running');
  bb_spawn(['test', $id]);
  out([]);

/* ----------------------------- scripts --------------------------- */
case 'script_get':
  $n = $in['name'] ?? '';
  if (!bb_valid_script_name($n) || !is_file(bb_script_dir() . "/$n")) fail('Script not found', 404);
  out(['name' => $n, 'content' => file_get_contents(bb_script_dir() . "/$n")]);

case 'script_save':
  $n = $in['name'] ?? '';
  if (!bb_valid_script_name($n)) fail('Script names must end in .sh and use letters, numbers, dot, dash or underscore');
  if (!empty($in['old']) && $in['old'] !== $n && bb_valid_script_name($in['old'])) @unlink(bb_script_dir() . '/' . $in['old']);
  file_put_contents(bb_script_dir() . "/$n", str_replace("\r\n", "\n", (string)($in['content'] ?? '')));
  out(['scripts' => bb_scripts()]);

case 'script_delete':
  $n = $in['name'] ?? '';
  if (!bb_valid_script_name($n)) fail('Invalid script');
  $users = array_filter(bb_load('jobs'), fn($j) => ($j['pre']['script'] ?? '') === $n || ($j['post']['script'] ?? '') === $n);
  if ($users) fail('Script is used by job(s): ' . implode(', ', array_column($users, 'name')));
  @unlink(bb_script_dir() . "/$n");
  out(['scripts' => bb_scripts()]);

case 'script_test':
  $n = $in['name'] ?? '';
  if (!bb_valid_script_name($n) || !is_file(bb_script_dir() . "/$n")) fail('Script not found', 404);
  $rc = bb_exec(['/bin/bash', bb_script_dir() . "/$n"], ['BORG_JOB_ID' => 'test', 'BORG_JOB_NAME' => 'Script test', 'BORG_PHASE' => 'test', 'BORG_JOB_STATUS' => 'ok'],
    ['timeout' => 120], $o, $e);
  out(['rc' => $rc, 'output' => $o . ($e !== '' ? "\n[stderr]\n$e" : '')]);

/* ---------------------------- settings --------------------------- */
case 'settings':
  $s = bb_settings();
  $pub = is_file($s['ssh_key'] . '.pub') ? trim(file_get_contents($s['ssh_key'] . '.pub')) : null;
  out(['settings' => $s, 'borg_bin' => bb_borg_bin(), 'borg_version' => bb_borg_version(), 'ssh_public_key' => $pub,
       'cache_effective' => bb_cache_dir()]);

case 'settings_save':
  $n = $in['settings'] ?? [];
  $cur = bb_settings();
  $s = [];
  foreach (['cache_dir', 'log_dir', 'ssh_key', 'restore_dir'] as $k) $s[$k] = isset($n[$k]) && $n[$k] !== '' ? req_path($n[$k]) : $cur[$k];
  $s['borg_bin'] = ($n['borg_bin'] ?? '') !== '' ? req_path($n['borg_bin']) : '';
  $s['compression'] = preg_match('/^(none|lz4|zstd(,\d{1,2})?|zlib(,\d)?|lzma(,\d)?)$/', $n['compression'] ?? '') ? $n['compression'] : $cur['compression'];
  $s['lock_wait'] = max(1, min(86400, (int)($n['lock_wait'] ?? $cur['lock_wait'])));
  $s['log_keep'] = max(5, min(1000, (int)($n['log_keep'] ?? $cur['log_keep'])));
  $s['history_keep'] = max(50, min(10000, (int)($n['history_keep'] ?? $cur['history_keep'])));
  foreach (['notify_success', 'notify_warning', 'notify_failure'] as $k) $s[$k] = !empty($n[$k]);
  bb_save('settings', $s);
  out(['settings' => bb_settings()]);

case 'ssh_keygen':
  $key = bb_settings()['ssh_key'];
  if (is_file($key)) fail('Key already exists: ' . $key);
  bb_dir(dirname($key));
  $rc = bb_exec(['ssh-keygen', '-t', 'ed25519', '-N', '', '-C', 'borg-backup@' . gethostname(), '-f', $key], [], ['timeout' => 30], $o, $e);
  if ($rc !== 0) fail($e ?: 'ssh-keygen failed');
  out(['public_key' => trim(file_get_contents("$key.pub"))]);

default:
  fail('Unknown action');
}
