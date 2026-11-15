# Borg Backup for Unraid

A simple, native Unraid plugin for [BorgBackup](https://www.borgbackup.org/).
No daemon, no extra port, no Python: the UI is plain Unraid pages, schedules use
Unraid's own cron, and the official Borg standalone binary is installed for you.

The **Backup** tab in the top menu (right of Tools) has these pages:

| Tab | What it does |
|---|---|
| **Dashboard** | Status at a glance, running tasks with live logs, next run, recent activity |
| **Jobs** | Create / edit / run / enable backup jobs (wizard) |
| **Repositories** | Local or SSH repositories, size & archive stats, key export |
| **Restore** | Browse archives, pick files or folders, restore to a folder or the original location |
| **Tests** | Scheduled `borg check`, full data verification and dry-run test restores |
| **Scripts** | Library of pre/post-backup bash scripts with templates and test run |
| **Settings** | Borg binary, cache/log folders, notifications, SSH key |

## The job wizard

1. **Source:** Container, Compose stack or Custom.
   * *Container:* mapped host paths are read from `docker inspect`, and each one has a tickbox.
   * *Compose stack:* mounts are resolved with `docker compose config`, so `.env` variables are applied. Named volumes are mapped to their host path. Stacks are found from the Compose Manager plugin and from any compose project Docker knows about (Dockge, CLI, …).
   * *Custom:* any host path, with a folder browser.

   App data folders and Docker volumes are ticked by default. Media shares and system paths (`docker.sock`, `/dev`, …) are not.
2. **Containers:** stop the container or stack during the backup, or keep it running. For custom jobs you can pick any containers to stop. Stopped containers are always started again, in dependency order, even if the backup fails.
3. **Repository:** pick an existing one or create a new one (`borg init`) right in the wizard.
4. **Schedule:** manual, hourly, daily, weekly, monthly or a custom cron expression, plus retention (prune and compact) and compression.
5. **Scripts:** a pre- and post-backup script for each job, picked from the library or written inline.
6. **Review:** save, or save and run now.

The order of a run is: pre-script → stop containers → `borg create` → start containers → prune and compact → post-script.

## Install

In Unraid go to **Plugins → Install Plugin** and paste:

```
https://raw.githubusercontent.com/macmillernz/borg-backup/main/borg-backup.plg
```

Requires Unraid 6.12 or newer.

## Where things are stored

| Path | Content |
|---|---|
| `/boot/config/plugins/borg-backup/*.json` | jobs, repositories (incl. passphrases), tests, settings, status, history |
| `/boot/config/plugins/borg-backup/scripts/` | script library |
| `/boot/config/plugins/borg-backup/ssh/` | SSH key and known_hosts for remote repos |
| `/boot/config/plugins/borg-backup/borg/` | `BORG_CONFIG_DIR` (keyfiles, security data) |
| `/mnt/user/appdata/borg-backup/cache` | Borg cache (configurable, falls back to `/tmp` when the array is stopped) |
| `/var/log/borg-backup/` | run logs (RAM by default, configurable) |

Repository passphrases are stored on the flash drive so scheduled jobs can run
unattended. **Keep a copy of every passphrase and an exported key** (Repositories →
export key) somewhere other than this server.

Uninstalling the plugin keeps everything in `/boot/config/plugins/borg-backup`. Your
repositories are never touched.

## Development

```
source/usr/local/emhttp/plugins/borg-backup/
  Borg*.page          Unraid pages (BorgBackup.page = menu parent, others = tabs)
  include/lib.php     storage, borg/docker/compose helpers, cron
  include/api.php     JSON API used by the pages (POST + Unraid CSRF token)
  include/runner.php  CLI runner for jobs, tests and restores (cron + UI)
  assets/             borg.css, borg.js (pages), wizard.js (job wizard)
```

Run the backend tests (PHP 8 and bash; no Unraid, Docker or Borg needed, since a fake `borg` records its calls):

```
php tests/run.php
```

To release, run `./build.sh` (or `./build.sh 2026.11.15a` for a second build on the same day). It creates
`archive/borg-backup-<version>-x86_64-1.txz` and writes the version and MD5 into
`borg-backup.plg`. Commit both and push.

You can run the runner by hand on the server:

```
php /usr/local/emhttp/plugins/borg-backup/include/runner.php job <job-id>
```
