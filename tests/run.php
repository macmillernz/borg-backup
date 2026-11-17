<?php
/**
 * Test suite for the plugin backend. Runs on any machine with PHP 8 + bash:
 *
 *   php tests/run.php
 *
 * Uses BB_TEST_ROOT to keep all state in a temp folder and a fake `borg`
 * that records its arguments, so no real repository, Docker or Unraid is needed.
 */
$root = rtrim(getenv('TMPDIR') ?: '/tmp', '/') . '/bb-test-' . getmypid();
putenv("BB_TEST_ROOT=$root");
mkdir($root, 0700, true);
register_shutdown_function(fn() => exec('rm -rf ' . escapeshellarg($root)));

$plugin = dirname(__DIR__) . '/source/usr/local/emhttp/plugins/borg-backup';
require "$plugin/include/lib.php";

$fails = 0; $count = 0;
function ok($cond, string $name, $detail = null): void {
  global $fails, $count;
  $count++;
  if ($cond) { echo "  ok   $name\n"; return; }
  $fails++;
  echo "  FAIL $name" . ($detail !== null ? ' -> ' . (is_string($detail) ? $detail : json_encode($detail)) : '') . "\n";
}

/** Call api.php in a child process exactly like a POST from the page. */
function api(string $action, array $data = []): array {
  global $plugin;
  $code = '$_SERVER["REQUEST_METHOD"]="POST"; $_POST=' . var_export(['action' => $action, 'data' => json_encode($data)], true) . '; include ' . var_export("$plugin/include/api.php", true) . ';';
  $out = shell_exec('php -r ' . escapeshellarg($code) . ' 2>&1');
  $j = json_decode((string)$out, true);
  return is_array($j) ? $j : ['ok' => false, 'error' => 'non-JSON output: ' . $out];
}

/** Run the CLI runner synchronously. */
function runner(string $kind, string $id): int {
  global $plugin;
  exec('php ' . escapeshellarg("$plugin/include/runner.php") . " $kind $id 2>&1", $o, $rc);
  if ($o) echo '       runner: ' . implode("\n       runner: ", $o) . "\n";
  return $rc;
}

// fake borg -----------------------------------------------------------------
$calls = "$root/borg-calls.log";
$fake = "$root/borg";
file_put_contents($fake, <<<SH
#!/bin/bash
echo "\$*" >> "$calls"
[ -n "\$BORG_PASSPHRASE" ] && echo "PASSPHRASE-SET" >> "$calls"
case "\$1" in
  --version) echo "borg 1.4.5";;
  init|prune|compact|check|delete) echo "\$1 done" >&2; [ -f "$root/fail-\$1" ] && exit 2; exit 0;;
  info) echo '{"cache":{"stats":{"total_size":1000,"total_csize":600,"unique_csize":400}},"encryption":{"mode":"repokey-blake2"}}';;
  key) echo "BORG_KEY abc";;
  extract) echo "extracting in \$(pwd)" >&2; [ -f "$root/fail-extract" ] && exit 2; exit 0;;
  create)
    echo "Creating archive" >&2
    [ -f "$root/fail-create" ] && { echo "Repository locked" >&2; exit 2; }
    echo '{"archive":{"duration":1.5,"stats":{"original_size":2048,"compressed_size":1024,"deduplicated_size":512,"nfiles":3}}}';;
  list)
    if [[ "\$*" == *--json* ]]; then echo '{"archives":[{"name":"docs-2026-11-14T03:00:00","time":"2026-11-14T03:00:00.000000"},{"name":"docs-2026-11-15T03:00:00","time":"2026-11-15T03:00:00.000000"}]}'
    elif [[ "\$*" == *--short* ]]; then echo "docs-2026-11-15T03:00:00"
    else printf 'd\t0\t2026-11-15\tmnt/user/docs\n-\t12\t2026-11-15\tmnt/user/docs/a.txt\nd\t0\t2026-11-15\tmnt/user/docs/sub\n-\t5\t2026-11-15\tmnt/user/docs/sub/b.txt\n'; fi;;
esac
SH);
chmod($fake, 0755);
$callLog = function () use ($calls) { return is_file($calls) ? file_get_contents($calls) : ''; };
$resetCalls = function () use ($calls) { @unlink($calls); };

// ---------------------------------------------------------------------------
echo "Schedules and cron\n";
ok(bb_cron_valid('0 3 * * *'), 'valid cron');
ok(!bb_cron_valid('0 3 * * * rm -rf /'), 'rejects 6 fields');
ok(!bb_cron_valid('0 3 * * ; reboot'), 'rejects shell characters');
ok(bb_schedule_cron(['preset' => 'daily', 'time' => '02:30']) === '30 2 * * *', 'daily cron', bb_schedule_cron(['preset' => 'daily', 'time' => '02:30']));
ok(bb_schedule_cron(['preset' => 'weekly', 'time' => '04:05', 'dow' => 6]) === '5 4 * * 6', 'weekly cron');
ok(bb_schedule_cron(['preset' => 'monthly', 'time' => '01:00', 'dom' => 31]) === '0 1 28 * *', 'monthly clamps day to 28');
ok(bb_schedule_cron(['preset' => 'hourly', 'minute' => 15]) === '15 * * * *', 'hourly cron');
ok(bb_schedule_cron(['preset' => 'manual']) === null, 'manual has no cron');
ok(bb_schedule_cron(['preset' => 'custom', 'cron' => 'bad']) === null, 'invalid custom cron ignored');
$base = mktime(10, 0, 0, 11, 15, 2026); // Sunday 15 Nov 2026 10:00
ok(bb_cron_next('30 2 * * *', $base) === mktime(2, 30, 0, 11, 16, 2026), 'next daily is tomorrow 02:30', date('c', (int)bb_cron_next('30 2 * * *', $base)));
ok(bb_cron_next('0 12 * * *', $base) === mktime(12, 0, 0, 11, 15, 2026), 'next daily later today');
ok(bb_cron_next('0 3 * * 1', $base) === mktime(3, 0, 0, 11, 16, 2026), 'next Monday');
ok(bb_cron_next('0 3 * * 7', $base) === mktime(3, 0, 0, 11, 22, 2026), 'dow 7 = Sunday');
ok(bb_cron_next('*/15 * * * *', $base) === mktime(10, 15, 0, 11, 15, 2026), 'step minutes');
ok(bb_cron_next('5/20 * * * *', $base) === mktime(10, 5, 0, 11, 15, 2026), 'start/step minutes');
ok(bb_cron_next('0 0 1 1 *', $base) === mktime(0, 0, 0, 1, 1, 2027), 'next new year');
ok(bb_cron_next('0 9 1-7 * 1', $base) === mktime(9, 0, 0, 11, 16, 2026), 'dom OR dow semantics');
ok(bb_schedule_text(['preset' => 'weekly', 'dow' => 3, 'time' => '01:00']) === 'Every Wednesday at 01:00', 'schedule text');

echo "Helpers\n";
ok(bb_slug('My Nextcloud!! Stack') === 'my-nextcloud-stack', 'slug');
ok(bb_default_include('/mnt/user/appdata/plex', 'bind'), 'appdata ticked');
ok(!bb_default_include('/mnt/user/media', 'bind'), 'media share unticked');
ok(!bb_default_include('/var/run/docker.sock', 'bind'), 'docker.sock unticked');
ok(bb_default_include('/var/lib/docker/volumes/x/_data', 'volume'), 'volume ticked');
ok(bb_valid_id('abc123def0') && !bb_valid_id('../x') && !bb_valid_id('ABC'), 'id validation');
ok(bb_valid_script_name('dump-db.sh') && !bb_valid_script_name('../x.sh') && !bb_valid_script_name('x.txt'), 'script name validation');
$rc = bb_exec(['/bin/sh', '-c', 'echo out; echo err >&2; exit 3'], [], [], $o, $e);
ok($rc === 3 && trim($o) === 'out' && trim($e) === 'err', 'bb_exec captures rc/stdout/stderr', [$rc, $o, $e]);
$rc = bb_exec(['/bin/sh', '-c', 'echo "$FOO"'], ['FOO' => 'bar'], [], $o);
ok(trim($o) === 'bar', 'bb_exec passes env');
$t = microtime(true);
$rc = bb_exec(['/bin/sleep', '5'], [], ['timeout' => 1]);
ok($rc === 124 && microtime(true) - $t < 4, 'bb_exec timeout', $rc);
ok(bb_exec(['/nonexistent/binary'], [], [], $o, $e) !== 0, 'missing binary returns non-zero');
$lines = [];
bb_exec(['/bin/sh', '-c', 'printf "a\nb\nc"'], [], ['on_line' => function ($l) use (&$lines) { $lines[] = $l; }]);
ok($lines === ['a', 'b', 'c'], 'bb_exec streams lines', $lines);

// ---------------------------------------------------------------------------
echo "API: settings\n";
mkdir("$root/src/docs/sub", 0700, true);
file_put_contents("$root/src/docs/a.txt", 'hello');
$r = api('settings_save', ['settings' => ['borg_bin' => $fake, 'cache_dir' => "$root/cache", 'log_dir' => "$root/logs",
  'restore_dir' => "$root/restore", 'compression' => 'zstd,6', 'notify_failure' => false, 'notify_warning' => false]]);
ok($r['ok'] && $r['settings']['borg_bin'] === $fake && $r['settings']['compression'] === 'zstd,6', 'save settings', $r);
$r = api('settings');
ok($r['ok'] && $r['borg_version'] === 'borg 1.4.5', 'settings shows borg version', $r['borg_version'] ?? $r);
ok(!api('settings_save', ['settings' => ['log_dir' => '../etc']])['ok'], 'rejects relative path');
ok(api('nope')['error'] === 'Unknown action', 'unknown action rejected');

echo "API: repositories\n";
$r = api('repo_save', ['repo' => ['name' => 'Local', 'location' => "$root/repo", 'encryption' => 'repokey-blake2', 'passphrase' => 'short', 'mode' => 'new']]);
ok(!$r['ok'] && strpos($r['error'], '8 characters') !== false, 'short passphrase rejected', $r);
$resetCalls();
$r = api('repo_save', ['repo' => ['name' => 'Local', 'location' => "$root/repo", 'encryption' => 'repokey-blake2', 'passphrase' => 'secret-pass', 'mode' => 'new']]);
ok($r['ok'] && !isset($r['repo']['passphrase']) && $r['repo']['has_passphrase'], 'create repo, passphrase not returned', $r);
$repoId = $r['repo']['id'] ?? '';
ok(strpos($callLog(), 'init --encryption repokey-blake2 --make-parent-dirs') !== false, 'borg init called', $callLog());
ok(strpos($callLog(), 'PASSPHRASE-SET') !== false && strpos($callLog(), 'secret-pass') === false, 'passphrase via env, not argv');
ok(($r['info']['deduplicated'] ?? null) === 400 && $r['info']['archives'] === 2, 'repo info cached', $r['info'] ?? null);
ok(!api('repo_save', ['repo' => ['name' => 'x', 'location' => '-rf', 'mode' => 'existing']])['ok'], 'option-like location rejected');
$r = api('repo_save', ['repo' => ['name' => 'Remote', 'location' => 'u1@u1.example.com:borg', 'mode' => 'existing', 'remote_path' => 'borg-1.4']]);
ok($r['ok'], 'existing ssh repo accepted', $r);
$remoteId = $r['repo']['id'] ?? '';
ok(api('repo_key', ['id' => $repoId])['key'] === "BORG_KEY abc\n", 'key export');
$r = api('repo_save', ['repo' => ['id' => $repoId, 'name' => 'Local renamed', 'passphrase' => '']]);
$repos = bb_load('repos');
ok($r['ok'] && $repos[0]['name'] === 'Local renamed' && $repos[0]['passphrase'] === 'secret-pass', 'edit keeps passphrase');

echo "API: jobs\n";
$job = ['name' => 'Docs', 'source' => ['type' => 'custom', 'paths' => [['path' => "$root/src/docs", 'include' => true], ['path' => "$root/src/missing", 'include' => true], ['path' => '/etc', 'include' => false]]],
  'stop' => ['enabled' => false], 'repo_id' => $repoId, 'schedule' => ['preset' => 'daily', 'time' => '03:00'],
  'retention' => ['daily' => 7, 'weekly' => 4], 'excludes' => ['*.tmp', '--dangerous'],
  'pre' => ['type' => 'inline', 'inline' => "echo pre-ran \$BORG_JOB_NAME \$BORG_PHASE"], 'post' => ['type' => 'inline', 'inline' => 'echo post-status $BORG_JOB_STATUS $BORG_ARCHIVE']];
ok(!api('job_save', ['job' => array_merge($job, ['repo_id' => 'zzzzzz'])])['ok'], 'job needs valid repo');
ok(!api('job_save', ['job' => array_merge($job, ['schedule' => ['preset' => 'custom', 'cron' => '* * * * * echo']])])['ok'], 'job rejects bad cron');
ok(!api('job_save', ['job' => array_merge($job, ['source' => ['type' => 'custom', 'paths' => [['path' => '/a/../etc', 'include' => true]]]])])['ok'], 'job rejects path traversal');
$r = api('job_save', ['job' => $job]);
ok($r['ok'] && $r['job']['prefix'] === 'docs', 'save job', $r);
$jobId = $r['job']['id'] ?? '';
ok($r['job']['excludes'] === ['*.tmp'], 'option-like exclude dropped', $r['job']['excludes'] ?? null);
$r2 = api('job_save', ['job' => array_merge($job, ['name' => 'Docs'])]);
ok($r2['job']['prefix'] === 'docs-2', 'second job gets unique archive prefix', $r2['job']['prefix'] ?? null);
api('job_delete', ['id' => $r2['job']['id']]);
$cron = file_get_contents(BB_CFG . '/borg-backup.cron');
ok(strpos($cron, "0 3 * * * ") !== false && strpos($cron, "runner.php job $jobId") !== false, 'cron file written', $cron);
api('job_toggle', ['id' => $jobId, 'enabled' => false]);
ok(strpos(file_get_contents(BB_CFG . '/borg-backup.cron'), $jobId) === false, 'disabled job removed from cron');
api('job_toggle', ['id' => $jobId, 'enabled' => true]);
$s = api('state');
ok($s['ok'] && count($s['jobs']) === 1 && $s['jobs'][0]['next_run'] > time() && $s['jobs'][0]['schedule_text'] === 'Daily at 03:00', 'state lists job with next run', $s['jobs'][0] ?? $s);
ok(!isset($s['repos'][0]['passphrase']), 'state hides passphrases');
ok(!api('repo_delete', ['id' => $repoId])['ok'], 'cannot delete repo used by a job');

echo "Runner: successful backup\n";
$resetCalls();
ok(runner('job', $jobId) === 0, 'runner exits 0');
$h = bb_load('history')[0] ?? [];
ok(($h['status'] ?? '') === 'warning', 'missing path gives warning status', $h);
ok(preg_match('/^docs-\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/', $h['archive'] ?? '') === 1, 'archive name', $h['archive'] ?? null);
ok(($h['stats']['files'] ?? 0) === 3, 'stats parsed from --json', $h['stats'] ?? null);
$c = $callLog();
ok(strpos($c, "create --json --show-rc --lock-wait 600 --compression zstd,6 --exclude-caches --exclude *.tmp ::docs-") !== false, 'create arguments', $c);
ok(strpos($c, "$root/src/docs") !== false && strpos($c, "$root/src/missing") === false && strpos($c, ' /etc') === false, 'only existing, ticked paths backed up');
ok(strpos($c, 'prune --list --show-rc --lock-wait 600 --glob-archives docs-* --keep-daily 7 --keep-weekly 4') !== false, 'prune limited to job prefix');
ok(strpos($c, 'compact') !== false, 'compact after prune');
$log = file_get_contents($h['log']);
ok(strpos($log, 'pre-ran Docs pre') !== false, 'pre script ran with env', $log);
ok(preg_match('/post-status warning docs-\d{4}/', $log) === 1, 'post script got status + archive');
ok(strpos($log, 'source path missing') !== false, 'missing path logged');
ok(bb_load('status')['jobs'][$jobId]['status'] === 'warning', 'job last status stored');
ok(count(glob(BB_RUN . '/tasks/*.json')) === 0, 'task file cleaned up');

echo "Runner: failures\n";
touch("$root/fail-create"); $resetCalls();
runner('job', $jobId);
$h = bb_load('history')[0];
ok($h['status'] === 'failed' && $h['archive'] === null, 'failed create -> failed', $h);
ok(strpos($callLog(), 'prune') === false, 'no prune after failed create');
ok(strpos(file_get_contents($h['log']), 'post-status failed') !== false, 'post script still runs with failed status');
unlink("$root/fail-create");

$failPre = array_merge($job, ['id' => $jobId, 'pre' => ['type' => 'inline', 'inline' => 'exit 5', 'abort' => true]]);
api('job_save', ['job' => $failPre]); $resetCalls();
runner('job', $jobId);
$h = bb_load('history')[0];
ok($h['status'] === 'failed' && strpos($h['message'], 'Pre-backup script failed (rc 5)') !== false, 'failing pre script aborts', $h);
ok(strpos($callLog(), 'create') === false, 'no borg create after aborted pre script');
api('job_save', ['job' => array_merge($failPre, ['pre' => ['type' => 'inline', 'inline' => 'exit 5', 'abort' => false]])]);
runner('job', $jobId);
ok(bb_load('history')[0]['status'] === 'warning', 'non-aborting pre script failure -> warning');

echo "Runner: nested paths\n";
api('job_save', ['job' => array_merge($job, ['id' => $jobId, 'pre' => ['type' => 'none'], 'post' => ['type' => 'none'],
  'source' => ['type' => 'custom', 'paths' => [['path' => "$root/src/docs/sub", 'include' => true], ['path' => "$root/src/docs", 'include' => true]]]])]);
$resetCalls();
runner('job', $jobId);
$create = array_values(array_filter(explode("\n", $callLog()), fn($l) => strpos($l, 'create ') === 0))[0] ?? '';
ok(substr_count($create, "$root/src/docs") === 1 && strpos($create, "$root/src/docs/sub") === false, 'nested path skipped, parent kept', $create);
ok(strpos(file_get_contents(bb_load('history')[0]['log']), "Skipping $root/src/docs/sub (already included via $root/src/docs)") !== false, 'skip is logged');
api('job_save', ['job' => array_merge($job, ['id' => $jobId])]);

echo "Runner: lock\n";
bb_dir(BB_RUN . '/tasks');
$lock = fopen(BB_RUN . "/tasks/job-$jobId.lock", 'c'); flock($lock, LOCK_EX);
$before = count(bb_load('history'));
ok(runner('job', $jobId) === 3 && count(bb_load('history')) === $before, 'second run refused while locked');
flock($lock, LOCK_UN); fclose($lock);

echo "API + runner: scripts\n";
ok(!api('script_save', ['name' => '../evil.sh', 'content' => 'x'])['ok'], 'bad script name rejected');
$r = api('script_save', ['name' => 'hello.sh', 'content' => "#!/bin/bash\r\n# Says hello\r\necho hello \$BORG_PHASE\r\n"]);
ok($r['ok'] && $r['scripts'][0]['description'] === 'Says hello', 'script saved with description', $r);
ok(strpos(api('script_get', ['name' => 'hello.sh'])['content'], "\r") === false, 'CRLF normalised');
$r = api('script_test', ['name' => 'hello.sh']);
ok($r['rc'] === 0 && trim($r['output']) === 'hello test', 'script test run', $r);
api('job_save', ['job' => array_merge($job, ['id' => $jobId, 'pre' => ['type' => 'script', 'script' => 'hello.sh']])]);
ok(!api('script_delete', ['name' => 'hello.sh'])['ok'], 'used script cannot be deleted');
runner('job', $jobId);
ok(strpos(file_get_contents(bb_load('history')[0]['log']), 'hello pre') !== false, 'library pre script ran');
ok(!api('job_save', ['job' => array_merge($job, ['pre' => ['type' => 'script', 'script' => 'nope;rm.sh']])])['ok'], 'invalid library script name rejected');

echo "Tests\n";
$r = api('test_save', ['test' => ['name' => 'Weekly', 'repo_id' => $repoId, 'type' => 'extract', 'job_id' => $jobId, 'schedule' => ['preset' => 'weekly', 'dow' => 0, 'time' => '05:00']]]);
ok($r['ok'], 'save test', $r);
$testId = $r['test']['id'];
ok(strpos(file_get_contents(BB_CFG . '/borg-backup.cron'), "0 5 * * 0") !== false, 'test scheduled in cron');
$resetCalls();
runner('test', $testId);
$h = bb_load('history')[0];
ok($h['kind'] === 'test' && $h['status'] === 'ok' && $h['archive'] === 'docs-2026-11-15T03:00:00', 'extract test passes', $h);
ok(strpos($callLog(), 'list --short --last 1 --glob-archives docs-*') !== false && strpos($callLog(), 'extract --dry-run') !== false, 'extract test commands', $callLog());
touch("$root/fail-check");
api('test_save', ['test' => ['id' => $testId, 'name' => 'Weekly', 'repo_id' => $repoId, 'type' => 'check']]);
runner('test', $testId);
ok(bb_load('history')[0]['status'] === 'failed', 'failing check -> failed');
unlink("$root/fail-check");

echo "Restore\n";
$r = api('archives', ['id' => $repoId]);
ok($r['archives'][0]['name'] === 'docs-2026-11-15T03:00:00', 'archives newest first', $r);
$r = api('archive_browse', ['repo' => $repoId, 'archive' => 'docs-2026-11-15T03:00:00', 'path' => '']);
ok($r['entries'] === [['name' => 'mnt', 'dir' => true, 'size' => 0, 'mtime' => '']], 'browse root shows implied dir', $r);
$r = api('archive_browse', ['repo' => $repoId, 'archive' => 'docs-2026-11-15T03:00:00', 'path' => 'mnt/user/docs']);
ok(array_column($r['entries'], 'name') === ['sub', 'a.txt'], 'browse lists one level, dirs first', $r);
ok(!api('archive_browse', ['repo' => $repoId, 'archive' => '--help', 'path' => ''])['ok'], 'option-like archive rejected');
ok(!api('restore', ['repo' => $repoId, 'archive' => 'docs-2026-11-15T03:00:00', 'mode' => 'dir', 'dest' => '/mnt/user'])['ok'], 'restore to share root refused');
ok(!api('restore', ['repo' => $repoId, 'archive' => 'docs-2026-11-15T03:00:00', 'paths' => ['../etc'], 'mode' => 'dir', 'dest' => "$root/out"])['ok'], 'restore path traversal refused');
$r = api('restore', ['repo' => $repoId, 'archive' => 'docs-2026-11-15T03:00:00', 'paths' => ['/mnt/user/docs/a.txt'], 'mode' => 'dir', 'dest' => "$root/out"]);
ok($r['ok'] && is_file(BB_RUN . "/restores/{$r['id']}.json"), 'restore queued', $r);
$resetCalls();
runner('restore', $r['id']);
$h = bb_load('history')[0];
ok($h['kind'] === 'restore' && $h['status'] === 'ok', 'restore ran', $h);
ok(strpos($callLog(), 'extract --list --show-rc --lock-wait 600 ::docs-2026-11-15T03:00:00 mnt/user/docs/a.txt') !== false, 'extract arguments', $callLog());
ok(strpos(file_get_contents($h['log']), "extracting in $root/out") !== false || strpos(file_get_contents($h['log']), 'extracting in /private' . "$root/out") !== false, 'extract ran inside destination');
ok(!is_file(BB_RUN . "/restores/{$r['id']}.json"), 'restore spec removed');

echo "Logs and cancel\n";
ok(api('log', ['log' => $h['log']])['ok'], 'log readable');
ok(!api('log', ['log' => '/etc/passwd'])['ok'], 'log outside log dir refused');
ok(!api('log', ['log' => "$root/logs/../cfg/repos.json"])['ok'], 'log traversal refused');
ok(!api('cancel', ['key' => 'job-x; rm'])['ok'], 'bad cancel key refused');
$r = api('history', ['kind' => 'job', 'ref' => $jobId]);
ok($r['ok'] && count($r['history']) >= 5 && !array_filter($r['history'], fn($e) => $e['kind'] !== 'job'), 'job history filtered');

echo "Docker unavailable (no docker binary here)\n";
$r = api('containers');
ok($r['ok'] && $r['containers'] === [], 'containers: empty list, valid JSON', $r);
$r = api('stacks');
ok($r['ok'] && is_array($r['stacks']), 'stacks: valid JSON', $r);
ok(!api('container_mounts', ['name' => '-x'])['ok'], 'option-like container name refused');
ok(api('container_mounts', ['name' => 'plex'])['mounts'] === [], 'mounts of unknown container: empty');
ok(!api('stack_mounts', ['project' => 'nope'])['ok'], 'unknown stack refused');
$r = api('browse', ['path' => "$root/src"]);
ok($r['ok'] && $r['dirs'] === ['docs'], 'folder browser', $r);

echo "Repository path resolver\n";
@mkdir("$root/pi/emptydir", 0777, true); @mkdir("$root/pi/Backups"); @mkdir("$root/pi/bar"); @mkdir("$root/pi/.hidden");
@mkdir("$root/pi/repo"); file_put_contents("$root/pi/repo/config", "[repository]\nversion = 1\n");
file_put_contents("$root/pi/bar/x.txt", 'x'); file_put_contents("$root/pi/afile", 'x');
$r = api('path_info', ['path' => "$root/pi/b"]);
ok($r['ok'] && $r['suggestions'] === ["$root/pi/Backups", "$root/pi/bar"] && $r['state'] === 'missing' && $r['ancestor'] === "$root/pi", 'prefix suggestions (case-insensitive), missing path', $r);
$r = api('path_info', ['path' => "$root/pi/"]);
ok(count($r['suggestions']) === 4 && !in_array("$root/pi/.hidden", $r['suggestions']), 'trailing slash lists children, hides dot folders', $r);
ok(api('path_info', ['path' => "$root/pi/repo"])['state'] === 'borg', 'borg repo detected');
ok(api('path_info', ['path' => "$root/pi/emptydir"])['state'] === 'empty', 'empty folder detected');
ok(api('path_info', ['path' => "$root/pi/bar"])['state'] === 'notempty', 'non-empty folder detected');
ok(api('path_info', ['path' => "$root/pi/afile"])['state'] === 'file', 'file detected');
$r = api('path_info', ['path' => "$root/pi/new/deeper/repo"]);
ok($r['ancestor'] === "$root/pi" && isset($r['free']), 'nearest existing parent and free space', $r);
ok(api('path_info', ['path' => 'relative/x'])['valid'] === false, 'relative path invalid');
ok(api('path_info', ['path' => '/mnt/user/../etc'])['valid'] === false, 'traversal invalid');
ok(api('path_info', ['path' => '/mnt/user/newshare/borg'])['where'] === ['type' => 'share', 'name' => 'newshare', 'new' => true], 'new share flagged');
ok(api('path_info', ['path' => '/root/borg'])['where']['type'] === 'ram', 'path outside /mnt flagged as RAM');
ok(api('path_info', ['path' => '/mnt/cache/borg'])['where']['type'] === 'pool', 'pool path classified');

echo "Cleanup\n";
api('job_delete', ['id' => $jobId]);
ok(api('repo_delete', ['id' => $repoId])['ok'], 'repo delete after job removed');
ok(bb_load('tests') === [], 'tests of deleted repo removed');
ok(count(bb_load('repos')) === 1 && bb_load('repos')[0]['id'] === $remoteId, 'other repo kept');

echo "\n" . ($count - $fails) . "/$count passed\n";
exit($fails ? 1 : 0);
