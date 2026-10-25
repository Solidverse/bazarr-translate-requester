# Bazarr Translate Requester

Phase 1 foundation for `Solidverse/bazarr-translate-requester`. Each execution reads external YAML, validates it, reports enabled Bazarr instances, and exits. Scaffold mode never contacts Bazarr, even when `dryRun` is false. No translation, database, history, server, or persistent application state is implemented.

Development follows [mdblist-seerr-requester](https://github.com/Solidverse/mdblist-seerr-requester): Compose, source bind mounts, Node watch mode, dependency rebuild rules, and external configuration. Production uses Debian cron to start short-lived Node processes instead of a Node scheduler.

## Development (Docker Compose only)

Create configuration once, then edit it locally. These commands preserve an existing file:

```bash
mkdir -p dev-config
test -e dev-config/config.yml || cp config.example.yml dev-config/config.yml
docker compose up -d --build
docker compose logs -f
```

`./dev-config:/config` and `./src:/app/src:ro` are bind mounts. `npm run dev` runs `node --watch src/index.js`. After the initial execution finishes, the watcher stays alive and reruns the same entry point on imported JavaScript changes, without restarting the container. There is no development cron daemon or configuration watcher. Configuration edits take effect on the next manual execution or source-triggered execution.

Run manually and run tests inside the development image:

```bash
docker compose exec requester npm start
docker compose run --rm --no-deps \
  -v "$PWD/tests:/app/tests:ro" \
  -v "$PWD/config.example.yml:/app/config.example.yml:ro" \
  requester npm test
```

Enable Compose's dependency/Dockerfile rebuild rules in a separate terminal:

```bash
docker compose watch
```

Or use `docker compose up --build --watch` in the foreground. Plain `up -d --build` enables source reload through Node; Compose rebuild rules require an active `watch` session. Development runs as the image's `node` user (1000:1000); ensure the external configuration is readable by that user. `dev-config` is ignored by Git and excluded from image builds. Do not install dependencies or run Node on the host.

## Production (standalone Docker / Unraid)

Create `/mnt/user/appdata/bazarr-translate-requester/config.yml` using `config.example.yml` before starting:

```bash
docker run -d \
  --name bazarr-translate-requester \
  --restart unless-stopped \
  --stop-timeout 30 \
  -e TZ=Europe/Amsterdam \
  -v /mnt/user/appdata/bazarr-translate-requester:/config \
  ghcr.io/solidverse/bazarr-translate-requester:latest

docker logs -f bazarr-translate-requester
```

No Compose, published ports, source mounts, privileged mode, host networking, or Docker socket are needed. Source and runtime dependencies are baked into the production image. Cron, tzdata, flock (util-linux), gosu, tini, and process utilities are installed in the production stage only. The development watcher is never invoked in production.

Root initializes cron and changes ownership of `/config` and its single `config.yml` only. Defaults are Unraid's `PUID=99` and `PGID=100`; override both with positive numeric IDs for another host. Node always runs unprivileged, including schedule validation at startup. Do not set `--user`. Existing configuration contents and modes are preserved; missing configuration fails startup and is never created or overwritten. Unrelated files are untouched. Symlinked/hardlinked config files are rejected. Use trusted local appdata storage that allows ownership changes; readonly mounts and filesystems prohibiting chown are unsupported.

At startup, the entrypoint validates `TZ` against installed timezone data and configures **both `/etc/timezone` and `/etc/localtime`** before starting Debian cron. [Debian cron documents](https://manpages.debian.org/bookworm/cron/cron.8.en.html) that its daemon reads `/etc/timezone`; merely exporting `TZ` is insufficient. UTC is the default. Cron follows Debian's daylight-saving behavior. Application log timestamps use UTC ISO strings.

A short-lived, unprivileged Node initialization validates YAML and writes the schedule through the root shell into `/etc/cron.d/requester`. Cron runs in the foreground under a small shell supervisor and tini. No Node process remains between jobs; the first application execution waits for its scheduled minute. Cron's root launcher opens Docker stdout/stderr, acquires a nonblocking flock, then uses gosu to replace itself with unprivileged Node. The lock remains held until Node exits. Overlaps are skipped with exit code 75. No lock queue or persistent application state is kept; the lock is an ephemeral `/run` file.

Manual execution uses the same lock and identity as cron:

```bash
docker exec bazarr-translate-requester /usr/local/bin/run-requester
```

Manual output goes to the invoking terminal. Scheduled stdout/stderr goes directly to `docker logs`. Invalid configuration causes that execution to fail and log a clear error; cron continues to allow later executions after configuration is fixed. YAML syntax diagnostics omit source excerpts. Logs exclude URLs and configuration dumps, and redact API keys even if repeated in an instance name.

SIGTERM/SIGINT stop cron and signal active application processes; the supervisor waits for them, and tini reaps descendants. Docker's stop timeout bounds shutdown. Phase 1 has no work requiring custom Node signal handlers; Node's default termination is appropriate. Increase the timeout when later phases introduce work needing longer cleanup.

## Configuration

The only application configuration path is `/config/config.yml`. Every application execution reads YAML afresh. Restart the container after changing `scheduleCron` or `TZ`; other settings take effect on the next execution. No configuration file watcher runs.

`scheduleCron` accepts five **numeric** fields: minute (0–59), hour (0–23), day (1–31), month (1–12), weekday (0–7, Sunday 0/7). Wildcards, lists, ascending ranges, and positive steps on wildcards/ranges are supported, for example `0 */6 * * *`. Names, seconds, aliases such as `@hourly`, and extensions such as `L`, `W`, and `#` are rejected. This deliberately limited Debian-compatible syntax is validated before cron starts. As with Debian cron, restricted day-of-month and weekday fields match using OR; schedules like February 31 are syntactically valid but may never execute.

Translation language values must be nonempty strings and `minimumAgeHours` must be a nonnegative number; Phase 1 only validates these values. `bazarr` is an array. Each instance requires boolean `enabled`; enabled instances additionally need a nonempty name, API key, and HTTP/HTTPS URL without embedded credentials. Disabled instances may omit those settings. An empty array is allowed. Logging supports `debug`, `info`, `warn`, and `error`; completion messages are at info level. `dryRun` must be boolean. Start with `dryRun: true`.

## Verification

Run the configuration tests using the development command above. They cover valid/missing/invalid YAML, value types, repeated reads, enabled/disabled instances, cron syntax and injection rejection, logging levels, and credential redaction.

Verified on 2026-10-25: all eight unit tests passed; both Docker targets built; source edits reloaded without changing the development container ID; Compose watch rebuilt on a package-file change; manual execution worked in both modes; the production launcher used UID 99; flock rejected overlap with exit 75; Debian cron executed at a specific Amsterdam local minute and delivered logs to Docker; no Node remained afterward; active Node received SIGTERM and container shutdown exited 0. Missing config, invalid cron, invalid timezone and UID 0 all failed startup. Image publication itself requires running the workflow in GitHub and was not performed locally.

Build the standalone production target:

```bash
docker build --target production -t bazarr-translate-requester:local .
```

For a runtime smoke test, use a separate temporary config directory, copy the example there, and change **its** schedule to `* * * * *`. Start the local image with that directory mounted at `/config` and `TZ=Europe/Amsterdam`. After a minute, `docker logs` should show one completed scaffold execution. These commands inspect the scheduler and idle processes:

```bash
docker exec bazarr-translate-requester cat /etc/timezone
docker exec bazarr-translate-requester cat /etc/cron.d/requester
docker exec bazarr-translate-requester ps -eo pid,ppid,uid,args
docker exec bazarr-translate-requester /usr/local/bin/run-requester
```

Between jobs, the process list should contain cron, tini and the shell supervisor, with no Node process. During execution, Node's UID should match PUID. Confirm reload with `touch src/index.js` and `docker compose logs --since 10s`; the container ID should remain unchanged. Test flock by holding `/run/requester/execution.lock` in one terminal:

```bash
docker exec bazarr-translate-requester flock /run/requester/execution.lock sleep 90
```

In another terminal, run the manual command: it must exit 75 immediately without application logs. Scheduled executions during the held lock are skipped too. Test shutdown with `docker stop bazarr-translate-requester`, and inspect the stop message and zero exit status. To test the daemon's actual scheduling timezone, set the smoke config to the next minute's **Amsterdam local hour/minute**, rather than `* * * * *`; a run at that minute verifies the daemon uses the configured zone. Restore the normal schedule and restart afterward.

## Publishing

`.github/workflows/docker-publish.yml` runs Node 24 native tests before publishing the **production** target to `ghcr.io/solidverse/bazarr-translate-requester` for `linux/amd64`. Pull requests run tests only. Main-branch builds publish `latest`; manually created version tags such as `v1.0.0` publish the corresponding `v1.0.0` image tag without replacing `latest`. Builds also receive a full commit SHA tag.

Publishing uses the built-in `GITHUB_TOKEN`; only the publish job has `packages: write`. No personal token, automatic version tags, or releases are used. After the first publish, make the GHCR package public if anonymous pulls are desired. The Docker build context uses an allowlist, excluding local config, tests, Git metadata and environment files. Never put credentials in application source or build arguments.
