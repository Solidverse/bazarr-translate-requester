# Bazarr Translate Requester

A lightweight, headless translation request orchestrator for **Generate → Review → Request → Cleanup**.
Bazarr manages subtitles and translation requests; Lingarr performs AI translation.
The app will coordinate requests only, without a database, translation history, UI,
custom HTTP server or permanent production process.

## Current status

Phase 4B implements language-agnostic request generation and preview, manual YAML
review, deterministic source selection and optional current-file age filtering.
`run:request` remains a scaffold; no translations are submitted. Indexed embedded
tracks can be selected with unknown codecs; see visibility and compatibility notes below.
The app stays on-demand, database-free and credential-safe.

## Configuration

Mount an external directory at `/config`. Copy `config.example.yml` to your local
`config.yml`, populate the API keys and keep `dryRun: true` for initial use.
The application reads `/config/config.yml` afresh for each operation. API keys are
never included in normal logs or validation errors; do not commit local config.

```yaml
instances:
  - name: Main
    enabled: true
    bazarr:
      url: http://bazarr:6767
      apiKey: YOUR_BAZARR_API_KEY
    # Optional; omit either complete section when unused.
    sonarr:
      url: http://sonarr:8989
      apiKey: YOUR_SONARR_API_KEY
    radarr:
      url: http://radarr:7878
      apiKey: YOUR_RADARR_API_KEY
    translation:
      sourceLanguage: en
      targetLanguage: nl
      onlyEmbedded: true
logging:
  level: info
dryRun: true
```

See `config.example.yml` for the complete HD/4K example. Bazarr and translation
settings are required for enabled instances. Sonarr and Radarr are optional: remove
those sections for Bazarr-only operation. A present service section must contain a
valid HTTP/HTTPS URL and nonempty API key; URLs cannot contain embedded credentials,
query strings or fragments. Reverse-proxy base paths are supported.

Names must be nonempty and unique (including disabled instances); `enabled` must be
boolean. Disabled instances do not need connection credentials or translation
settings and initialize no clients. Global settings remain `logging` and `dryRun`.
Every environment keeps its own credentials and media IDs; no services are matched
by name or searched across environments for matching numeric IDs.

Logging supports `debug`, `info`, `warn`, `error` and writes JSON lines to stdout/stderr.
API keys from all nested services are redacted, including keys in instance names.

### Manual configuration migration

The old top-level `bazarr` array and global `translation` block are no longer accepted.
The loader reports a migration error; it never rewrites configuration files.

1. Back up your external `/config/config.yml` (or `dev-config/config.yml`).
2. Create `instances`; move each old Bazarr entry's `url`/`apiKey` into its nested
   `bazarr` block. Keep that entry's `name` and `enabled` on the parent instance.
3. Copy the old translation settings into each instance's `translation` block.
4. Add Sonarr/Radarr only under their associated parent, or omit them entirely.
5. Remove obsolete root-level service/translation/scheduling fields; retain global
   `logging` and `dryRun`. Compare with `config.example.yml` and run an inspection.

Your existing development config is intentionally left untouched and needs this
manual migration before running commands that load it.

## Commands

```bash
npm start                 # usage, no configuration required
node src/index.js help    # usage
npm run run:generate      # generate a review batch from indexed metadata
npm run run:request       # request scaffold, loads /config/config.yml
npm run bazarr:inspect   # indexed Bazarr library and wanted metadata
npm run services:inspect # status/version of all configured services
npm test                  # offline Node.js tests
```

Node.js >=24.22.1 <25, ES modules, `yaml` and Tsarr 2.16.3 are used. No CLI framework
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
socket access. Generation requires read-only API access; the request scaffold does not.

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

## Generate → Review → Request → Cleanup

```bash
npm run run:generate -- --preview
npm run run:generate -- --instance HD --type movie
npm run run:generate -- --type series --instance HD --series 123 --min-age 7
```

All arguments are optional. No arguments selects every enabled instance and both
movies and episodes. The configuration is `/config/config.yml`; output is
`requests.yml` beside that configuration file (also when a caller uses a custom
config path). Generating this local review file is allowed with `dryRun: true`.
Generation never submits translations, regardless of dry-run.

| Option | Meaning |
| --- | --- |
| `--type movie` | Movies only |
| `--type series` | Individual episodes only |
| `--instance NAME` | One enabled instance, selected by its exact configured name |
| `--series ID` | One Sonarr series ID as indexed in Bazarr; implies series mode |
| `--min-age DAYS` | Nonnegative integer; current video file must be this many 24-hour days old |
| `--preview` | Same selection and filtering, with candidate details in logs and no file changes |

`--series` needs exactly one enabled instance or an explicit `--instance`, preventing
cross-instance numeric-ID ambiguity. Unknown/duplicate flags and incompatible
arguments fail. There are no title limits. The development watcher still starts
with help, never with generation; invoke commands explicitly inside the container.

### Languages, eligibility and source priority

Each instance uses its own `sourceLanguage`, `targetLanguage` and `onlyEmbedded`
(default `true`, must be boolean). The example language pair is only an example.
Two- and three-letter codes are resolved using that instance's read-only Bazarr
language catalog, with ICU ISO aliases. Unsupported codes and identical resolved
source/target languages fail. Bazarr's custom regional identifiers remain distinct;
region/script tags are rejected rather than silently reduced to a base language.
Human language names and filenames are never used to infer language.

**Any indexed target-language subtitle blocks generation**, including forced, HI,
embedded, external and image-based targets. Unknown language metadata is not treated
as absence. Only existing source-language tracks are considered. Forced source
tracks, missing/ambiguous database IDs and unsupported formats are excluded.

The deterministic priority policy is embedded normal, embedded HI, external normal,
external HI. Embedded-only mode excludes every external source, but never affects
target detection. Equal-priority embedded sources sort by numeric stream ID, then numeric database
ID; external sources sort by numeric database ID. Missing values follow valid
numeric values, with deterministic typed-ID/path metadata as the final fallback.
Numeric strings are compared numerically without changing the stored IDs.
ID order does not imply better quality. All safely eligible tracks appear in YAML,
with one `selectedSubtitleId`. IDs retain their API type.

### Verified indexed-metadata limitations

The official indexed subtitle model exposes subtitle database `id`,
`embedded_track_id`, language, flags, path and size, but usually no embedded codec.
**An indexed embedded source with a valid database ID and stream ID is eligible even
when its codec is unknown.** YAML preserves `codec: unknown` and the stream ID
separately. Selection and the four-level priority policy apply normally in
embedded-only mode. Explicitly known bitmap codecs (PGS/VobSub/DVB/XSub) and forced
source tracks remain excluded. Unknown does not mean verified text: a later
translation may still be rejected by Bazarr. No probing or extraction occurs here.

The official `PATCH /api/subtitles` accepts `action=translate` with a subtitle
**database** `subtitles_id` for embedded sources and handles extraction internally.
Its implementation documents HTTP 415 for unsupported image-based tracks; failures
can also occur during the server's queued work. Tsarr's JavaScript serialization
preserves this parameter, as verified with mocked transport. No particular target
Bazarr version is assumed and no live translation compatibility is claimed.
Phase 5 must handle unsupported tracks and server errors safely.

With `onlyEmbedded: false`, existing external `.srt`, `.ass`, `.ssa` and `.vtt`
tracks with valid database IDs and paths are also eligible. External translation
uses the exact indexed path; `selectedSubtitleId` still refers to the listed
subtitle database record for review and revalidation. Ambiguous `.sub` and unknown
external formats remain excluded. See [API notes](docs/README.md) for sources.

Bazarr's **Show Only Desired Languages** setting can hide embedded languages from
library responses. Profile-based `missing_subtitles` is not our target-language
requirement and is never used as visibility evidence. The generator reads
GET `/api/system/settings` and determines visibility **per media item**:

- When `general.embedded_subs_show_desired` is explicitly `false`, all indexed
  subtitle languages are visible and no language-profile request is needed.
- When it is explicitly `true`, GET `/api/system/languages/profiles` is retrieved
  **once per instance**, through Tsarr `getLanguageProfiles()`. The assigned profile
  must explicitly include both configured source and target languages after resolving
  their identifiers with that instance's existing language resolver.
- Movies use their own `profileId`; episodes use the parent series' `profileId`.
  Episode-level profile fields never substitute for an absent parent assignment.
- Missing/unknown profiles, insufficient languages, inaccessible profile data or an
  unknown setting leave target absence uncertain. Debug logs identify the media,
  assigned profile ID and unresolved condition. An observed target subtitle always
  prevents generation, including forced/HI targets, regardless of profile visibility.

The endpoint returns a bare array of `{ profileId, items: [{ language, ... }] }`.
Profile item forced/HI/cutoff flags do not narrow Bazarr's display-language filter;
source-track forced/HI rules still apply during selection. No languages are inferred
from profile names or language-equals expansions, and no language pair is hardcoded.

**No setting change is required for media with a verified profile containing both
languages.** The setting may stay enabled. For unresolved profiles, correct their
assignments/languages manually or optionally disable the display filter; the app
never modifies Bazarr settings. It rechecks visibility after collection and aborts
publication if previously established visibility can no longer be confirmed.
Profiles are a run-local snapshot, not a disk scan or an atomic transaction across
concurrent profile, setting and library changes; Phase 5 must revalidate fresh data.

The settings GET is an official authenticated read-only endpoint hidden from Swagger;
Tsarr has no named Bazarr method for it. A narrow adapter uses Tsarr's publicly
exported core transport (authentication/timeout) and immediately reduces the response
to visibility booleans. The settings body can contain unrelated service credentials:
it is never returned, logged or stored in the batch. No private SDK fields or
separate HTTP client are used.

### Optional age filtering

Without `--min-age`, no Sonarr/Radarr age client is created or queried. With it,
movies require the current instance's Radarr, and episodes its Sonarr. Missing
required integrations or failed library queries abort the whole generation without
publishing partial results. An individual unknown/mismatched file or invalid/future
timestamp excludes that item and is counted separately.

Radarr movies are fetched once and use current `movieFile.id`/`movieId` and
`movieFile.dateAdded`, checking `movieFileId` when supplied. Sonarr fetches episodes
and episode files once per relevant series and joins `episodeFileId` to the current
file's `id`, checking `seriesId`. Only file `dateAdded` is used: release dates, air
dates and original library addition dates do not qualify a replacement file. A
single reference time is captured per run, and the minimum-age boundary is inclusive.
IDs are never looked up in another instance.

### Review YAML and batch protection

Example of an indexed embedded-source batch:

```yaml
requests:
  - instance: HD
    type: movie
    title: Example Movie (2025)
    mediaId: 123
    sourceLanguage: es
    targetLanguage: de
    selectedSubtitleId: 789
    tracks:
      - id: 789
        source: embedded
        language: es
        hi: false
        forced: false
        codec: unknown
        embedded_track_id: 2
      - id: 790
        source: embedded
        language: es
        hi: true
        forced: false
        codec: unknown
        embedded_track_id: 3
```

Episode entries use `type: episode` and also carry `seriesId`. The batch preserves
configured source/target codes, while each track carries its resolved Bazarr
language code. Change `selectedSubtitleId` to another listed track's ID, preserving
its YAML type, or delete entire entries you do not want. Do not add approval/status
fields. One media item appears at most once per instance. Output order follows
instance order and stable media-ID/track ordering.

Existing batches, including symlinks, are never replaced, merged or deleted.
Preview works even with an existing batch. No candidates means no empty file.
Publication writes and syncs a private temporary file, then atomically hard-links
it to `requests.yml`, preventing concurrent generators from replacing a batch.
Temporary files are removed afterwards. Filesystems lacking hard-link support fail
clearly; no unsafe overwrite fallback is used. Required API failures abort publishing;
normal metadata exclusions are logged and summarized by instance.

The request command is **not implemented**. Phase 5 must validate the selected ID
against the list and fresh Bazarr metadata, confirm current language settings and
missing target, submit at most one translation, remove accepted entries, retain
failures and delete the batch when empty. None of those actions happen now.

## Read-only service inspection

`npm run services:inspect` checks each enabled instance’s Bazarr, plus Sonarr and
Radarr when configured. It uses SDK `getSystemStatus()` for the optional services
(GET `/api/v3/system/status`) and the existing Bazarr status facade
(GET `/api/system/status`). Bazarr returns a nested data envelope; Sonarr and Radarr
return their status object directly inside the SDK result. Versions are shown when
available. Failures are isolated per service and instance; any failure gives exit
code 1. Missing optional services are neither initialized nor treated as errors.

```bash
docker compose exec requester npm run services:inspect
```

## Read-only Bazarr library inspection

`npm run bazarr:inspect` loads the same configuration and queries enabled instances
independently. Failures are reported per instance/collection; unavailable counts
are not presented as empty libraries. Any failed collection yields exit code 1;
complete inspection yields 0. Wanted counts cover **all configured languages**,
not specifically Dutch. Disabled instances are skipped.

Supported methods in `src/bazarr.js`:

| Method | Official GET endpoint | Response / pagination |
| --- | --- | --- |
| `getStatus()` | `/api/system/status` | `data` object |
| `getLanguages()` | `/api/system/languages` | Bare language-catalog array |
| `getLanguageProfiles()` | `/api/system/languages/profiles` | Bare profile array; fetched once per filtered instance |
| `getMovies()` | `/api/movies` | `data` array and `total`; `start`/`length` |
| `getSeries()` | `/api/series` | `data` array and `total`; `start`/`length` |
| `getEpisodes({ seriesIds })` or `({ episodeIds })` | `/api/episodes` | `data` array; required `seriesid[]` or `episodeid[]` |
| `getWantedMovies()` | `/api/movies/wanted` | `data` array and `total`; `start`/`length` |
| `getWantedEpisodes()` | `/api/episodes/wanted` | `data` array and `total`; `start`/`length` |
| `getSubtitles({ subtitlesPath, radarrMovieId })` or `sonarrEpisodeId` | `/api/subtitles` | Track-reference `data` object; no pagination |

[Tsarr 2.16.3](https://github.com/robbeverhelst/Tsarr) provides the generated API
bindings, authentication, JSON handling and 30-second timeout. Each enabled instance
has its own `BazarrClient`; no custom HTTP client or Swagger downloader is maintained.
The installed package declares Node >=24.21.0; this project requires >=24.22.1 <25
and both Docker stages use `node:24.22.1-bookworm-slim`.

Our small read-only facade handles collection pagination, metadata validation and
safe errors. Tsarr returns `{ data, error, request, response }`, so we check the HTTP
status and error before reading the nested Bazarr response. Keys, SDK request objects,
response bodies and raw transport exceptions are never included in diagnostics.
SDK retries are not enabled. Tsarr supplies the `X-API-KEY` header automatically.
It follows redirects by default; configure the final trusted Bazarr URL directly.
Include any reverse-proxy prefix (for example `https://example.org/bazarr`).

SDK methods used: `getSystemStatus`, `getMovies`, `getSeries`, `getEpisodes`,
`getMoviesWanted`, `getEpisodesWanted`, `getLanguages`, `getLanguageProfiles`, and
the explicitly requested `getSubtitles`.
Metadata retains upstream names: `radarrId`, `sonarrSeriesId`, `sonarrEpisodeId`,
titles, paths, year, monitored flags, `subtitles` and `missing_subtitles` when supplied.
Empty collections are valid; malformed, failed or incomplete responses are errors.
`getSubtitles({ subtitlesPath, radarrMovieId })` (or `sonarrEpisodeId`) retrieves
track references through the SDK. It requires an explicit path and media ID and is
not called by inspection: indexed subtitle information already comes with library
metadata. Upstream can probe media and update its metadata cache on a cache miss;
there is no cache-only parameter. It is not a global subtitle listing or embedded
extraction operation. Inspection uses only existing library/wanted records.

Episodes are not globally paginated upstream. Explicit IDs are batched to keep
URLs bounded; the API returns all indexed episodes matching those IDs. Inspection
first retrieves the series IDs, then uses that endpoint to count episodes.
Library changes during offset pagination are reported as errors when counts or
repeated IDs reveal inconsistency; offset pagination cannot guarantee a perfect
snapshot during concurrent library updates.

Indexed subtitle metadata may contain `embedded_track_id` and a null subtitle
`path`. Availability depends on the Bazarr version, existing index and settings.
No ffprobe cache, disk scan, embedded extraction or eligibility decision is made.

### SDK and embedded translation compatibility

Bazarr uses Swagger 2.0; the Seerr reference project uses OpenAPI 3. Tsarr bundles
generated Bazarr bindings, so there is no application Swagger download command or
saved specification dependency. See [API notes](docs/README.md) for upstream sources.

A mock-only test verifies this **future** SDK invocation for an embedded track:

```javascript
await sdk.applySubtitleMods({ query: {
  action: 'translate', language: 'nl', type: 'movie', id: 123,
  subtitles_id: 456, forced: 'False', hi: 'False', original_format: 'True',
} });
```

The generated `patchSubtitles` passes `query` through, and the serializer keeps
`subtitles_id` as well as all other supplied parameters. `path` can be omitted in
JavaScript for embedded translation. The bundled declarations are older: they still
require `path` and do not declare `subtitles_id`. Mock tests prove serialization,
not acceptance by any installed Bazarr version or successful translation. There is
no application translation command yet; the example is not invoked at runtime.

```bash
docker compose up -d --build
docker compose exec requester npm run bazarr:inspect
docker compose exec requester npm test
```

Rebuild after dependency changes. Development mounts source, tests and the config
example read-only, plus external config and `docs`. Production excludes tests and
development documentation. No documentation is downloaded during either command.

Actual Bazarr connectivity will be tested separately after configuration. Use real
credentials only in the ignored external config, never in source or committed docs.
The checked-in config example uses placeholders; leave those unchanged during
offline development. `request` remains a scaffold; generation uses only the indexed read endpoints described above.

### No subtitle searches or translation actions

Wanted endpoints only read Bazarr's existing indexed missing-language records.
They do **not** request a provider search. The application exposes only named
read methods and never accesses `/api/providers/movies`, `/api/providers/episodes`, scan/refresh,
download or translation actions. Sonarr/Radarr access is limited to system status
through `services:inspect`; Bazarr library inspection never initializes those clients.
`generate` creates a local review batch; `request` remains a scaffold and never
processes it. Generation and inspection remain short-lived and database-free.
