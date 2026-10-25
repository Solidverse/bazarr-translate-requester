import { STATUS_CODES } from 'node:http';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = (value) => Number.isSafeInteger(value) && value > 0;
const PAGE_SIZE = 100;
const safeCodes = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);

export function createBazarrClient(instance, { fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) {
  let base;
  try {
    base = new URL(instance.url);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash
      || typeof instance.apiKey !== 'string' || !instance.apiKey.trim() || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error();
    base.pathname = `${base.pathname.replace(/\/+$/, '')}/api/`;
  } catch { throw new Error('Invalid Bazarr client connection settings.'); }
  const key = instance.apiKey;
  const name = typeof instance.name === 'string' ? instance.name.replaceAll(key, '[REDACTED]') : 'Bazarr';
  function fail(operation, code, httpStatus) {
    const description = httpStatus ? `HTTP ${httpStatus} ${STATUS_CODES[httpStatus] ?? ''}` : code;
    throw Object.assign(new Error(`[${name}] GET /api/${operation} failed: ${description}.`), {
      instance: name, operation: `GET /api/${operation}`, code, ...(httpStatus ? { httpStatus } : {}),
    });
  }
  // Private and allowlisted: there is deliberately no arbitrary request API.
  async function get(operation, params = []) {
    if (!['system/status', 'movies', 'series', 'episodes', 'movies/wanted', 'episodes/wanted'].includes(operation)) fail('metadata', 'UNSUPPORTED_OPERATION');
    const url = new URL(operation, base);
    url.search = new URLSearchParams(params).toString();
    const signal = AbortSignal.timeout(timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal, headers: { 'X-API-KEY': key, Accept: 'application/json' } });
    } catch (error) {
      const code = error?.cause?.code ?? error?.code;
      fail(operation, signal.aborted || ['TimeoutError', 'AbortError'].includes(error?.name) ? 'TIMEOUT' : safeCodes.has(code) ? code : 'NETWORK_ERROR');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      fail(operation, 'HTTP_ERROR', response.status);
    }
    try { return await response.json(); } catch (error) {
      fail(operation, signal.aborted || ['TimeoutError', 'AbortError'].includes(error?.name) ? 'TIMEOUT' : error instanceof SyntaxError ? 'INVALID_JSON' : 'NETWORK_ERROR');
    }
  }
  function validateItems(data, operation, idField, titleField = 'title') {
    if (!Array.isArray(data) || data.some((item) => !object(item) || !validId(item[idField]) || typeof item[titleField] !== 'string')) fail(operation, 'INVALID_RESPONSE');
    return data;
  }
  async function paged(operation, idField, titleField) {
    const items = [];
    const seen = new Set();
    let total;
    while (true) {
      const page = await get(operation, [['start', String(items.length)], ['length', String(PAGE_SIZE)]]);
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
      const response = await get('system/status');
      if (!object(response?.data) || typeof response.data.bazarr_version !== 'string' || !response.data.bazarr_version.trim()) fail('system/status', 'INVALID_RESPONSE');
      return response.data;
    },
    getMovies: () => paged('movies', 'radarrId'),
    getSeries: () => paged('series', 'sonarrSeriesId'),
    getWantedMovies: () => paged('movies/wanted', 'radarrId'),
    getWantedEpisodes: () => paged('episodes/wanted', 'sonarrEpisodeId', 'episodeTitle'),
    async getEpisodes({ seriesIds, episodeIds } = {}) {
      if ((seriesIds === undefined) === (episodeIds === undefined)) fail('episodes', 'SERIES_OR_EPISODE_IDS_REQUIRED');
      const ids = seriesIds ?? episodeIds;
      if (!Array.isArray(ids) || !ids.every(validId)) fail('episodes', 'INVALID_IDS');
      const unique = [...new Set(ids)];
      const items = [];
      const seen = new Set();
      // Episodes has no paging arguments upstream; use bounded ID batches.
      for (let start = 0; start < unique.length; start += 50) {
        const response = await get('episodes', unique.slice(start, start + 50).map((id) => [seriesIds !== undefined ? 'seriesid[]' : 'episodeid[]', String(id)]));
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
  const operations = ['system/status', 'movies', 'series', 'episodes', 'movies/wanted', 'episodes/wanted'].map((path) => `GET /api/${path}`);
  const operation = operations.includes(error?.operation) ? error.operation : 'Bazarr read';
  if (Number.isInteger(error?.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599) {
    return `${operation}: HTTP ${error.httpStatus} ${STATUS_CODES[error.httpStatus] ?? ''}`.trim();
  }
  const codes = [...safeCodes, 'TIMEOUT', 'INVALID_JSON', 'INVALID_RESPONSE', 'NETWORK_ERROR', 'COLLECTION_CHANGED', 'INCOMPLETE_PAGINATION', 'REPEATED_PAGINATION_ITEM', 'INVALID_IDS', 'REPEATED_EPISODE', 'UNEXPECTED_MEDIA_ID', 'SERIES_OR_EPISODE_IDS_REQUIRED'];
  return `${operation}: ${codes.includes(error?.code) ? error.code : 'connection, configuration or response error'}`;
}
