import { test } from 'node:test';
import assert from 'node:assert/strict';
import { languageResolver, evaluateSubtitles, prioritizeTracks } from '../src/subtitles.js';
const catalog = [ ['en','eng'], ['nl','nld'], ['es','spa'], ['de','deu'], ['fr','fra'], ['pt','por'], ['pb','pob'] ].map(([code2, code3]) => ({ code2, code3 }));
const resolve = languageResolver(catalog);
const raw = (extra = {}) => ({ id: 11, code2: 'en', code3: 'eng', hi: false, forced: false, path: '/movie/source.srt', embedded_track_id: null, ...extra });
const translation = { sourceLanguage: 'en', targetLanguage: 'nl', onlyEmbedded: false };
const media = (subtitles = [raw()], target = 'nl') => ({ subtitles, missing_subtitles: [{ code2: target }] });
const evaluate = (tracks, config = translation) => evaluateSubtitles(media(tracks, resolve(config.targetLanguage)), config, resolve, { languagesVisible: true });

for (const [sourceLanguage, targetLanguage, code3] of [['en','nl','eng'], ['es','de','spa'], ['fr','en','fra']]) {
  test(`uses configured language pair ${sourceLanguage} -> ${targetLanguage}`, () => {
    const result = evaluate([raw({ code2: sourceLanguage, code3 })], { sourceLanguage, targetLanguage, onlyEmbedded: false });
    assert.equal(result.reason, 'candidate'); assert.equal(result.tracks[0].language, sourceLanguage);
    assert.throws(() => evaluate([raw()], { sourceLanguage: 'xyz', targetLanguage, onlyEmbedded: false }), /Unsupported/);
  });
}

test('ISO aliases normalize; custom variants stay distinct; regions are never stripped', () => {
  for (const [value, expected] of [['ENG','en'], ['dut','nl'], ['ger','de'], ['fre','fr'], ['spa','es'], ['pob','pb'], ['por','pt']]) assert.equal(resolve(value), expected);
  assert.equal(resolve('pt-BR'), null); assert.equal(resolve('xyz'), null); assert.equal(resolve('English'), null);
  assert.notEqual(resolve('pb'), resolve('pt'));
  assert.throws(() => languageResolver([{ code2: 'en', code3: 'eng' }, { code2: 'es', code3: 'eng' }]), /Ambiguous/);
});
for (const [sourceLanguage, targetLanguage] of [['en','nl'], ['es','de'], ['fr','en']]) {
  for (const flags of [{ forced: true }, { hi: true }, { path: null, embedded_track_id: 2 }, { path: '/external.sup' }]) {
    test(`any ${targetLanguage} target blocks ${sourceLanguage} translation: ${JSON.stringify(flags)}`, () => {
      const target = raw({ code2: targetLanguage, code3: undefined, ...flags });
      const result = evaluate([target], { sourceLanguage, targetLanguage, onlyEmbedded: true });
      assert.equal(result.reason, 'target');
    });
  }
}
for (const value of [null, undefined, {}]) test(`missing subtitle collection is uncertain: ${JSON.stringify(value)}`, () => {
  assert.equal(evaluateSubtitles({ subtitles: value }, translation, resolve).reason, 'uncertain');
});
test('unknown visibility or conflicting languages remain uncertain; profile missing lists are not completeness evidence', () => {
  assert.equal(evaluateSubtitles({ subtitles: [raw()] }, translation, resolve).reason, 'uncertain');
  assert.equal(evaluate([raw({ code2: 'en', code3: 'deu' })]).reason, 'uncertain');
  assert.equal(evaluate([raw({ code2: null, code3: null, path: '/looks.nl.srt' })]).reason, 'uncertain');
  assert.equal(evaluateSubtitles({ subtitles: [raw()], missing_subtitles: [] }, translation, resolve).reason, 'uncertain');
});
for (const format of ['srt','ass','ssa','vtt']) test(`existing external ${format} is eligible, preserving DB ID type and exact path`, () => {
  const result = evaluate([raw({ id: '123', path: `/source.${format}` })]);
  assert.equal(result.reason, 'candidate'); assert.equal(result.selectedSubtitleId, '123'); assert.equal(result.tracks[0].format, format);
});
for (const extension of ['sup','idx','sub','pgs','unknown']) test(`unsupported or ambiguous source format ${extension} is excluded`, () => {
  assert.equal(evaluate([raw({ path: `/source.${extension}` })]).reason, 'unsupported');
});
test('forced source and external sources in embedded-only mode are excluded', () => {
  assert.equal(evaluate([raw({ forced: true })]).reason, 'noSource');
  assert.equal(evaluate([raw()], { ...translation, onlyEmbedded: true }).reason, 'noSource');
  assert.equal(evaluate([raw({ hi: true })]).reason, 'candidate');
});
test('excludeHI ignores only HI and forced targets and excludes HI sources', () => {
  const excluding = { ...translation, onlyEmbedded: true, excludeHI: true };
  const target = (flags) => raw({ code2: 'nl', code3: undefined, ...flags });
  assert.equal(evaluate([raw({ path: null, embedded_track_id: 1 }), target({ hi: false, forced: false })], excluding).reason, 'target');
  for (const existing of [target({ hi: true, forced: false }), target({ hi: false, forced: true }),
    target({ hi: true, forced: false }), target({ hi: false, forced: false })]) {
    const result = evaluate([raw({ path: null, embedded_track_id: 1 }), existing], excluding);
    assert.equal(result.reason, existing.hi === false && existing.forced === false ? 'target' : 'candidate');
  }
  assert.equal(evaluate([raw({ hi: true, path: null, embedded_track_id: 1 })], excluding).reason, 'noSource');
  assert.equal(evaluate([raw({ hi: true }), raw({ id: 12, hi: false, path: null, embedded_track_id: 2 })], excluding).selectedSubtitleId, 12);
  assert.equal(evaluate([raw({ hi: undefined, path: null, embedded_track_id: 1 })], excluding).reason, 'unsupported');
});
test('excludeHI keeps incomplete target flags uncertain, while default still blocks on any target', () => {
  const incomplete = raw({ code2: 'nl', code3: undefined, hi: undefined, forced: false });
  assert.equal(evaluate([incomplete], { ...translation, excludeHI: true }).reason, 'uncertain');
  assert.equal(evaluate([incomplete], translation).reason, 'target');
});
test('embedded stream ID is never substituted for missing or invalid DB IDs', () => {
  for (const id of [undefined, null, 0, -1, {}, 'invalid']) {
    assert.equal(evaluate([raw({ id, path: null, embedded_track_id: 5 })]).reason, 'unsupported');
  }
});
test('invalid flags, ambiguous source and duplicate subtitle identities fail conservatively', () => {
  for (const patch of [{ hi: null }, { forced: null }, { id: 0 }, { path: null }, { path: '/source.srt', embedded_track_id: 4 }]) assert.equal(evaluate([raw(patch)]).reason, 'unsupported');
  assert.equal(evaluate([raw(), raw({ id: '11', path: '/other.srt' })]).reason, 'uncertain');
});
test('normal external source wins over HI; all eligible sources are retained stably', () => {
  const tracks = [raw({ id: 22, hi: true }), raw({ id: '9', path: '/b.srt' }), raw({ id: 11 })];
  const a = evaluate(tracks), b = evaluate([...tracks].reverse());
  assert.deepEqual(a, b); assert.equal(a.tracks.length, 3); assert.equal(a.tracks[0].hi, false);
  assert.equal(a.tracks.filter((t) => t.id === a.selectedSubtitleId).length, 1);
});
test('priority algorithm supports all four source categories', () => {
  const eligible = [ { id: 40, source: 'external', hi: true }, { id: 30, source: 'external', hi: false },
    { id: 20, source: 'embedded', hi: true }, { id: 10, source: 'embedded', hi: false } ];
  assert.deepEqual(prioritizeTracks(eligible).map((t) => t.id), [10,20,30,40]);
  assert.deepEqual(prioritizeTracks([...eligible].reverse()), prioritizeTracks(eligible));
});


test('complete indexed subtitles establish target absence without any missing_subtitles entry', () => {
  for (const missing_subtitles of [undefined, [], [{ code2: 'de' }]]) {
    const result = evaluateSubtitles({ subtitles: [raw()], missing_subtitles }, translation, resolve, { languagesVisible: true });
    assert.equal(result.reason, 'candidate');
  }
  assert.equal(evaluateSubtitles(media(), translation, resolve, { languagesVisible: false }).reason, 'uncertain');
});

test('unknown embedded codec is eligible; DB and stream IDs remain distinct', () => {
  const result = evaluate([raw({ id: '22', path: null, embedded_track_id: 0 })], { ...translation, onlyEmbedded: true });
  assert.equal(result.reason, 'candidate'); assert.equal(result.selectedSubtitleId, '22');
  assert.deepEqual(result.tracks[0], { id: '22', source: 'embedded', language: 'en', hi: false, forced: false, codec: 'unknown', embedded_track_id: 0 });
});

for (const codec of ['PGS', 'HDMV PGS', 'hdmv_pgs_subtitle', 'S_HDMV/PGS', 'VobSub', 'dvd_subtitle', 'dvb_subtitle', 'XSub']) {
  test(`known bitmap ${codec} is excluded, regardless of external filename`, () => {
    for (const fields of [{ path: null, embedded_track_id: 1 }, { path: '/fake.srt' }]) {
      assert.equal(evaluate([raw({ codec, ...fields })]).reason, 'unsupported');
    }
  });
}

test('eligible embedded tracks win over external normal and HI, with stable ties and all tracks listed', () => {
  const tracks = [raw({ id: 10, hi: true }), raw({ id: 11 }),
    raw({ id: 12, path: null, embedded_track_id: 2, hi: true }),
    raw({ id: 13, path: null, embedded_track_id: 3 }), raw({ id: 14, path: null, embedded_track_id: 4 })];
  const result = evaluate(tracks);
  assert.deepEqual(result.tracks.map((track) => track.id), [13,14,12,11,10]);
  assert.equal(result.selectedSubtitleId, 13);
  assert.deepEqual(evaluate([...tracks].reverse()), result);
  assert.deepEqual(evaluate(tracks, { ...translation, onlyEmbedded: true }).tracks.map((t) => t.id), [13,14,12]);
});

for (const [sourceLanguage, targetLanguage] of [['en','nl'], ['es','de'], ['fr','en']]) {
  test(`embedded selection uses configured language ${sourceLanguage} -> ${targetLanguage}`, () => {
    const result = evaluate([raw({ id: 42, code2: sourceLanguage, code3: undefined, path: null, embedded_track_id: 7 })], { sourceLanguage, targetLanguage, onlyEmbedded: true });
    assert.equal(result.selectedSubtitleId, 42); assert.equal(result.tracks[0].language, sourceLanguage);
  });
}

test('forced embedded sources and explicitly known bitmap format stay excluded', () => {
  const embedded = { path: null, embedded_track_id: 3 };
  assert.equal(evaluate([raw({ ...embedded, forced: true })]).reason, 'noSource');
  assert.equal(evaluate([raw({ ...embedded, format: 'VobSub' })]).reason, 'unsupported');
});

test('profile visibility resolves configured ISO aliases and ignores subtitle-kind flags', async () => {
  const { profileLanguageVisibility } = await import('../src/subtitles.js');
  const profiles = new Map([[7, { items: [{ language: 'eng', forced: 'True', hi: 'True' }, { language: 'dut', forced: 'True' }] }]]);
  assert.equal(profileLanguageVisibility(7, profiles, { sourceLanguage: 'en', targetLanguage: 'nld' }, resolve).visible, true);
  for (const id of [null, undefined, 0, -1, '7', 999]) assert.equal(profileLanguageVisibility(id, profiles, translation, resolve).visible, false);
  assert.equal(profileLanguageVisibility(7, null, translation, resolve).reason, 'language profiles unavailable');
  assert.equal(profileLanguageVisibility(7, new Map([[7, { items: '[]' }]]), translation, resolve).reason, 'invalid profile items');
});

const embeddedTrack = (id, stream, hi = false) => ({ id, embedded_track_id: stream, source: 'embedded', hi });
const externalTrack = (id, path = '/source.srt', hi = false) => ({ id, path, source: 'external', hi });
function assertStableOrder(input, expected) {
  const before = structuredClone(input);
  for (const order of [input, [...input].reverse(), [...input.slice(1), input[0]]]) assert.deepEqual(prioritizeTracks(order), expected);
  assert.deepEqual(input, before, 'Sorting must not mutate the API array');
}

test('embedded ties follow numeric stream IDs rather than subtitle database IDs', () => {
  const tracks = [embeddedTrack(1, 10), embeddedTrack(99, 9), embeddedTrack(500, 0), embeddedTrack(2, 2)];
  assertStableOrder(tracks, [tracks[2], tracks[3], tracks[1], tracks[0]]);
});

test('mixed numeric and numeric-string stream IDs sort numerically', () => {
  const tracks = [embeddedTrack('1', '10'), embeddedTrack(2, 9), embeddedTrack('9', '2')];
  assertStableOrder(tracks, [tracks[2], tracks[1], tracks[0]]);
});

test('external ties sort numeric database IDs without converting the stored values', () => {
  const tracks = [externalTrack('10'), externalTrack(9), externalTrack('2'), externalTrack('9007199254740993'), externalTrack('9007199254740992')];
  assertStableOrder(tracks, [tracks[2], tracks[1], tracks[0], tracks[4], tracks[3]]);
});

test('equal or missing embedded streams fall back to numeric DB IDs and deterministic metadata', () => {
  const tracks = [embeddedTrack('10', 2), embeddedTrack(9, '2'), embeddedTrack('3', undefined), embeddedTrack(2, null), embeddedTrack(1, 'unknown')];
  assertStableOrder(tracks, [tracks[1], tracks[0], tracks[4], tracks[3], tracks[2]]);
});

test('equal or unavailable external DB IDs have deterministic path and type fallbacks', () => {
  const tracks = [externalTrack('9', '/b.srt'), externalTrack('9', '/a.srt'), externalTrack(9, '/c.srt'),
    externalTrack(undefined, '/b.srt'), externalTrack(undefined, '/a.srt')];
  assertStableOrder(tracks, [tracks[2], tracks[1], tracks[0], tracks[4], tracks[3]]);
});

test('source and HI priorities still outrank stream and database ID ordering', () => {
  const tracks = [externalTrack(1, '/a.srt', true), externalTrack('2'), embeddedTrack(3, 0, true), embeddedTrack('99', 100)];
  assertStableOrder(tracks, [tracks[3], tracks[2], tracks[1], tracks[0]]);
});

test('selection uses the first sorted database ID and retains every eligible track for manual review', () => {
  const tracks = [raw({ id: '10', path: null, embedded_track_id: 9 }),
    raw({ id: 900, path: null, embedded_track_id: 2 }), raw({ id: '9', path: null, embedded_track_id: 10 }), raw({ id: 1 })];
  const selected = evaluate(tracks);
  assert.equal(selected.selectedSubtitleId, 900);
  assert.deepEqual(selected.tracks.map((t) => t.id), [900, '10', '9', 1]);
  assert.equal(selected.tracks.filter((t) => t.id === selected.selectedSubtitleId).length, 1);
  assert.deepEqual(evaluate([...tracks].reverse()), selected);
  assert.equal(selected.tracks.length, tracks.length);
  assert.ok(selected.tracks.some((t) => t.id === '9'), 'Alternative DB IDs remain available for manual selection');
  const external = evaluate([raw({ id: '10' }), raw({ id: 9 })]);
  assert.equal(external.selectedSubtitleId, 9); assert.deepEqual(external.tracks.map((t) => t.id), [9, '10']);
});
