# Bazarr Translate Requester

A lightweight, headless translation request orchestrator for **Generate → Review → Request → Cleanup**.
Bazarr manages subtitles and translation requests; Lingarr performs AI translation.
The app will coordinate requests only, without a database, translation history, UI,
custom HTTP server or permanent production process.

## Current status

Phase 2 provides YAML loading, multi-instance validation, credential-safe structured
logging and manual CLI routing. Phase 3 adds read-only Bazarr metadata inspection
and official upstream API-contract documentation. **Translation functionality is not implemented yet.**
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
forwards command arguments; supported npm application aliases are dispatched
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

## Phase 3: read-only Bazarr API foundation

`npm run bazarr:inspect` loads the same configuration and queries enabled instances
independently. Failures are reported per instance/collection; unavailable counts
are not presented as empty libraries. Any failed collection yields exit code 1;
complete inspection yields 0. Wanted counts cover **all configured languages**,
not specifically Dutch. Disabled instances are skipped.

Supported methods in `src/bazarr.js`:

| Method | Official GET endpoint | Response / pagination |
| --- | --- | --- |
| `getStatus()` | `/api/system/status` | `data` object |
| `getMovies()` | `/api/movies` | `data` array and `total`; `start`/`length` |
| `getSeries()` | `/api/series` | `data` array and `total`; `start`/`length` |
| `getEpisodes({ seriesIds })` or `({ episodeIds })` | `/api/episodes` | `data` array; required `seriesid[]` or `episodeid[]` |
| `getWantedMovies()` | `/api/movies/wanted` | `data` array and `total`; `start`/`length` |
| `getWantedEpisodes()` | `/api/episodes/wanted` | `data` array and `total`; `start`/`length` |

Each client uses the instance-specific `X-API-KEY`, a request timeout and explicit
GETs with redirects disabled. Configure the **Bazarr base URL**, including any
reverse-proxy prefix (for example `https://example.org/bazarr`), not the `/api`
endpoint. Metadata keeps upstream field names, including `radarrId`,
`sonarrSeriesId`, `sonarrEpisodeId`, titles, paths, year, monitored flags,
`subtitles` and `missing_subtitles` when supplied. Empty collections are valid;
failed, malformed or incomplete responses raise safe errors without response
bodies, API keys or complete request URLs. No automatic retry loop is added.

Episodes are not globally paginated upstream. Explicit IDs are batched to keep
URLs bounded; the API returns all indexed episodes matching those IDs. Inspection
first retrieves the series IDs, then uses that endpoint to count episodes.
Library changes during offset pagination are reported as errors when counts or
repeated IDs reveal inconsistency; offset pagination cannot guarantee a perfect
snapshot during concurrent library updates.

Indexed subtitle metadata may contain `embedded_track_id` and a null subtitle
`path`. Availability depends on the Bazarr version, existing index and settings.
No ffprobe cache, disk scan, embedded extraction or eligibility decision is made.

### API specification management (development only)

Bazarr uses Flask-RESTX **Swagger 2.0**; Seerr's reference project uses OpenAPI 3.
The official Bazarr repository generates Swagger dynamically at `/api/swagger.json`
and does **not publish a static Bazarr specification**. The similarly named
`tests/bazarr/fixtures/jellyfin-openapi.json` is for Jellyfin, not Bazarr.

`npm run update:bazarr-openapi` currently reports this upstream limitation and exits
without network access or file changes. It does not load local YAML, require API
credentials or contact a running instance. No `docs/bazarr-swagger.json` is invented
or checked in. See `docs/README.md` for the verified upstream source references.
If an official static document becomes available later, the reference project's
validated download and atomic replacement design can be reused then.

```bash
docker compose up -d --build
docker compose exec requester npm run bazarr:inspect
docker compose exec requester npm run update:bazarr-openapi
docker compose exec requester npm test
```

Development mounts `scripts` and `tests` read-only and `docs` read/write, alongside
the existing source/config mounts. The production image contains neither saved
Swagger nor development scripts/tests. Runtime communication does not depend on
any downloaded specification. The static-spec status command also works locally:

```bash
npm run update:bazarr-openapi
```

Actual Bazarr connectivity will be tested separately after configuration. Use real
credentials only in the ignored external config, never in source or committed docs.
The checked-in config example uses placeholders; leave those unchanged during
offline development. `generate` and `request` never connect to Bazarr in this phase.

### No subtitle searches or translation actions

Wanted endpoints only read Bazarr's existing indexed missing-language records.
They do **not** request a provider search. The client has a fixed allowlist and
never accesses `/api/providers/movies`, `/api/providers/episodes`, scan/refresh,
download or translation actions. No Sonarr/Radarr API is called by this app.
`generate` and `request` remain nonfunctional scaffolds: neither creates or processes
`requests.yml`. The new `inspect` command is the only application operation that
reads Bazarr during this phase. It remains short-lived and database-free.
