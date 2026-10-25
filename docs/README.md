# Official Bazarr API reference

Bazarr uses Flask-RESTX to generate **Swagger 2.0 dynamically**. The official
upstream repository does not publish a static Bazarr Swagger/OpenAPI JSON/YAML
specification. Its `jellyfin-openapi.json` test fixture describes Jellyfin, not Bazarr.
No API specification is fabricated or downloaded from a running local instance.

`npm run update:bazarr-openapi` reports this limitation and performs no network
requests, configuration loading or documentation writes. If upstream publishes a
static specification later, use the reference project's validated, atomic download
design. Runtime API communication remains separate from documentation management.

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
