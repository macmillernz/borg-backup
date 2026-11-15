<?php
/**
 * Borg Backup for Unraid - background runner (CLI only).
 *
 * Usage:
 *   php runner.php job <job-id>        run a backup job
 *   php runner.php test <test-id>      run a repository test
 *   php runner.php restore <restore-id> run a queued restore (spec written by api.php)
 *
 * Started by cron (schedules) or detached by the web UI. Each run holds a
 * lock so the same job never runs twice, writes a log file, records the
 * result in status.json/history.json and sends Unraid notifications.
 */
if (PHP_SAPI !== 'cli') { http_response_code(403); exit; }
require __DIR__ . '/lib.php';
set_time_limit(0);
umask(0077);

/** One running task: lock, log file, task file and cancellation. */
class BBRun {
  public string $key;
  public string $logFile;
  public array $task;
  private $lock;
  private $log;

  public function __construct(string $kind, string $id, string $label, string $logGroup) {
    $this->key = "$kind-$id";
    bb_dir(BB_RUN . '/tasks');
    $this->lock = fopen(BB_RUN . "/tasks/{$this->key}.lock", 'c');
    if (!flock($this->lock, LOCK_EX | LOCK_NB)) {
      fwrite(STDERR, "{$this->key} is already running\n");
      exit(3);
    }
    @unlink($this->cancelFile());
    $dir = bb_dir(bb_log_dir() . "/$logGroup");
    $this->logFile = "$dir/" . date('Ymd-His') . "-$id.log";
    $this->log = fopen($this->logFile, 'a');
    $this->task = ['key' => $this->key, 'kind' => $kind, 'ref' => $id, 'label' => $label,
                   'pid' => getmypid(), 'started' => time(), 'log' => $this->logFile, 'step' => 'Starting', 'child' => null];
    $this->save();
    // keep only the newest N logs per group
    $logs = glob("$dir/*.log") ?: [];
    rsort($logs);
    foreach (array_slice($logs, max(5, (int)bb_settings()['log_keep'])) as $old) @unlink($old);
  }

  private function cancelFile(): string { return BB_RUN . "/tasks/{$this->key}.cancel"; }

  private function save(): void {
    file_put_contents(BB_RUN . "/tasks/{$this->key}.json", json_encode($this->task, JSON_UNESCAPED_SLASHES));
  }

  public function line(string $s): void {
    fwrite($this->log, date('Y-m-d H:i:s') . "  $s\n");
  }

  public function step(string $s): void {
    $this->task['step'] = $s;
    $this->save();
    $this->line("==== $s");
  }

  public function cancelled(): bool { return file_exists($this->cancelFile()); }

  /** Run a command, streaming its output into the log. Returns [rc, stdout]. */
  public function exec(array $cmd, array $env = [], array $opt = [], bool $captureStdout = false): array {
    $opt['on_start'] = function ($pid) { $this->task['child'] = $pid; $this->save(); };
    $opt['on_line'] = function ($l, $stream) use ($captureStdout) {
      if ($stream === 1 && $captureStdout) return;
      if (trim($l) !== '') $this->line($l);
    };
    $rc = bb_exec($cmd, $env, $opt, $out, $err);
    $this->task['child'] = null;
    $this->save();
    return [$rc, $out];
  }

  public function finish(): void {
    @unlink(BB_RUN . "/tasks/{$this->key}.json");
    @unlink($this->cancelFile());
    fclose($this->log);
    flock($this->lock, LOCK_UN);
  }
}

/** Raise a status: ok < warning < failed < cancelled. */
function bb_worse(string $a, string $b): string {
  $rank = ['ok' => 0, 'warning' => 1, 'failed' => 2, 'cancelled' => 3];
  return ($rank[$b] ?? 0) > ($rank[$a] ?? 0) ? $b : $a;
}

/** Map a borg exit code to a status. */
function bb_rc_status(int $rc): string {
  return $rc === 0 ? 'ok' : ($rc === 1 ? 'warning' : 'failed');
}

/**
 * Run a pre/post script definition: ['type' => none|script|inline, 'script' => name, 'inline' => text].
 * @return int|null exit code, or null when no script is configured
 */
function bb_run_script(BBRun $run, ?array $spec, array $env, string $label): ?int {
  $type = $spec['type'] ?? 'none';
  if ($type === 'script') {
    $name = $spec['script'] ?? '';
    $file = bb_script_dir() . '/' . $name;
    if (!bb_valid_script_name($name) || !is_file($file)) {
      $run->line("$label: library script '$name' not found");
      return 127;
    }
  } elseif ($type === 'inline' && trim($spec['inline'] ?? '') !== '') {
    $file = bb_dir(BB_TMP . '/scripts') . "/{$run->key}-" . bb_slug($label) . '.sh';
    file_put_contents($file, str_replace("\r\n", "\n", $spec['inline']));
    chmod($file, 0700);
  } else {
    return null;
  }
  $run->step($label);
  [$rc] = $run->exec(['/bin/bash', $file], $env, ['timeout' => (int)($spec['timeout'] ?? 3600)]);
  $run->line("$label exited with code $rc");
  if ($type === 'inline') @unlink($file);
  return $rc;
}

/** Stop running containers; returns names that were actually stopped. */
function bb_stop_containers(BBRun $run, array $names, int $timeout): array {
  if (!$names) return [];
  $running = [];
  foreach (bb_containers() as $c) if (in_array($c['name'], $names, true) && $c['state'] === 'running') $running[] = $c['name'];
  if (!$running) { $run->line('Containers already stopped: ' . implode(', ', $names)); return []; }
  $run->step('Stopping containers: ' . implode(', ', $running));
  // stop dependants first (reverse of start order)
  $stopped = [];
  foreach (array_reverse(bb_start_order($running)) as $n) {
    [$rc] = $run->exec(['docker', 'stop', '-t', (string)$timeout, $n], [], ['timeout' => $timeout + 60]);
    if ($rc === 0) $stopped[] = $n; else $run->line("WARNING: failed to stop $n (rc $rc)");
  }
  return array_reverse($stopped);
}

/** Start containers we stopped earlier, dependencies first. */
function bb_start_containers(BBRun $run, array $names): bool {
  if (!$names) return true;
  $run->step('Starting containers: ' . implode(', ', $names));
  $ok = true;
  foreach (bb_start_order($names) as $n) {
    [$rc] = $run->exec(['docker', 'start', $n], [], ['timeout' => 300]);
    if ($rc !== 0) { $run->line("ERROR: failed to start $n (rc $rc)"); $ok = false; }
  }
  return $ok;
}

/** Store last result + history and notify. */
function bb_record(BBRun $run, string $kind, string $id, string $name, string $status, string $message, array $extra = []): void {
  $entry = array_merge(['run' => bb_id(), 'kind' => $kind, 'ref' => $id, 'name' => $name, 'status' => $status,
    'message' => $message, 'started' => $run->task['started'], 'ended' => time(), 'log' => $run->logFile], $extra);
  $run->line("Result: " . strtoupper($status) . ($message ? " - $message" : ''));
  bb_history_add($entry);
  $bucket = $kind === 'job' ? 'jobs' : ($kind === 'test' ? 'tests' : null);
  if ($bucket) bb_update('status', function ($s) use ($bucket, $id, $entry) { $s[$bucket][$id] = $entry; return $s; });
  $s = bb_settings();
  $label = ['job' => 'Backup', 'test' => 'Test', 'restore' => 'Restore'][$kind] ?? ucfirst($kind);
  if ($status === 'ok' && $s['notify_success']) bb_notify("$label OK: $name", $message ?: 'Completed successfully', 'normal');
  if ($status === 'warning' && $s['notify_warning']) bb_notify("$label warning: $name", $message ?: 'Completed with warnings', 'warning');
  if (in_array($status, ['failed', 'cancelled'], true) && $s['notify_failure']) bb_notify("$label $status: $name", $message ?: 'See log', 'alert');
}

/* ------------------------------------------------------------------ */

function bb_run_job(string $id): void {
  $job = bb_job($id);
  if (!$job) { fwrite(STDERR, "Unknown job $id\n"); exit(2); }
  $repo = bb_repo($job['repo_id'] ?? '');
  $run = new BBRun('job', $id, $job['name'], "job-$id");
  $s = bb_settings();
  $status = 'ok'; $message = ''; $archive = null; $stats = null; $stopped = [];
  $prefix = $job['prefix'] ?? bb_slug($job['name']);
  $env = ['BORG_JOB_ID' => $id, 'BORG_JOB_NAME' => $job['name'], 'BORG_JOB_SOURCE' => $job['source']['type'] . ':' . ($job['source']['name'] ?? ''),
          'BORG_REPO_NAME' => $repo['name'] ?? '', 'BORG_REPO_LOCATION' => $repo['location'] ?? ''];
  try {
    $run->line("Job '{$job['name']}' started (" . bb_borg_version() . ')');
    if (!$repo) throw new RuntimeException('Repository not found');

    $paths = [];
    foreach ($job['source']['paths'] ?? [] as $p) {
      if (empty($p['include'])) continue;
      if (!file_exists($p['path'])) { $run->line("WARNING: source path missing, skipped: {$p['path']}"); $status = 'warning'; continue; }
      $paths[] = $p['path'];
    }
    if (!$paths) throw new RuntimeException('No existing source paths selected');

    $rc = bb_run_script($run, $job['pre'] ?? null, $env + ['BORG_PHASE' => 'pre'], 'Pre-backup script');
    if ($rc !== null && $rc !== 0) {
      if (($job['pre']['abort'] ?? true)) throw new RuntimeException("Pre-backup script failed (rc $rc)");
      $status = bb_worse($status, 'warning');
    }
    if ($run->cancelled()) throw new RuntimeException('cancelled');

    $stopped = bb_stop_containers($run, bb_job_stop_targets($job), (int)($job['stop']['timeout'] ?? 60));
    if ($run->cancelled()) throw new RuntimeException('cancelled');

    $archive = $prefix . '-' . date('Y-m-d\TH:i:s');
    $run->step("Creating archive $archive");
    $args = ['create', '--json', '--show-rc', '--lock-wait', (string)$s['lock_wait'],
             '--compression', $job['compression'] ?? $s['compression'], '--exclude-caches'];
    foreach ($job['excludes'] ?? [] as $ex) if (trim($ex) !== '') array_push($args, '--exclude', trim($ex));
    $args[] = '::' . $archive;
    [$rc, $out] = $run->exec(array_merge([bb_borg_bin()], $args, $paths), bb_borg_env($repo), [], true);
    $j = json_decode((string)$out, true);
    if (isset($j['archive']['stats'])) {
      $st = $j['archive']['stats'];
      $stats = ['original' => $st['original_size'] ?? 0, 'compressed' => $st['compressed_size'] ?? 0,
                'deduplicated' => $st['deduplicated_size'] ?? 0, 'files' => $st['nfiles'] ?? 0,
                'duration' => $j['archive']['duration'] ?? null];
      $run->line(sprintf('Archive stats: %d files, original %s, deduplicated %s', $stats['files'],
        bb_hsize($stats['original']), bb_hsize($stats['deduplicated'])));
    }
    if ($run->cancelled()) throw new RuntimeException('cancelled');
    $status = bb_worse($status, bb_rc_status($rc));
    if ($rc >= 2) { $message = "borg create failed (rc $rc)"; $archive = null; }
  } catch (Throwable $e) {
    if ($e->getMessage() === 'cancelled') { $status = 'cancelled'; $message = 'Cancelled by user'; }
    else { $status = 'failed'; $message = $e->getMessage(); $run->line('ERROR: ' . $message); }
  } finally {
    if (!bb_start_containers($run, $stopped)) { $status = bb_worse($status, 'failed'); $message = trim("$message; container restart failed", '; '); }
  }

  // retention
  $ret = $job['retention'] ?? [];
  $keep = array_filter(['--keep-hourly' => $ret['hourly'] ?? 0, '--keep-daily' => $ret['daily'] ?? 0, '--keep-weekly' => $ret['weekly'] ?? 0,
                        '--keep-monthly' => $ret['monthly'] ?? 0, '--keep-yearly' => $ret['yearly'] ?? 0], fn($v) => (int)$v > 0);
  if ($archive && $keep && $repo && !$run->cancelled()) {
    $run->step('Pruning old archives');
    $args = ['prune', '--list', '--show-rc', '--lock-wait', (string)$s['lock_wait'], '--glob-archives', "$prefix-*"];
    foreach ($keep as $k => $v) array_push($args, $k, (string)(int)$v);
    [$rc] = $run->exec(array_merge([bb_borg_bin()], $args), bb_borg_env($repo));
    if ($rc !== 0) { $status = bb_worse($status, 'warning'); $message = trim("$message; prune rc $rc", '; '); }
    else {
      $run->step('Compacting repository');
      [$rc] = $run->exec([bb_borg_bin(), 'compact', '--lock-wait', (string)$s['lock_wait']], bb_borg_env($repo));
      if ($rc !== 0) $status = bb_worse($status, 'warning');
    }
  }

  $rc = bb_run_script($run, $job['post'] ?? null, $env + ['BORG_PHASE' => 'post', 'BORG_JOB_STATUS' => $status, 'BORG_ARCHIVE' => (string)$archive], 'Post-backup script');
  if ($rc !== null && $rc !== 0) { $status = bb_worse($status, 'warning'); $message = trim("$message; post-script rc $rc", '; '); }

  if ($repo) { $run->step('Refreshing repository info'); bb_repo_refresh($repo); }
  if ($status === 'ok' && $stats) $message = sprintf('%d files, %s new data', $stats['files'], bb_hsize($stats['deduplicated']));
  bb_record($run, 'job', $id, $job['name'], $status, $message, ['archive' => $archive, 'stats' => $stats, 'repo_id' => $repo['id'] ?? null]);
  $run->finish();
}

function bb_run_test(string $id): void {
  $test = null;
  foreach (bb_load('tests') as $t) if ($t['id'] === $id) $test = $t;
  if (!$test) { fwrite(STDERR, "Unknown test $id\n"); exit(2); }
  $repo = bb_repo($test['repo_id'] ?? '');
  $run = new BBRun('test', $id, $test['name'], "test-$id");
  $s = bb_settings();
  $status = 'ok'; $message = ''; $archive = null;
  try {
    if (!$repo) throw new RuntimeException('Repository not found');
    $lw = ['--lock-wait', (string)$s['lock_wait']];
    switch ($test['type']) {
      case 'verify':
        $run->step('Full data verification (borg check --verify-data)');
        [$rc] = $run->exec(array_merge([bb_borg_bin(), 'check', '--verify-data', '--show-rc'], $lw), bb_borg_env($repo));
        break;
      case 'extract':
        $args = [bb_borg_bin(), 'list', '--short', '--last', '1'];
        if (!empty($test['job_id']) && ($j = bb_job($test['job_id']))) array_push($args, '--glob-archives', ($j['prefix'] ?? bb_slug($j['name'])) . '-*');
        [$rc, $out] = $run->exec(array_merge($args, $lw), bb_borg_env($repo), [], true);
        $archive = trim((string)$out);
        if ($rc !== 0 || $archive === '') throw new RuntimeException('No archive found to test');
        $run->step("Test extract (dry run) of $archive");
        [$rc] = $run->exec(array_merge([bb_borg_bin(), 'extract', '--dry-run', '--show-rc'], $lw, ["::$archive"]), bb_borg_env($repo));
        break;
      default:
        $run->step('Repository and archive consistency check (borg check)');
        [$rc] = $run->exec(array_merge([bb_borg_bin(), 'check', '--show-rc'], $lw), bb_borg_env($repo));
    }
    $status = $run->cancelled() ? 'cancelled' : bb_rc_status($rc);
    $message = $status === 'ok' ? 'Passed' : "borg exited with rc $rc";
  } catch (Throwable $e) {
    $status = 'failed'; $message = $e->getMessage(); $run->line('ERROR: ' . $message);
  }
  bb_record($run, 'test', $id, $test['name'], $status, $message, ['archive' => $archive, 'repo_id' => $repo['id'] ?? null]);
  $run->finish();
}

function bb_run_restore(string $id): void {
  $specFile = BB_RUN . "/restores/$id.json";
  $spec = json_decode((string)@file_get_contents($specFile), true);
  if (!$spec) { fwrite(STDERR, "Unknown restore $id\n"); exit(2); }
  $repo = bb_repo($spec['repo_id']);
  $name = "{$spec['archive']}";
  $run = new BBRun('restore', $id, "Restore $name", 'restore');
  $s = bb_settings();
  $status = 'ok'; $message = ''; $stopped = [];
  try {
    if (!$repo) throw new RuntimeException('Repository not found');
    $dest = $spec['mode'] === 'original' ? '/' : rtrim($spec['dest'], '/');
    if ($dest === '' || $dest[0] !== '/') throw new RuntimeException('Invalid destination');
    bb_dir($dest);
    $run->line("Destination: $dest");
    $run->line('Paths: ' . ($spec['paths'] ? implode(', ', $spec['paths']) : '(entire archive)'));
    $stopped = bb_stop_containers($run, $spec['stop'] ?? [], 60);
    $run->step("Extracting from $name");
    $args = [bb_borg_bin(), 'extract', '--list', '--show-rc', '--lock-wait', (string)$s['lock_wait'], "::{$spec['archive']}"];
    [$rc] = $run->exec(array_merge($args, $spec['paths']), bb_borg_env($repo), ['cwd' => $dest]);
    $status = $run->cancelled() ? 'cancelled' : bb_rc_status($rc);
    $message = $status === 'ok' ? "Restored to $dest" : "borg extract rc $rc";
  } catch (Throwable $e) {
    $status = 'failed'; $message = $e->getMessage(); $run->line('ERROR: ' . $message);
  } finally {
    if (!bb_start_containers($run, $stopped)) $status = bb_worse($status, 'failed');
  }
  bb_record($run, 'restore', $id, "Restore $name", $status, $message, ['archive' => $spec['archive'], 'repo_id' => $spec['repo_id']]);
  @unlink($specFile);
  $run->finish();
}

/** Human readable size. */
function bb_hsize($b): string {
  $u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  $b = (float)$b; $i = 0;
  while ($b >= 1024 && $i < count($u) - 1) { $b /= 1024; $i++; }
  return round($b, $i ? 1 : 0) . ' ' . $u[$i];
}

$kind = $argv[1] ?? '';
$id = $argv[2] ?? '';
if (!bb_valid_id($id)) { fwrite(STDERR, "Usage: runner.php job|test|restore <id>\n"); exit(2); }
switch ($kind) {
  case 'job':     bb_run_job($id); break;
  case 'test':    bb_run_test($id); break;
  case 'restore': bb_run_restore($id); break;
  default: fwrite(STDERR, "Unknown command $kind\n"); exit(2);
}
