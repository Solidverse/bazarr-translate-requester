import { createBazarrClient, describeBazarrError } from './bazarr.js';

export async function inspectBazarr(config, { logger, clientFactory = createBazarrClient } = {}) {
  let failed = false;
  const summaries = [];
  for (const instance of config.bazarr) {
    if (!instance.enabled) { logger.info(`[${instance.name ?? 'Bazarr'}] Disabled. Skipping.`); continue; }
    const summary = { instance: instance.name };
    try {
      logger.info(`[${instance.name}] Connecting...`);
      const client = clientFactory(instance);
      await client.getStatus();
      logger.info(`[${instance.name}] Connected successfully.`);
      async function collection(label, operation) {
        try {
          const items = await operation(); summary[label] = items.length;
          logger.info(`[${instance.name}] ${label}: ${items.length}`);
          return items;
        } catch (error) {
          failed = true; summary[label] = null;
          logger.error(`[${instance.name}] ${label}: unavailable (${describeBazarrError(error)}; no search or fallback performed).`);
          return null;
        }
      }
      await collection('movies', () => client.getMovies());
      const series = await collection('series', () => client.getSeries());
      if (series) await collection('episodes', () => client.getEpisodes({ seriesIds: series.map((item) => item.sonarrSeriesId) }));
      else { summary.episodes = null; logger.warn(`[${instance.name}] episodes: unavailable without series identifiers.`); }
      await collection('wanted movies (all configured languages)', () => client.getWantedMovies());
      await collection('wanted episodes (all configured languages)', () => client.getWantedEpisodes());
    } catch (error) {
      failed = true;
      logger.error(`[${instance.name}] Inspection failed (${describeBazarrError(error)}). Counts unavailable.`);
    }
    summaries.push(summary);
  }
  logger.info(failed ? 'Inspection completed with unavailable data.' : 'Inspection completed.');
  return { failed, summaries };
}
