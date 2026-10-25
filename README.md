# Bazarr Translate Requester

A lightweight, headless translation request orchestrator for **Generate → Review → Request → Cleanup**.
Bazarr manages subtitles and translation requests; Lingarr performs AI translation.
The app will coordinate requests only, without a database, translation history, UI,
custom HTTP server or permanent production process.

## Current status

Phase 2 provides YAML loading, multi-instance validation, credential-safe structured
logging and manual CLI routing. **Translation functionality is not implemented yet.**
Both operation scaffolds validate configuration, identify the requested operation,
report that it is not implemented and exit successfully. Neither connects to Bazarr
nor creates or processes a request file. Actual configuration/command errors exit
nonzero. No translation requests happen automatically, including in development.

## Configuration

Mount an external directory at `/config`. Copy `config.example.yml` to your local
`config.yml`, populate the API keys and keep `dryRun: true` for initial use.
The application reads `/config/config.yml` afresh for each operation. API keys are
never included in normal logs or validation errors; do not commit local config.

```yaml
translation:
  sourceLanguage: en
  targetLanguage: nl
bazarr:
  - name: HD
    enabled: true
    url: http://bazarr-hd:6767
    apiKey: YOUR_HD_API_KEY
  - name: 4K
    enabled: false
    url: http://bazarr-4k:6767
    apiKey: YOUR_4K_API_KEY
logging:
  level: info
dryRun: true
```

Each Bazarr instance has independent connection settings. Disabled instances are
not used. Keep distinct names to identify future batch entries. Logging supports
`debug`, `info`, `warn`, `error` and writes JSON lines to stdout/stderr with API-key
redaction. Configurable log levels apply to scaffold diagnostics too.

## Commands

```bash
npm start                 # usage, no configuration required
node src/index.js help    # usage
npm run run:generate      # generate scaffold, loads /config/config.yml
npm run run:request       # request scaffold, loads /config/config.yml
npm test                  # offline Node.js tests
```

Node.js 24, ES modules and the existing `yaml` dependency are used. No CLI framework
or extra services are required. Production commands execute once and terminate.

## Docker development

Put configuration in the ignored `dev-config/config.yml`, then run:

```bash
docker compose up -d --build
docker compose logs -f
```

Compose preserves the `development` Docker target, `npm run dev`,
`node --watch src/index.js`, source bind mount, external `/config` mount and Compose
watch rebuild rules. The watcher displays usage at startup and on source reload;
it does not generate or submit requests. Remaining active in development is
intentional. To invoke an operation inside the running container:

```bash
docker compose exec requester npm run run:generate
docker compose exec requester npm run run:request
```

## On-demand production / Unraid

Image: `ghcr.io/solidverse/bazarr-translate-requester:latest`.
Mount `/mnt/user/appdata/bazarr-translate-requester` to `/config`.
No production Compose project or persistent container is required:

```bash
docker run --rm \
  -v /mnt/user/appdata/bazarr-translate-requester:/config \
  ghcr.io/solidverse/bazarr-translate-requester:latest \
  npm run run:generate

docker run --rm \
  -v /mnt/user/appdata/bazarr-translate-requester:/config \
  ghcr.io/solidverse/bazarr-translate-requester:latest \
  npm run run:request
```

Direct commands such as `node src/index.js generate` also work. The entrypoint
forwards command arguments; the two supported npm operation aliases are dispatched
directly to Node so it receives container signals as PID 1. The default command
prints help and exits. No keep-alive, restart policy or background services are
needed. Do not use privileged mode, host networking, published ports or Docker
socket access. No network access is needed for the current scaffolds.

Production defaults to PUID `99`, PGID `100`; override with `-e PUID=1000 -e PGID=1000`
if necessary. Initialization briefly runs as root, validates positive numeric IDs,
manages ownership of `/config` and existing `config.yml`/`requests.yml` only, then
executes the command unprivileged using `gosu`. It preserves contents and file
modes, does not recurse into unrelated files and rejects linked or special
application files. Do not use `--user`; restrictive modes, read-only mounts or
network filesystems that disallow ownership changes may require adjustment.
Development bypasses this production entrypoint and does not chown WSL bind mounts.

Build locally:

```bash
docker build --target production -t bazarr-translate-requester:local .
docker build --target development -t bazarr-translate-requester:dev .
```

The existing GitHub Actions workflow remains unchanged: offline tests, production
build, main publication with `latest`, version tags and commit tags, authenticated
with `GITHUB_TOKEN`. No release-only publishing requirement is introduced.

## Future temporary batch workflow

The intended user-controlled workflow is:

1. **Generate:** find missing normal Dutch subtitles with suitable embedded English
   source subtitles across enabled Bazarr instances; create `/config/requests.yml`.
2. **Review:** manually remove entries you do not want translated.
3. **Request:** revalidate and submit the remaining entries through Bazarr.
4. **Cleanup:** remove accepted entries, retain failures for retry, and delete the
   file once empty. Never overwrite an existing unprocessed batch.

Example of the future batch format:

```yaml
requests:
  - instance: HD
    type: movie
    title: "Example Movie (2025)"
    mediaId: 123
  - instance: HD
    type: episode
    title: "Example Series S01E01"
    mediaId: 456
```

This file is temporary, externally mounted and manually editable. It is not a
permanent database or translation history. **Batch generation, API communication,
submission and cleanup are future work and are not performed by this phase.**
