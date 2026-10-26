import { dirname, join } from 'node:path';
import { createBazarrClient, describeBazarrError } from './bazarr.js';
import { languageResolver, evaluateSubtitles, profileLanguageVisibility } from './subtitles.js';
import { openRequestBatch } from './request-batch.js';

const identity = (entry) => `${entry.type}:${entry.mediaId}`;
async function read(operation, execute) {
  try { return await execute(); }
  catch (error) { throw new Error(`${operation} (${describeBazarrError(error)}).`); }
}
async function revalidate(entry, instance, context) {
  const { client, resolve } = context;
  const translation = instance.translation;
  const source = resolve(translation.sourceLanguage), target = resolve(translation.targetLanguage);
  if (!source || !target || source === target || resolve(entry.sourceLanguage) !== source || resolve(entry.targetLanguage) !== target) {
    return { reason: 'batch languages no longer match the current instance configuration' };
  }
  const recorded = entry.tracks.find((track) => String(track.id) === String(entry.selectedSubtitleId));
  if (resolve(recorded.language) !== source) return { reason: 'selected track language differs from the configured source' };
  const visibility = await read('Subtitle visibility lookup failed', () => client.getSubtitleVisibility());
  let media, parent;
  if (entry.type === 'movie') media = await read('Movie lookup failed', () => client.getMovie(entry.mediaId));
  else {
    const episodes = await read('Episode lookup failed', () => client.getEpisodes({ episodeIds: [entry.mediaId] }));
    if (!Array.isArray(episodes) || episodes.length > 1) throw new Error('Invalid filtered episode response.');
    media = episodes[0];
    if (media && (media.sonarrEpisodeId !== entry.mediaId || media.sonarrSeriesId !== entry.seriesId)) return { reason: 'episode identity or parent series changed' };
    parent = await read('Parent series lookup failed', () => client.getSeriesById(entry.seriesId));
    if (!parent || parent.sonarrSeriesId !== entry.seriesId) return { reason: 'parent series no longer exists' };
  }
  if (!media || (entry.type === 'movie' && media.radarrId !== entry.mediaId)) return { reason: 'media no longer exists in this instance' };
  let visible = { visible: visibility?.complete === true, reason: 'subtitle visibility setting is unknown' };
  if (!visible.visible && visibility?.showOnlyDesiredLanguages === true) {
    // Unlike a generator snapshot, each submission revalidates the current profile.
    const profiles = await read('Language profile lookup failed', () => client.getLanguageProfiles());
    visible = profileLanguageVisibility(entry.type === 'movie' ? media.profileId : parent.profileId,
      new Map(profiles.map((profile) => [profile.profileId, profile])), translation, resolve);
  }
  const evaluated = evaluateSubtitles(media, translation, resolve, { languagesVisible: visible.visible });
  if (evaluated.reason !== 'candidate') {
    const reason = { target: 'target-language subtitle already exists', uncertain: `subtitle metadata is uncertain (${visible.reason ?? 'language metadata'})`,
      noSource: 'no eligible source subtitle exists', unsupported: 'source subtitles are unsupported' }[evaluated.reason];
    return { reason: reason ?? 'subtitle validation failed' };
  }
  // The automatic default from evaluateSubtitles is intentionally ignored.
  const selected = evaluated.tracks.find((track) => String(track.id) === String(entry.selectedSubtitleId));
  if (!selected) return { reason: 'the manually selected subtitle is missing or no longer eligible; no substitute was selected' };
  if (recorded.source !== selected.source || recorded.hi !== selected.hi || recorded.forced !== selected.forced
    || (selected.source === 'external' && recorded.path !== selected.path)
    || (selected.source === 'embedded' && recorded.embedded_track_id !== undefined && recorded.embedded_track_id !== selected.embedded_track_id)) {
    return { reason: 'selected track metadata or association changed' };
  }
  const recordedEvaluation = evaluateSubtitles({ subtitles: [{ ...recorded, code2: recorded.language, code3: undefined,
    path: selected.source === 'embedded' ? null : recorded.path,
    embedded_track_id: selected.source === 'embedded' ? selected.embedded_track_id : null,
  }] }, translation, resolve, { languagesVisible: true });
  if (recordedEvaluation.reason !== 'candidate') return { reason: 'selected batch track is forced, unsupported or disallowed by onlyEmbedded' };
  const current = await read('Subtitle visibility recheck failed', () => client.getSubtitleVisibility());
  if (!(current?.complete === true || (visibility?.complete !== true && current?.showOnlyDesiredLanguages === true))) {
    return { reason: 'subtitle visibility changed or could not be confirmed' };
  }
  return { track: selected, targetLanguage: target };
}

export async function processRequests(config, options = {}, {
  logger, configPath = '/config/config.yml', bazarrFactory = createBazarrClient, batchFactory = openRequestBatch, signal,
} = {}) {
  if (typeof config?.dryRun !== 'boolean') throw new Error('dryRun must be a boolean.');
  if (options.max !== undefined && (!Number.isSafeInteger(options.max) || options.max < 1)) throw new Error('--max must be a positive integer.');
  const batch = await batchFactory(join(dirname(configPath), 'requests.yml'));
  const summary = { accepted: 0, skipped: 0, failed: 0, uncertain: 0, planned: 0, attempts: 0, remaining: batch.entries.length, interrupted: false };
  const contexts = new Map();
  let fatal = false;
  try {
    for (const entry of [...batch.entries]) {
      if (signal?.aborted) { summary.interrupted = true; break; }
      if (summary.attempts + summary.planned >= (options.max ?? Infinity)) break;
      await batch.assertUnchanged();
      const instance = config.instances.find((item) => item.name === entry.instance);
      if (!instance?.enabled) {
        summary.skipped++; logger.warn(`[${entry.instance}] ${identity(entry)} Skipped: instance is unknown or disabled; entry retained.`); continue;
      }
      let context, checked;
      try {
        if (!contexts.has(instance.name)) contexts.set(instance.name, (async () => {
          let client;
          try { client = bazarrFactory({ ...instance.bazarr, name: instance.name }); }
          catch { throw new Error('Bazarr client initialization failed.'); }
          const catalog = await read('Language catalog lookup failed', () => client.getLanguages());
          let resolve;
          try { resolve = languageResolver(catalog); } catch { throw new Error('Invalid Bazarr language catalog.'); }
          return { client, resolve };
        })());
        context = await contexts.get(instance.name);
        checked = await revalidate(entry, instance, context);
      } catch (error) {
        summary.failed++; logger.error(`[${instance.name}] ${identity(entry)} Validation failed: ${error.message} Entry retained.`); continue;
      }
      if (!checked.track) {
        summary.skipped++; logger.warn(`[${instance.name}] ${identity(entry)} Skipped: ${checked.reason}; entry retained.`); continue;
      }
      await batch.assertUnchanged();
      if (signal?.aborted) { summary.interrupted = true; break; }
      if (config.dryRun) {
        summary.planned++;
        logger.info(`[${instance.name}] DRY_RUN would request: ${entry.title}; subtitle ${entry.selectedSubtitleId}; ${entry.sourceLanguage} -> ${entry.targetLanguage}.`);
        continue;
      }
      summary.attempts++;
      logger.info(`[${instance.name}] Requesting: ${entry.title}`);
      try {
        const result = await context.client.submitTranslation({ mediaId: entry.mediaId, mediaType: entry.type,
          targetLanguage: checked.targetLanguage, track: checked.track }, { dryRun: false });
        if (result?.accepted !== true || result.httpStatus !== 204) throw Object.assign(new Error('Unconfirmed response.'), { uncertain: true, operation: 'PATCH /api/subtitles', code: 'UNCONFIRMED_RESPONSE' });
      } catch (error) {
        const detail = describeBazarrError({ operation: 'PATCH /api/subtitles', httpStatus: error?.httpStatus, code: error?.code });
        const uncertain = error?.uncertain ?? !(error?.httpStatus >= 400 && error.httpStatus < 500 && error.httpStatus !== 408);
        if (uncertain) {
          summary.uncertain++;
          logger.error(`[${instance.name}] ${identity(entry)} Outcome uncertain (${detail}); entry retained. Possible duplicate submission: verify Bazarr manually before retrying.`);
        } else {
          summary.failed++; logger.error(`[${instance.name}] ${identity(entry)} Failed (${detail}); entry retained.`);
        }
        continue;
      }
      summary.accepted++;
      logger.info(`[${instance.name}] Accepted: subtitle ${entry.selectedSubtitleId}`);
      try { await batch.removeAccepted(entry); }
      catch {
        logger.error(`[${instance.name}] CRITICAL: ${identity(entry)} subtitle ${entry.selectedSubtitleId} was accepted but batch cleanup failed. Stopping; verify manually before retrying to avoid duplicates.`);
        throw Object.assign(new Error('Accepted translation request could not be removed safely from the batch; execution stopped.'),
          { mediaId: entry.mediaId, selectedSubtitleId: entry.selectedSubtitleId, summary });
      }
      summary.remaining = batch.entries.length;
    }
    if (!config.dryRun && !batch.entries.length && !summary.accepted) await batch.deleteEmpty();
    summary.remaining = batch.entries.length;
    logger.info(`[REQUEST] Summary: ${JSON.stringify(summary)}`);
    return { ...summary, hasProblems: summary.skipped + summary.failed + summary.uncertain > 0 };
  } catch (error) { fatal = true; throw error; }
  finally {
    try { await batch.close(); }
    catch {
      logger.error('[REQUEST] Cannot release requester lock; verify .requests.lock after this process stops.');
      if (!fatal) throw new Error('Requester lock cleanup failed.');
    }
  }
}
