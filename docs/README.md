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
No inference about Dutch-only eligibility is made from the wanted lists.

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
records. No eligibility rules are implemented.
