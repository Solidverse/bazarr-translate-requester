import { RadarrClient } from 'tsarr/radarr';
import { SonarrClient } from 'tsarr/sonarr';
import { describeStatusError } from './services.js';

const idValid = (id) => Number.isSafeInteger(id) && id > 0;
async function readList(operation, execute) {
  try {
    const result = await execute();
    if (result?.response && !result.response.ok) throw { httpStatus: result.response.status };
    if (result?.error !== undefined) throw result.error;
    if (!result?.response?.ok || !Array.isArray(result.data) || result.data.some((row) => !idValid(row?.id))
      || new Set(result.data.map((row) => row.id)).size !== result.data.length) throw { code: 'INVALID_RESPONSE' };
    return result.data;
  } catch (error) { throw new Error(`${operation} failed (${describeStatusError(error)}); no batch written.`); }
}
function importTime(value) {
  if (typeof value !== 'string') return NaN;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return NaN;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() || hour > 23 || minute > 59 || second > 59) return NaN;
  return Date.parse(value);
}
export function fileAgeOutcome(dateAdded, minAge, referenceTime) {
  const imported = importTime(dateAdded);
  if (!Number.isFinite(imported) || imported > referenceTime) return 'unknownAge';
  return referenceTime - imported >= minAge * 86_400_000 ? 'candidate' : 'recent';
}

export function createAgeFilter(instance, { minAge, referenceTime,
  radarrFactory = (options) => new RadarrClient(options),
  sonarrFactory = (options) => new SonarrClient(options),
} = {}) {
  let movies;
  let radarr;
  let sonarr;
  const series = new Map();
  const options = (connection) => ({ baseUrl: connection.url.replace(/\/+$/, ''), apiKey: connection.apiKey });
  return async (request) => {
    if (request.type === 'movie') {
      radarr ??= radarrFactory(options(instance.radarr));
      movies ??= new Map((await readList('Radarr GET /api/v3/movie', () => radarr.getMovies())).map((movie) => [movie.id, movie]));
      const movie = movies.get(request.mediaId);
      const file = movie?.movieFile;
      if (movie?.hasFile !== true || !idValid(file?.id) || file.movieId !== request.mediaId
        || (movie.movieFileId !== undefined && movie.movieFileId !== file.id)) return 'unknownAge';
      return fileAgeOutcome(file.dateAdded, minAge, referenceTime);
    }
    sonarr ??= sonarrFactory(options(instance.sonarr));
    if (!series.has(request.seriesId)) {
      const episodes = await readList('Sonarr GET /api/v3/episode', () => sonarr.getEpisodes(request.seriesId));
      const files = await readList('Sonarr GET /api/v3/episodefile', () => sonarr.getEpisodeFiles(request.seriesId));
      series.set(request.seriesId, { episodes: new Map(episodes.map((e) => [e.id, e])), files: new Map(files.map((f) => [f.id, f])) });
    }
    const snapshot = series.get(request.seriesId);
    const episode = snapshot.episodes.get(request.mediaId);
    const file = snapshot.files.get(episode?.episodeFileId);
    if (episode?.seriesId !== request.seriesId || episode.hasFile !== true || !idValid(episode.episodeFileId)
      || file?.seriesId !== request.seriesId) return 'unknownAge';
    return fileAgeOutcome(file.dateAdded, minAge, referenceTime);
  };
}
