import { STATUS_CODES } from 'node:http';
import { BazarrClient } from 'tsarr/bazarr';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = (value) => Number.isSafeInteger(value) && value > 0;
const PAGE_SIZE = 100;
const safeCodes = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);

export function createBazarrClient(instance, { timeoutMs = 30_000 } = {}) {
  let base;
  try {
    base = new URL(instance.url);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash
      || typeof instance.apiKey !== 'string' || !instance.apiKey.trim() || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error();
  } catch { throw new Error('Invalid Bazarr client connection settings.'); }
  const sdk = new BazarrClient({ baseUrl: base.href.replace(/\/+$/, ''), apiKey: instance.apiKey, timeout: timeoutMs });
  const key = instance.apiKey;
  const name = typeof instance.name === 'string' ? instance.name.replaceAll(key, '[REDACTED]') : 'Bazarr';
  function fail(operation, code, httpStatus) {
    const description = httpStatus ? `HTTP ${httpStatus} ${STATUS_CODES[httpStatus] ?? ''}` : code;
    throw Object.assign(new Error(`[${name}] GET /api/${operation} failed: ${description}.`), {
      instance: name, operation: `GET /api/${operation}`, code, ...(httpStatus ? { httpStatus } : {}),
    });
  }
  // Only named read operations are exposed. Tsarr owns transport, auth and timeout.
  async function read(operation, execute) {
    let result;
    try { result = await execute(); } catch (error) { transportFailure(operation, error); }
    if (result?.response && !result.response.ok) fail(operation, 'HTTP_ERROR', result.response.status);
    if (result?.error !== undefined) transportFailure(operation, result.error);
    if (!result?.response?.ok || result.data === undefined) fail(operation, 'INVALID_RESPONSE');
    return result.data;
  }
  function transportFailure(operation, error) {
    const code = error?.cause?.code ?? error?.code;
    // Tsarr maps its own timeout to ConnectionError without a timeout code.
    const timeout = ['TimeoutError', 'AbortError'].includes(error?.name)
      || (code === 'CONNECTION_ERROR' && /^Request timed out after \d+ms$/.test(error.message));
    fail(operation, timeout ? 'TIMEOUT' : safeCodes.has(code) ? code : error instanceof SyntaxError ? 'INVALID_JSON' : 'NETWORK_ERROR');
  }
  function validateItems(data, operation, idField, titleField = 'title') {
    if (!Array.isArray(data) || data.some((item) => !object(item) || !validId(item[idField]) || typeof item[titleField] !== 'string')) fail(operation, 'INVALID_RESPONSE');
    return data;
  }
  async function paged(operation, execute, idField, titleField) {
    const items = [];
    const seen = new Set();
    let total;
    while (true) {
      const page = await read(operation, () => execute(items.length, PAGE_SIZE));
      if (!object(page) || !Number.isSafeInteger(page.total) || page.total < 0) fail(operation, 'INVALID_RESPONSE');
      validateItems(page.data, operation, idField, titleField);
      if (total !== undefined && total !== page.total) fail(operation, 'COLLECTION_CHANGED');
      total = page.total;
      for (const item of page.data) {
        if (seen.has(item[idField])) fail(operation, 'REPEATED_PAGINATION_ITEM');
        seen.add(item[idField]);
        items.push(item);
      }
      if (items.length > total || (items.length < total && !page.data.length)) fail(operation, 'INCOMPLETE_PAGINATION');
      if (items.length === total) return items;
    }
  }
  return {
    async getStatus() {
      const response = await read('system/status', () => sdk.getSystemStatus());
      if (!object(response?.data) || typeof response.data.bazarr_version !== 'string' || !response.data.bazarr_version.trim()) fail('system/status', 'INVALID_RESPONSE');
      return response.data;
    },
    getMovies: () => paged('movies', (start, length) => sdk.getMovies(undefined, start, length), 'radarrId'),
    getSeries: () => paged('series', (start, length) => sdk.getSeries(undefined, start, length), 'sonarrSeriesId'),
    getWantedMovies: () => paged('movies/wanted', (start, length) => sdk.getMoviesWanted(start, length), 'radarrId'),
    getWantedEpisodes: () => paged('episodes/wanted', (start, length) => sdk.getEpisodesWanted(start, length), 'sonarrEpisodeId', 'episodeTitle'),
    // Explicit-only: upstream may probe/cache media on a cache miss. Not used by inspect.
    async getSubtitles({ subtitlesPath, radarrMovieId, sonarrEpisodeId } = {}) {
      if (typeof subtitlesPath !== 'string' || !subtitlesPath.trim()
        || (radarrMovieId === undefined) === (sonarrEpisodeId === undefined)
        || !validId(radarrMovieId ?? sonarrEpisodeId)) fail('subtitles', 'INVALID_IDS');
      const response = await read('subtitles', () => sdk.getSubtitles({ query: {
        subtitlesPath, ...(radarrMovieId !== undefined ? { radarrMovieId } : { sonarrEpisodeId }),
      } }));
      if (!object(response?.data) || ['audio_tracks', 'embedded_subtitles_tracks', 'external_subtitles_tracks']
        .some((field) => !Array.isArray(response.data[field]))) fail('subtitles', 'INVALID_RESPONSE');
      return response.data;
    },
    async getEpisodes({ seriesIds, episodeIds } = {}) {
      if ((seriesIds === undefined) === (episodeIds === undefined)) fail('episodes', 'SERIES_OR_EPISODE_IDS_REQUIRED');
      const ids = seriesIds ?? episodeIds;
      if (!Array.isArray(ids) || !ids.every(validId)) fail('episodes', 'INVALID_IDS');
      const unique = [...new Set(ids)];
      const items = [];
      const seen = new Set();
      // Episodes has no paging arguments upstream; use bounded ID batches.
      for (let start = 0; start < unique.length; start += 50) {
        const response = await read('episodes', () => sdk.getEpisodes(seriesIds !== undefined ? unique.slice(start, start + 50) : undefined, episodeIds !== undefined ? unique.slice(start, start + 50) : undefined));
        const data = validateItems(response?.data, 'episodes', 'sonarrEpisodeId');
        for (const item of data) {
          if (!validId(item.sonarrSeriesId) || !Number.isInteger(item.season) || item.season < 0 || !Number.isInteger(item.episode) || item.episode < 0) fail('episodes', 'INVALID_RESPONSE');
          if (!(seriesIds !== undefined ? unique.includes(item.sonarrSeriesId) : unique.includes(item.sonarrEpisodeId))) fail('episodes', 'UNEXPECTED_MEDIA_ID');
          if (seen.has(item.sonarrEpisodeId)) fail('episodes', 'REPEATED_EPISODE');
          seen.add(item.sonarrEpisodeId); items.push(item);
        }
      }
      return items;
    },
  };
}

// Format only controlled structural metadata, never native exception messages.
export function describeBazarrError(error) {
  const operations = ['system/status', 'movies', 'series', 'episodes', 'movies/wanted', 'episodes/wanted', 'subtitles'].map((path) => `GET /api/${path}`);
  const operation = operations.includes(error?.operation) ? error.operation : 'Bazarr read';
  if (Number.isInteger(error?.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599) {
    return `${operation}: HTTP ${error.httpStatus} ${STATUS_CODES[error.httpStatus] ?? ''}`.trim();
  }
  const codes = [...safeCodes, 'TIMEOUT', 'INVALID_JSON', 'INVALID_RESPONSE', 'NETWORK_ERROR', 'COLLECTION_CHANGED', 'INCOMPLETE_PAGINATION', 'REPEATED_PAGINATION_ITEM', 'INVALID_IDS', 'REPEATED_EPISODE', 'UNEXPECTED_MEDIA_ID', 'SERIES_OR_EPISODE_IDS_REQUIRED'];
  return `${operation}: ${codes.includes(error?.code) ? error.code : 'connection, configuration or response error'}`;
}
