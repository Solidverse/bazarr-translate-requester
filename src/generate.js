import { dirname, join } from 'node:path';
import { createBazarrClient, describeBazarrError } from './bazarr.js';
import { languageResolver, evaluateSubtitles, profileLanguageVisibility } from './subtitles.js';
import { createAgeFilter } from './age.js';
import { ensureNoBatch, writeBatch } from './batch.js';

const validId = (id) => Number.isSafeInteger(id) && id > 0;
function uniqueMedia(items, field) {
  if (!Array.isArray(items)) throw new Error('Invalid library response; no batch written.');
  const seen = new Map();
  for (const item of items) {
    if (!validId(item?.[field])) throw new Error('Invalid library media identity; no batch written.');
    if (seen.has(item[field]) && JSON.stringify(seen.get(item[field])) !== JSON.stringify(item)) throw new Error('Conflicting duplicate media metadata; no batch written.');
    seen.set(item[field], item);
  }
  return [...seen.values()].sort((a, b) => a[field] - b[field]);
}
export async function generateRequests(config, options = {}, {
  logger, configPath = '/config/config.yml', bazarrFactory = createBazarrClient,
  radarrFactory, sonarrFactory, now = Date.now,
} = {}) {
  const referenceTime = now();
  if (!Number.isFinite(referenceTime)) throw new Error('Invalid generation reference time.');
  const outputPath = join(dirname(configPath), 'requests.yml');
  let instances = config.instances.filter((instance) => instance.enabled);
  if (options.instance !== undefined) {
    const selected = config.instances.find((instance) => instance.name === options.instance);
    if (!selected) throw new Error('Unknown instance; use a configured instance name.');
    if (!selected.enabled) throw new Error('Selected instance is disabled.');
    instances = [selected];
  }
  if (options.seriesId !== undefined && instances.length !== 1) throw new Error('--series requires exactly one enabled instance; specify --instance.');
  if (options.minAge !== undefined) {
    for (const instance of instances) {
      if (options.type !== 'series' && !instance.radarr) throw new Error(`[${instance.name}] --min-age for movies requires the associated Radarr connection.`);
      if (options.type !== 'movie' && !instance.sonarr) throw new Error(`[${instance.name}] --min-age for episodes requires the associated Sonarr connection.`);
    }
  }
  if (!options.preview) await ensureNoBatch(outputPath);
  const requests = [];
  const summaries = [];
  for (const instance of instances) {
    const summary = { instance: instance.name, movies: 0, episodes: 0, duplicates: 0,
      target: 0, noSource: 0, unsupported: 0, uncertain: 0, recent: 0, unknownAge: 0, candidates: 0 };
    const translation = instance.translation;
    logger.info(`[${instance.name}] Translation: ${translation.sourceLanguage} -> ${translation.targetLanguage}; source mode: ${(translation.onlyEmbedded ?? true) ? 'embedded only' : 'embedded or external'}.`);
    const client = bazarrFactory({ ...instance.bazarr, name: instance.name });
    async function read(operation, execute) {
      try { return await execute(); } catch (error) {
        throw new Error(`[${instance.name}] ${operation} failed (${describeBazarrError(error)}); no batch written.`);
      }
    }
    const catalog = await read('language catalog', () => client.getLanguages());
    let resolve;
    try { resolve = languageResolver(catalog); }
    catch { throw new Error(`[${instance.name}] Cannot validate the Bazarr language catalog; no batch written.`); }
    const source = resolve(translation.sourceLanguage), target = resolve(translation.targetLanguage);
    if (!source || !target || source === target) throw new Error(`[${instance.name}] Unsupported or identical configured translation languages; no batch written.`);
    let visibility = { complete: false, showOnlyDesiredLanguages: null };
    let profiles;
    try {
      visibility = await client.getSubtitleVisibility();
    } catch (error) {
      logger.warn(`[${instance.name}] Cannot establish subtitle visibility (${describeBazarrError(error)}). Target absence remains uncertain; no setting is changed.`);
    }
    if (visibility?.showOnlyDesiredLanguages === true && visibility.complete !== true) {
      try {
        const result = await client.getLanguageProfiles();
        profiles = new Map(result.map((profile) => [profile.profileId, profile]));
      } catch (error) {
        logger.warn(`[${instance.name}] Cannot retrieve language profiles (${describeBazarrError(error)}). Assigned profile visibility remains uncertain.`);
      }
    }
    const age = options.minAge === undefined ? null : createAgeFilter(instance, { minAge: options.minAge, referenceTime, radarrFactory, sonarrFactory });
    async function consider(media, type, series) {
      summary[type === 'movie' ? 'movies' : 'episodes']++;
      const mediaId = type === 'movie' ? media.radarrId : media.sonarrEpisodeId;
      if (typeof media.title !== 'string' || !media.title.trim() || typeof media.path !== 'string' || !media.path.trim()
        || (type === 'episode' && (media.sonarrSeriesId !== series.sonarrSeriesId || !Number.isInteger(media.season) || media.season < 0 || !Number.isInteger(media.episode) || media.episode < 0))) {
        summary.uncertain++; return;
      }
      const profileId = type === 'episode' ? series.profileId : media.profileId;
      const mediaVisibility = visibility?.complete === true ? { visible: true }
        : visibility?.showOnlyDesiredLanguages === true ? profileLanguageVisibility(profileId, profiles, translation, resolve)
          : { visible: false, reason: 'subtitle visibility setting is unknown' };
      const evaluated = evaluateSubtitles(media, translation, resolve, { languagesVisible: mediaVisibility.visible });
      if (evaluated.reason === 'uncertain' && !mediaVisibility.visible) {
        logger.debug(`[${instance.name}] ${type}:${mediaId} visibility unresolved (profileId=${validId(profileId) ? profileId : 'missing/invalid'}): ${mediaVisibility.reason}.`);
      }
      if (evaluated.reason !== 'candidate') {
        summary[evaluated.reason]++;
        logger.debug(`[${instance.name}] ${type}:${mediaId} excluded: ${evaluated.reason}.`);
        return;
      }
      const title = type === 'movie' ? `${media.title}${media.year ? ` (${media.year})` : ''}`
        : `${series.title} S${String(media.season).padStart(2, '0')}E${String(media.episode).padStart(2, '0')} — ${media.title}`;
      const request = { instance: instance.name, type, title, mediaId,
        ...(type === 'episode' ? { seriesId: series.sonarrSeriesId } : {}),
        sourceLanguage: translation.sourceLanguage, targetLanguage: translation.targetLanguage,
        selectedSubtitleId: evaluated.selectedSubtitleId, tracks: evaluated.tracks };
      if (age) {
        const outcome = await age(request);
        if (outcome !== 'candidate') { summary[outcome]++; logger.debug(`[${instance.name}] ${type}:${mediaId} excluded: ${outcome}.`); return; }
      }
      requests.push(request); summary.candidates++;
      if (options.preview) logger.info(`[PREVIEW] ${JSON.stringify({ instance: instance.name, type, title, sourceLanguage: request.sourceLanguage,
        targetLanguage: request.targetLanguage, selectedSubtitleId: request.selectedSubtitleId, eligibleTracks: request.tracks.length })}`);
    }
    if (options.type !== 'series') {
      const movies = await read('movie library', () => client.getMovies());
      const unique = uniqueMedia(movies, 'radarrId'); summary.duplicates += movies.length - unique.length;
      for (const movie of unique) await consider(movie, 'movie');
    }
    if (options.type !== 'movie') {
      let series = uniqueMedia(await read('series library', () => client.getSeries()), 'sonarrSeriesId');
      if (options.seriesId !== undefined) {
        series = series.filter((item) => item.sonarrSeriesId === options.seriesId);
        if (!series.length) throw new Error(`[${instance.name}] Selected series was not found in Bazarr; no batch written.`);
      }
      // One Bazarr call per bounded ID batch, never an unfiltered episode query.
      const episodes = await read('episode library', () => client.getEpisodes({ seriesIds: series.map((item) => item.sonarrSeriesId) }));
      const unique = uniqueMedia(episodes, 'sonarrEpisodeId'); summary.duplicates += episodes.length - unique.length;
      const parents = new Map(series.map((item) => [item.sonarrSeriesId, item]));
      for (const episode of unique) {
        const parent = parents.get(episode.sonarrSeriesId);
        if (!parent || typeof parent.title !== 'string') throw new Error(`[${instance.name}] Invalid episode-to-series association; no batch written.`);
        await consider(episode, 'episode', parent);
      }
    }
    if (visibility?.complete === true || visibility?.showOnlyDesiredLanguages === true) {
      // Detect a visibility change over the collection interval. This remains
      // an indexed view, not a disk scan or an atomic server-side snapshot.
      let visibilityConfirmed = false;
      try {
        const current = await client.getSubtitleVisibility();
        visibilityConfirmed = current?.complete === true
          || (visibility.complete !== true && current?.showOnlyDesiredLanguages === true);
      } catch (error) {
        throw new Error(`[${instance.name}] Subtitle visibility recheck failed (${describeBazarrError(error)}); no batch written.`);
      }
      if (!visibilityConfirmed) throw new Error(`[${instance.name}] Subtitle visibility changed or could not be rechecked; no batch written.`);
    }
    logger.info(`[${instance.name}] ${JSON.stringify(summary)}`);
    if (summary.uncertain || summary.unsupported) logger.warn(`[${instance.name}] Excluded uncertain subtitle metadata or unsupported tracks. Unknown embedded codecs are preserved; missing IDs, known bitmap sources or incomplete subtitle visibility can exclude items.`);
    if (summary.unknownAge) logger.warn(`[${instance.name}] Excluded ${summary.unknownAge} items with an unverified current-file import date.`);
    summaries.push(summary);
  }
  if (!options.preview && requests.length) await writeBatch(outputPath, requests);
  logger.info(`${options.preview ? 'Preview' : requests.length ? 'Generated requests.yml' : 'No eligible candidates; no batch created'}: ${requests.length} candidates.`);
  return { requests, summaries, outputPath, written: !options.preview && requests.length > 0, preview: !!options.preview };
}
