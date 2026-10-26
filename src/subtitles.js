// Resolve only identifiers, never filenames or human language names. Bazarr's
// catalog keeps its custom regional codes separate; ICU supplies ISO aliases.
export const languageCode = (value) => typeof value === 'string' && /^[a-z]{2,3}$/i.test(value);
function isoAlias(value) {
  try { const code = Intl.getCanonicalLocales(value)[0]; return languageCode(code) ? code : null; } catch { return null; }
}
export function languageResolver(catalog) {
  if (!Array.isArray(catalog)) throw new Error('Invalid Bazarr language catalog.');
  const codes = new Map();
  for (const item of catalog) {
    if (!languageCode(item?.code2) || item.code2.length !== 2 || !languageCode(item.code3) || item.code3.length !== 3) throw new Error('Invalid Bazarr language catalog.');
    const identity = item.code2.toLowerCase();
    for (const code of [identity, item.code3.toLowerCase()]) {
      if (codes.has(code) && codes.get(code) !== identity) throw new Error('Ambiguous Bazarr language catalog.');
      codes.set(code, identity);
    }
  }
  return (value) => {
    if (!languageCode(value)) return null;
    const code = value.toLowerCase();
    // An exact Bazarr code wins. Never discard region/script suffixes.
    return codes.get(code) ?? codes.get(isoAlias(code)) ?? null;
  };
}
export function subtitleLanguage(track, resolve) {
  if (!track || typeof track !== 'object') return null;
  const values = [track.code2, track.code3].filter((value) => value != null && value !== '');
  const codes = values.map(resolve);
  return codes.length && codes.every((code) => code && code === codes[0]) ? codes[0] : null;
}
export const validSubtitleId = (id) => (Number.isSafeInteger(id) && id > 0) || (typeof id === 'string' && /^[1-9]\d*$/.test(id));
const priority = (track) => (track.source === 'embedded' ? 0 : 2) + Number(track.hi);
function numericId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  return null;
}
function compareIds(a, b) {
  const left = numericId(a), right = numericId(b);
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  return left < right ? -1 : left > right ? 1 : 0;
}
const tieKey = (track) => JSON.stringify([typeof track.id, track.id, track.path ?? '',
  typeof track.embedded_track_id, track.embedded_track_id ?? null, track.language ?? '', track.codec ?? '', track.format ?? '']);
export function prioritizeTracks(tracks) {
  // Embedded ties follow actual stream order; DB IDs are a separate fallback.
  // BigInt comparisons preserve numeric-string ordering without precision loss.
  return [...tracks].sort((a, b) => priority(a) - priority(b)
    || (a.source === 'embedded' ? compareIds(a.embedded_track_id, b.embedded_track_id) : 0)
    || compareIds(a.id, b.id)
    || (tieKey(a) < tieKey(b) ? -1 : tieKey(a) > tieKey(b) ? 1 : 0));
}

export function profileLanguageVisibility(profileId, profiles, translation, resolve) {
  if (!Number.isSafeInteger(profileId) || profileId <= 0) return { visible: false, reason: 'missing or invalid assigned profileId' };
  if (!(profiles instanceof Map)) return { visible: false, reason: 'language profiles unavailable' };
  const profile = profiles.get(profileId);
  if (!profile) return { visible: false, reason: 'assigned profile not found' };
  if (!Array.isArray(profile.items)) return { visible: false, reason: 'invalid profile items' };
  // Upstream get_desired_languages() uses every item's language, independent
  // of forced/HI/cutoff flags. Do not infer extra languages through aliases or
  // language-equals rules beyond the existing language resolver.
  const languages = new Set(profile.items.map((item) => resolve(item?.language)).filter(Boolean));
  const source = resolve(translation.sourceLanguage), target = resolve(translation.targetLanguage);
  if (!source || !languages.has(source)) return { visible: false, reason: 'source language not confirmed in assigned profile' };
  if (!target || !languages.has(target)) return { visible: false, reason: 'target language not confirmed in assigned profile' };
  return { visible: true, reason: 'assigned profile confirms source and target visibility' };
}

export function evaluateSubtitles(media, translation, resolve, { languagesVisible = false } = {}) {
  const source = resolve(translation.sourceLanguage);
  const target = resolve(translation.targetLanguage);
  if (!source || !target || source === target) throw new Error('Unsupported or identical translation languages for this Bazarr instance.');
  if (!Array.isArray(media.subtitles)) return { reason: 'uncertain' };
  const languages = media.subtitles.map((track) => subtitleLanguage(track, resolve));
  // Target presence wins regardless of forced/HI, location or subtitle format.
  if (languages.includes(target)) return { reason: 'target' };
  if (languages.some((code) => !code)) return { reason: 'uncertain' };
  // The caller must establish source/target visibility for this media item.
  // A profile-based missing_subtitles entry alone does not establish visibility.
  if (languagesVisible !== true) return { reason: 'uncertain' };
  const tracks = [];
  let unsupported = false;
  const ids = new Set();
  for (let index = 0; index < media.subtitles.length; index++) {
    if (languages[index] !== source) continue;
    const raw = media.subtitles[index];
    if (raw.forced === true) continue;
    // Some versions/extensions may supply codec metadata. Unknown is allowed;
    // explicit bitmap information always excludes a source, even with a text path.
    const codecs = [raw.codec, raw.format].filter((value) => typeof value === 'string')
      .map((value) => value.toLowerCase().replace(/[^a-z0-9]/g, ''));
    if (codecs.some((value) => ['pgs', 'hdmvpgs', 'shdmvpgs', 'hdmvpgssubtitle', 'vobsub', 'svobsub', 'dvdsubtitle', 'dvbsubtitle', 'dvdsub', 'dvbsub', 'xsub', 'sup', 'idx'].includes(value))) { unsupported = true; continue; }
    if (raw.forced !== false || typeof raw.hi !== 'boolean' || !validSubtitleId(raw.id)) { unsupported = true; continue; }
    const idKey = String(raw.id);
    if (ids.has(idKey)) return { reason: 'uncertain' };
    ids.add(idKey);
    const embedded = raw.path === null && Number.isSafeInteger(raw.embedded_track_id) && raw.embedded_track_id >= 0;
    const external = typeof raw.path === 'string' && raw.path.length > 0 && raw.embedded_track_id == null;
    if (embedded) {
      const knownTextCodec = codecs.find((value) => ['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'movtext', 'text'].includes(value));
      tracks.push({ id: raw.id, source: 'embedded', language: source, hi: raw.hi, forced: false,
        codec: knownTextCodec ?? 'unknown', embedded_track_id: raw.embedded_track_id });
      continue;
    }
    if (!external) { unsupported = true; continue; }
    if (translation.onlyEmbedded ?? true) continue;
    const extension = /\.([a-z0-9]+)$/i.exec(raw.path)?.[1].toLowerCase();
    if (!['srt', 'ass', 'ssa', 'vtt'].includes(extension)
      || /[\p{Cc}]/u.test(raw.path) || /^[a-z]+:\/\//i.test(raw.path)) { unsupported = true; continue; }
    tracks.push({ id: raw.id, source: 'external', language: source, hi: raw.hi, forced: false, format: extension, path: raw.path });
  }
  if (!tracks.length) return { reason: unsupported ? 'unsupported' : 'noSource' };
  const ordered = prioritizeTracks(tracks);
  return { reason: 'candidate', tracks: ordered, selectedSubtitleId: ordered[0].id, unsupportedTracks: unsupported };
}
