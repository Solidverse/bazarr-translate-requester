# Official Bazarr API reference

Bazarr uses Flask-RESTX to generate **Swagger 2.0 dynamically**. The official
upstream repository does not publish a static Bazarr Swagger/OpenAPI JSON/YAML
specification. Its `jellyfin-openapi.json` test fixture describes Jellyfin, not Bazarr.
No API specification is fabricated or downloaded from a running local instance.

The application uses [Tsarr 2.16.3](https://github.com/robbeverhelst/Tsarr) generated
Bazarr bindings. There is no custom Swagger downloader, no generated local schema,
and no running Bazarr instance is required for development or offline tests.

Authoritative sources (only the official project is used):

- [API root/authentication](https://github.com/morpheus65535/bazarr/blob/master/bazarr/api/__init__.py): `/api`, Swagger security `X-API-KEY`.
- [Dynamic Swagger route](https://github.com/morpheus65535/bazarr/blob/master/libs/flask_restx/api.py): runtime `/swagger.json` and generated schema.
- [API documentation metadata](https://github.com/morpheus65535/bazarr/blob/master/bazarr/api/swaggerui.py): Swagger title/version and indexed subtitle field definitions.
- [Movies](https://github.com/morpheus65535/bazarr/blob/master/bazarr/api/movies/movies.py): GET `movies`, `start`/`length`, `data`/`total`, `radarrId`.
- [Series](https://github.com/morpheus65535/bazarr/blob/master/bazarr/api/series/series.py): GET `series`, `start`/`length`, `data`/`total`, `sonarrSeriesId`.
- [Episodes](https://github.com/morpheus65535/bazarr/blob/master/bazarr/api/episodes/episodes.py): GET `episodes`, `seriesid[]` or `episodeid[]` required, unpaged `data` array.
- [Wanted movies](https://github.com/morpheus65535/bazarr/blob/master/bazarr/api/movies/wanted.py) and [wanted episodes](https://github.com/morpheus65535/bazarr/blob/master/bazarr/api/episodes/wanted.py): paged indexed missing-language records, not provider searches.
- [System status](https://github.com/morpheus65535/bazarr/blob/master/bazarr/api/system/status.py): `data` object with `bazarr_version`.
- [Authentication and metadata postprocessing](https://github.com/morpheus65535/bazarr/blob/master/bazarr/api/utils.py): header authentication, indexed subtitles, missing languages, monitored values and path mapping.

Contracts were checked against official upstream `master` during Phase 3. Installed
versions may differ. In particular, library responses contain `data`/`total`, while
episodes and system status do not share that envelope shape. Episode titles use
`title` in library metadata and `episodeTitle` in wanted metadata. Series titles
are available on series records (`title`) and wanted episode records (`seriesTitle`).

`subtitles` can contain `embedded_track_id` and a null `path` when already indexed;
server settings can hide some embedded entries. No ffprobe cache is returned by
this client and no scans, provider queries or extraction fallbacks are performed.
Wanted counts do not establish eligibility for any particular configured target language.

## SDK compatibility

Inspected installed `tsarr/dist/clients/bazarr.js` and generated declarations:
`BazarrClient.applySubtitleMods` forwards options to `patchSubtitles`, which passes
`query` to a serializer that iterates all supplied keys. The mock-only compatibility
tests verify PATCH, authentication and every query parameter for movie and episode
translation, including extra `subtitles_id` and omitted `path`.

The current [official subtitles endpoint](https://github.com/morpheus65535/bazarr/blob/master/bazarr/api/subtitles/subtitles.py)
accepts embedded translation via `action=translate`, `language`, `type`, media `id`
and subtitle database `subtitles_id`. This is the database subtitle ID, not the
embedded stream/track number. Tsarr declarations omit `subtitles_id` and still
require `path`; JavaScript runtime serialization preserves the actual fields.
No live translation has been attempted. Installed Bazarr versions may differ.

`getSubtitles({ query: { subtitlesPath, radarrMovieId } })` (or `sonarrEpisodeId`)
returns audio, embedded and external track references. The official
[video analyzer](https://github.com/morpheus65535/bazarr/blob/master/bazarr/utilities/video_analyzer.py)
can probe media and update its cache when cached metadata is missing; there is no
cache-only query option. Inspection does not invoke
it or any scan/provider operation; indexed subtitles are preserved from library
records. Generation eligibility is described below; inspection does not filter its counts.

## Phase 4B generation contracts and limitations

- [Language catalog](https://github.com/morpheus65535/bazarr/blob/master/bazarr/api/system/languages.py): GET `/api/system/languages` returns a bare array of `code2`/`code3`/`name` records. Exact server codes take precedence over ICU ISO aliases; custom variants are not collapsed.
- [Indexed subtitle model](https://github.com/morpheus65535/bazarr/blob/master/bazarr/api/swaggerui.py) and [database mapping](https://github.com/morpheus65535/bazarr/blob/master/bazarr/app/database.py): subtitle database `id` and `embedded_track_id` differ; the library model exposes no embedded codec. Generation preserves unknown embedded codecs and valid database IDs; known bitmap sources are excluded without probing.
- [Postprocessing](https://github.com/morpheus65535/bazarr/blob/master/bazarr/api/utils.py) can hide embedded languages outside desired profile languages. The generator reads GET `/api/system/settings`; unfiltered visibility or a verified assigned language profile establishes per-media source/target visibility. Profile missing-subtitle lists do not authorize target absence.
- [Translation source resolution](https://github.com/morpheus65535/bazarr/blob/master/bazarr/subtitles/tools/translate/core/translator_utils.py): external sources use their exact `path`; embedded sources use database `subtitles_id`. Supported external text extensions are `.srt`, `.ass`, `.ssa`, `.vtt`. No translation call is made in Phase 4B.
- Installed Tsarr 2.16.3 provides Radarr `getMovies()` and Sonarr `getEpisodes(seriesId)` / `getEpisodeFiles(seriesId)`. [Radarr current file resources](https://github.com/Radarr/Radarr/blob/develop/src/Radarr.Api.V3/MovieFiles/MovieFileResource.cs) expose `movieId`, `id`, `dateAdded`; [Sonarr current file resources](https://github.com/Sonarr/Sonarr/blob/develop/src/Sonarr.Api.V3/EpisodeFiles/EpisodeFileResource.cs) expose `seriesId`, `id`, `dateAdded`, joined from episode `episodeFileId`.

These contracts were checked against official source and the installed SDK. Tests
use mocked HTTP transports and do not establish live generator/translation behavior.

## Generator review: embedded IDs and complete indexed visibility

The official [settings GET](https://github.com/morpheus65535/bazarr/blob/master/bazarr/api/system/settings.py)
returns settings without changing them. [Postprocessing](https://github.com/morpheus65535/bazarr/blob/master/bazarr/api/utils.py)
filters embedded languages only when `general.embedded_subs_show_desired` is true.
Generation reads this setting before and after an instance's collection. When it
is false, indexed languages are unfiltered. When true, the generator retrieves
[language profiles](https://github.com/morpheus65535/bazarr/blob/master/bazarr/api/system/languages_profiles.py)
with Tsarr `getLanguageProfiles()` once per instance. The response is a bare array;
[database mapping](https://github.com/morpheus65535/bazarr/blob/master/bazarr/app/database.py)
decodes `items` to objects and `get_desired_languages()` reads each item's `language`.

Visibility is then checked per movie's `profileId` or episode's parent series
`profileId`. Both configured languages must explicitly resolve to languages in that
profile. Kind/cutoff flags do not narrow the upstream display-language filter.
Missing/unknown/insufficient profiles remain uncertain; visible target subtitles
remain definite skips. `missing_subtitles` is never visibility evidence. Profile IDs
and language resolution remain scoped to the current instance. A profile lookup
failure does not become an empty authoritative profile list.

The global setting is rechecked before publication, while profiles are retrieved
only once. This is an indexed run-local snapshot, not a disk scan or an atomic view
across simultaneous library/profile/settings changes. Future submission must
revalidate. No additional setting or profile changes are sent to Bazarr.

Settings are hidden from Swagger, hence absent from Tsarr 2.16.3's named Bazarr API.
The adapter uses public `createServarrClient` from `tsarr` and its `getFetch()` /
`getHeaders()` for the single official GET, then discards every setting except the
visibility flag. Native JSON decoding is limited to that operation; no independent
HTTP client, retry policy or private SDK access is introduced. Settings may contain
credentials; raw settings and transport failures never escape into diagnostics/YAML.

[Embedded translation](https://github.com/morpheus65535/bazarr/blob/master/bazarr/api/subtitles/subtitles.py)
uses `subtitles_id`, while the resolver checks its `embedded_track_id` separately.
The server handles extraction; 415 is an unsupported image-based response documented
by the route. Unknown embedded codecs remain eligible as unknown, not as verified
text. No translation/extraction/probing is performed by generation. Existing mocked
Tsarr tests verify PATCH query preservation; this is not proof of a particular
installed server's translation behavior. The target version is intentionally not
assumed; live compatibility will be verified separately.

Manual action is not required when the assigned profile confirms both configured
languages, even with **Show Only Desired Languages** enabled. An unresolved profile
may be corrected manually, or the display filter can optionally be disabled. The
application never changes either, performs a rescan or triggers a provider search.

## Phase 5 submission and cleanup

Installed Tsarr 2.16.3 `applySubtitleMods(options)` forwards `query` to generated
`patchSubtitles`; JavaScript preserves `subtitles_id`. The client sets zero retries
and accepts only HTTP 204. Embedded selection uses the database ID; external
selection uses the exact verified subtitle path. `hi`/`forced` are string booleans
as parsed by the official route, and the target is resolved to the instance's
Bazarr code. No unsupported user fields are forwarded.

Fresh read-only revalidation uses SDK `getMovies([id])`, `getSeries([id])`, filtered
`getEpisodes(undefined, [id])`, settings and language profiles. Existing profile
visibility, language resolution and eligibility are reused. There are no provider,
probe, scan, synchronization or job-status calls.

The official [translation implementation](https://github.com/morpheus65535/bazarr/blob/master/bazarr/subtitles/tools/translate/main.py)
queues translation/extraction work when called without a job ID. The requester waits
only for the HTTP response, removes the entry after HTTP 204 and never checks later
job completion. Queued failures after acceptance are therefore outside this app's
scope. An immediate HTTP 415 remains in YAML; network/timeouts, 5xx and unexpected
2xx retain entries with an uncertainty warning. Mocked tests prove client behavior,
not live compatibility with the target installation.

Cleanup uses an exclusive lock and atomic file replacement per accepted entry.
This is not a transaction with the remote API: a process crash, lost response or
cleanup failure can require manual verification before retrying. No permanent
history, retry counters or status fields are added to the batch.
