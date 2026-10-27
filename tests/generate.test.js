import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import { generateRequests } from '../src/generate.js';
import { createBazarrClient } from '../src/bazarr.js';
import { parseGenerateArgs } from '../src/generate-options.js';

const catalog = [['en','eng'],['nl','nld'],['es','spa'],['de','deu'],['fr','fra']].map(([code2,code3]) => ({ code2,code3 }));
const environment = (name = 'Main', sourceLanguage = 'en', targetLanguage = 'nl') => ({ name, enabled: true,
  bazarr: { url: 'http://bazarr.invalid', apiKey: 'TOP_SECRET' },
  translation: { sourceLanguage, targetLanguage, onlyEmbedded: false } });
const item = (id, source = 'en', target = 'nl', extra = {}) => ({ radarrId: id, title: 'Movie', year: '2025', path: '/movie.mkv',
  subtitles: [{ id: id + 100, code2: source, forced: false, hi: false, path: '/source.srt', embedded_track_id: null }],
  missing_subtitles: [{ code2: target }], ...extra });
const episode = (id, seriesId = 5, source = 'en', target = 'nl') => item(id, source, target, { sonarrEpisodeId: id, sonarrSeriesId: seriesId, title: 'Episode', season: 1, episode: id });
const series = { sonarrSeriesId: 5, title: 'Series' };
async function setup(t, instances = [environment()], data = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'bazarr-generate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [], lines = [];
  const logger = Object.fromEntries(['info','warn','error','debug'].map((level) => [level, (line) => lines.push(line)]));
  const dependencies = { configPath: join(directory, 'custom.yml'), logger, bazarrFactory: (connection) => {
    calls.push(['client', connection.name]);
    const current = data[connection.name] ?? {};
    return {
      getSubtitleVisibility: async () => ({ complete: current.complete ?? true, showOnlyDesiredLanguages: current.desiredOnly ?? null }),
      getLanguageProfiles: async () => { calls.push(['profiles', connection.name]); return current.profiles ?? []; },
      getLanguages: async () => { calls.push(['languages', connection.name]); return catalog; },
      getMovies: async () => { calls.push(['movies', connection.name]); if (current.fail) throw new Error('TOP_SECRET private response'); return current.movies ?? [item(1)]; },
      getSeries: async () => { calls.push(['series', connection.name]); return current.series ?? [series]; },
      getEpisodes: async ({ seriesIds }) => { calls.push(['episodes', seriesIds]); return (current.episodes ?? [episode(2)]).filter((e) => seriesIds.includes(e.sonarrSeriesId)); },
    };
  } };
  const config = { instances, dryRun: true, logging: { level: 'info' } };
  const run = (options = {}, extra = {}) => generateRequests(config, options, { ...dependencies, ...extra });
  return { run, config, calls, lines, directory, path: join(directory, 'requests.yml') };
}

test('default generation writes a valid, stable mixed YAML review batch without credentials', async (t) => {
  const fixture = await setup(t);
  const original = structuredClone(fixture.config);
  const result = await fixture.run();
  assert.equal(result.written, true); assert.equal(result.requests.length, 2);
  const yaml = await readFile(fixture.path, 'utf8');
  assert.deepEqual(parse(yaml), { requests: result.requests });
  assert.doesNotMatch(yaml, /TOP_SECRET|apiKey|status:|approved:|enabled:/);
  assert.equal(result.requests[1].seriesId, 5);
  for (const request of result.requests) {
    assert.equal(request.sourceLanguage, 'en'); assert.equal(request.targetLanguage, 'nl');
    assert.equal(request.tracks.some((track) => track.id === request.selectedSubtitleId), true);
  }
  assert.deepEqual(fixture.config, original);
  assert.deepEqual((await readdir(fixture.directory)), ['requests.yml']);
});

test('different instances independently preserve their configured language pairs and identical numeric media IDs', async (t) => {
  const instances = [environment('A','en','nl'), environment('B','es','de'), environment('C','fr','en')];
  const data = Object.fromEntries(instances.map((i) => [i.name, { movies: [item(1, i.translation.sourceLanguage, i.translation.targetLanguage)], series: [], episodes: [] }]));
  const fixture = await setup(t, instances, data);
  const result = await fixture.run({ type: 'movie' });
  assert.deepEqual(result.requests.map((r) => [r.instance,r.mediaId,r.sourceLanguage,r.targetLanguage]), [['A',1,'en','nl'],['B',1,'es','de'],['C',1,'fr','en']]);
});
for (const args of [['--type','movie'],['--type','series'],['--series','5'],['--instance','Main','--type','series','--series','5','--preview']]) {
  test(`CLI options constrain retrieval: ${args.join(' ')}`, async (t) => {
    const fixture = await setup(t); const options = parseGenerateArgs(args);
    const result = await fixture.run(options);
    assert.equal(result.requests.length, 1);
    if (options.type === 'movie') assert.ok(!fixture.calls.some(([op]) => ['series','episodes'].includes(op)));
    else { assert.ok(!fixture.calls.some(([op]) => op === 'movies')); assert.equal(result.requests[0].type, 'episode'); }
  });
}

test('disabled instances are not initialized; unknown, disabled and ambiguous selections fail before API calls', async (t) => {
  const fixture = await setup(t, [environment('A'), { name: 'Offline', enabled: false }, environment('B')]);
  for (const options of [{ instance: 'missing' }, { instance: 'Offline' }, { seriesId: 5, type: 'series' }]) await assert.rejects(fixture.run(options), /instance/i);
  assert.equal(fixture.calls.length, 0);
  const result = await fixture.run({ instance: 'A', type: 'movie', preview: true });
  assert.equal(result.requests.length, 1); assert.ok(fixture.calls.every((call) => !call.includes('Offline')));
});

test('duplicate media entries collapse; conflicting duplicates abort without output', async (t) => {
  const fixture = await setup(t, [environment()], { Main: { movies: [item(3), item(1), item(3)], series: [] } });
  const result = await fixture.run({ preview: true });
  assert.deepEqual(result.requests.map((r) => r.mediaId), [1,3]); assert.equal(result.summaries[0].duplicates, 1);
  await assert.rejects(fixture.run({ type: 'movie' }, { bazarrFactory: () => ({ getSubtitleVisibility: async () => ({ complete: true }), getLanguages: async () => catalog, getMovies: async () => [item(1), item(1,'en','nl',{ title: 'conflict' })] }) }), /Conflicting/);
  assert.deepEqual(await readdir(fixture.directory), []);
});

test('any failed library aborts the complete multi-instance batch and preserves the previous batch', async (t) => {
  const fixture = await setup(t, [environment('A'), environment('B')], { B: { fail: true } });
  const previous = 'requests: [previous]\n'; await writeFile(fixture.path, previous);
  await assert.rejects(fixture.run({ type: 'movie' }), (error) => /movie library failed/.test(error.message) && !/TOP_SECRET|private response/.test(error.message));
  assert.equal(await readFile(fixture.path, 'utf8'), previous);
  assert.deepEqual(await readdir(fixture.directory), ['requests.yml']);
});

test('uncertain, unsupported and already-target media are excluded with distinct statistics', async (t) => {
  const fixture = await setup(t, [environment()], { Main: { series: [], movies: [
    item(1,'en','nl',{ subtitles: null }),
    item(2,'en','nl',{ subtitles: [{ id: 3, code2: 'nl', forced: true }] }),
    item(3,'en','nl',{ subtitles: [{ id: 5, code2: 'en', forced: false, hi: false, path: null, embedded_track_id: 1, codec: 'pgs' }] }),
    item(4,'en','nl',{ subtitles: [] }),
  ] } });
  const result = await fixture.run();
  assert.equal(result.requests.length, 0); assert.equal(result.written, false);
  assert.deepEqual([result.summaries[0].uncertain,result.summaries[0].target,result.summaries[0].unsupported,result.summaries[0].noSource], [1,1,1,1]);
  assert.deepEqual(await readdir(fixture.directory), []); assert.match(fixture.lines.join(), /Unknown embedded codecs/);
});

test('successful generation replaces an existing batch completely; preview leaves it unchanged', async (t) => {
  const fixture = await setup(t);
  const existing = 'requests: [keep]\n'; await writeFile(fixture.path, existing);
  const preview = await fixture.run({ preview: true });
  assert.equal(preview.requests.length, 2); assert.equal(preview.written, false);
  assert.equal(await readFile(fixture.path, 'utf8'), existing);
  assert.match(fixture.lines.join(), /PREVIEW.*sourceLanguage.*selectedSubtitleId.*eligibleTracks/);
  const result = await fixture.run();
  assert.equal(result.written, true);
  assert.deepEqual(parse(await readFile(fixture.path, 'utf8')), { requests: result.requests });
  assert.equal((await readdir(fixture.directory)).filter((name) => name.endsWith('.tmp')).length, 0);
});

test('successful zero-candidate generation removes the previous batch without creating an empty one', async (t) => {
  const fixture = await setup(t, [environment()], { Main: { movies: [], series: [], episodes: [] } });
  await writeFile(fixture.path, 'requests: [old]\n');
  const result = await fixture.run();
  assert.equal(result.requests.length, 0); assert.equal(result.written, false);
  await assert.rejects(readFile(fixture.path), { code: 'ENOENT' });
  assert.deepEqual(await readdir(fixture.directory), []);
});

test('publication failure preserves an existing destination and removes the temporary batch', async (t) => {
  const fixture = await setup(t);
  await mkdir(fixture.path);
  await writeFile(join(fixture.path, 'keep'), 'old');
  await assert.rejects(fixture.run(), /Cannot publish requests.yml/);
  assert.equal(await readFile(join(fixture.path, 'keep'), 'utf8'), 'old');
  assert.deepEqual(await readdir(fixture.directory), ['requests.yml']);
  assert.deepEqual(await readdir(fixture.path), ['keep']);
});

test('concurrent generations publish complete batches and leave no temporary files', async (t) => {
  const fixture = await setup(t);
  const results = await Promise.allSettled([fixture.run(),fixture.run()]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2);
  assert.equal(parse(await readFile(fixture.path,'utf8')).requests.length, 2);
  assert.deepEqual(await readdir(fixture.directory), ['requests.yml']);
});

test('permission failure produces a safe error and never leaves a partial batch', async (t) => {
  const fixture = await setup(t); await chmod(fixture.directory, 0o500);
  try { await assert.rejects(fixture.run(), /Cannot publish requests.yml/); }
  finally { await chmod(fixture.directory, 0o700); }
  assert.deepEqual(await readdir(fixture.directory), []);
});

test('missing optional age integrations fail clearly; no age client is initialized without --min-age', async (t) => {
  const fixture = await setup(t);
  await assert.rejects(fixture.run({ minAge: 0, type: 'movie' }), /Radarr/);
  await assert.rejects(fixture.run({ minAge: 7, type: 'series' }), /Sonarr/);
  assert.equal(fixture.calls.length, 0);
  const noClient = () => assert.fail('Age client initialized without filter');
  await fixture.run({ preview: true }, { sonarrFactory: noClient, radarrFactory: noClient });
});

test('real SDK transport during generation is restricted to indexed GET metadata, never probing or provider endpoints', async (t) => {
  const fixture = await setup(t);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (request) => {
    const url = new URL(request.url); calls.push(url.pathname);
    assert.equal(request.method, 'GET'); assert.equal(request.body, null);
    assert.equal(request.headers.get('X-API-KEY') === 'TOP_SECRET', true);
    assert.ok(['/api/system/languages','/api/system/settings','/api/movies','/api/series','/api/episodes'].includes(url.pathname));
    if (url.pathname.endsWith('settings')) return Response.json({ general: { embedded_subs_show_desired: false }, auth: { apikey: 'NEVER_LOG_THIS' } });
    if (url.pathname.endsWith('languages')) return Response.json(catalog);
    if (url.pathname.endsWith('movies')) return Response.json({ data: [item(1)], total: 1 });
    if (url.pathname.endsWith('series')) return Response.json({ data: [series], total: 1 });
    assert.deepEqual(url.searchParams.getAll('seriesid[]'), ['5']);
    return Response.json({ data: [episode(2)] });
  });
  const result = await fixture.run({ preview: true }, { bazarrFactory: createBazarrClient });
  assert.equal(result.requests.length, 2); assert.equal(calls.length, 6);
  assert.deepEqual(await readdir(fixture.directory), []);
});

test('age filtering captures time once, uses each instance independently and distinguishes recent and unknown files', async (t) => {
  const instances = [environment('A'),environment('B')].map((i) => ({ ...i, radarr:{ url:`http://${i.name}.invalid`,apiKey:`${i.name}_KEY` } }));
  const fixture = await setup(t,instances,{ A:{ movies:[item(1),item(2),item(3)] },B:{ movies:[item(1)] } });
  let clockCalls=0; const calls=[];
  const result = await fixture.run({type:'movie',minAge:7,preview:true},{ now:()=>{clockCalls++;return Date.parse('2026-10-26T00:00:00Z');},
    radarrFactory:(options)=>({getMovies:async()=>{
      calls.push(options.baseUrl);
      return {response:new Response(),data:[1,2,3].map((id)=>({id,hasFile:true,movieFile:{id:id+100,movieId:id,
        dateAdded: options.baseUrl==='http://A.invalid' && id===1 ? '2026-10-10T00:00:00Z' : id===3 ? undefined : '2026-10-25T00:00:00Z'}}))};
    }}),
  });
  assert.equal(clockCalls,1);assert.deepEqual(calls,['http://A.invalid','http://B.invalid']);
  assert.deepEqual(result.requests.map((r)=>[r.instance,r.mediaId]),[['A',1]]);
  assert.equal(result.summaries[0].recent,1);assert.equal(result.summaries[0].unknownAge,1);
  assert.deepEqual(await readdir(fixture.directory),[]);
});

test('a failed age-library query aborts publishing even after valid candidates were discovered', async (t) => {
  const fixture=await setup(t,[{...environment(),radarr:{url:'http://radarr.invalid',apiKey:'KEY'}}]);
  await assert.rejects(fixture.run({type:'movie',minAge:7},{radarrFactory:()=>({getMovies:async()=>({response:new Response('TOP_SECRET',{status:500}),error:'TOP_SECRET'})})}), /Radarr GET.*HTTP 500/);
  assert.deepEqual(await readdir(fixture.directory),[]);
});

test('unsupported configured language and missing selected series stop generation safely', async (t)=>{
  const fixture=await setup(t);
  await assert.rejects(fixture.run({type:'series',seriesId:999}), /Selected series.*not found/);
  fixture.config.instances[0].translation.sourceLanguage='xyz';
  await assert.rejects(fixture.run({type:'movie'}),/Unsupported.*configured translation languages/);
  assert.deepEqual(await readdir(fixture.directory),[]);
});


test('complete library metadata works outside the desired target profile, including default embedded-only generation', async (t) => {
  const instance = environment(); instance.translation.onlyEmbedded = true;
  const movie = item(1, 'en', 'nl', { missing_subtitles: [], subtitles: [
    { id: '44', code2: 'en', forced: false, hi: false, path: null, embedded_track_id: 7 },
  ] });
  const fixture = await setup(t, [instance], { Main: { movies: [movie], series: [] } });
  const result = await fixture.run();
  assert.equal(result.requests.length, 1); assert.equal(result.requests[0].selectedSubtitleId, '44');
  assert.equal(result.requests[0].tracks[0].codec, 'unknown');
  assert.equal(parse(await readFile(fixture.path, 'utf8')).requests[0].tracks[0].embedded_track_id, 7);
});

test('excludeHI generation ignores HI targets and selects normal embedded sources only', async t => {
  const instance = environment(); instance.translation.onlyEmbedded = true; instance.translation.excludeHI = true;
  const normal = { id: 201, code2: 'en', forced: false, hi: false, path: null, embedded_track_id: 1 };
  const hi = { ...normal, id: 202, hi: true, embedded_track_id: 2 };
  const movies = [
    item(1, 'en', 'nl', { subtitles: [normal, { id: 301, code2: 'nl', forced: false, hi: true }] }),
    item(2, 'en', 'nl', { subtitles: [normal, hi, { id: 302, code2: 'nl', forced: true, hi: false }] }),
    item(3, 'en', 'nl', { subtitles: [hi, { id: 303, code2: 'nl', forced: false, hi: true }] }),
  ];
  const fixture = await setup(t, [instance], { Main: { movies, series: [] } });
  const result = await fixture.run({ type: 'movie' });
  assert.deepEqual(result.requests.map(r => [r.mediaId, r.selectedSubtitleId]), [[1, 201], [2, 201]]);
  assert.equal(result.summaries[0].target, 0);
  assert.equal(result.summaries[0].noSource, 1);
  assert.ok(result.requests.every(r => r.tracks.every(track => track.hi === false)));
});

test('filtered or unknown completeness never uses missing_subtitles as authorization to generate', async (t) => {
  const fixture = await setup(t, [environment()], { Main: { complete: false } });
  await assert.rejects(fixture.run(), /Subtitle visibility response is incomplete/);
  assert.deepEqual(await readdir(fixture.directory), []);
});

test('settings read failure aborts and preserves the previous batch with safe diagnostics', async (t) => {
  const fixture = await setup(t);
  const previous = 'requests: [previous]\n'; await writeFile(fixture.path, previous);
  await assert.rejects(fixture.run({ type: 'movie' }, { bazarrFactory: () => ({
    getLanguages: async () => catalog,
    getSubtitleVisibility: async () => { throw Object.assign(new Error('TOP_SECRET http://private.invalid'), { operation: 'GET /api/system/settings', httpStatus: 403 }); },
    getMovies: async () => [item(1)],
  }) }), /Subtitle visibility failed.*GET \/api\/system\/settings: HTTP 403/);
  assert.doesNotMatch(fixture.lines.join(), /TOP_SECRET|private.invalid/);
  assert.equal(await readFile(fixture.path, 'utf8'), previous);
});

for (const failure of ['changed', 'failed']) {
  test(`visibility recheck ${failure} aborts batch publication`, async (t) => {
    const fixture = await setup(t); let calls = 0;
    await assert.rejects(fixture.run({ type: 'movie' }, { bazarrFactory: () => ({
      getLanguages: async () => catalog, getMovies: async () => [item(1)],
      getSubtitleVisibility: async () => {
        calls++; if (calls === 1) return { complete: true };
        if (failure === 'failed') throw Object.assign(new Error('SECRET'), { httpStatus: 503 });
        return { complete: false };
      },
    }) }), /visibility.*(?:changed|recheck failed)/);
    assert.deepEqual(await readdir(fixture.directory), []);
  });
}

for (const [sourceLanguage, targetLanguage] of [['en', 'nl'], ['es', 'de'], ['fr', 'en']]) {
  test(`filtered profile authorizes both media types for ${sourceLanguage} -> ${targetLanguage}, fetched once`, async (t) => {
    const instance = environment('Main', sourceLanguage, targetLanguage); instance.translation.onlyEmbedded = true;
    const embedded = [{ id: 401, code2: sourceLanguage, path: null, embedded_track_id: 4, forced: false, hi: false }];
    const movie = item(1, sourceLanguage, targetLanguage, { profileId: 7, subtitles: embedded, missing_subtitles: [] });
    const ep = { ...episode(2, 5, sourceLanguage, targetLanguage), profileId: 999, subtitles: embedded, missing_subtitles: [] };
    const fixture = await setup(t, [instance], { Main: { complete: false, desiredOnly: true,
      profiles: [{ profileId: 7, items: [{ language: sourceLanguage }, { language: targetLanguage, forced: 'True', hi: 'True' }] }],
      movies: [movie], series: [{ ...series, profileId: 7 }], episodes: [ep],
    } });
    const result = await fixture.run();
    assert.equal(result.requests.length, 2); assert.equal(result.summaries[0].uncertain, 0);
    assert.equal(fixture.calls.filter(([op]) => op === 'profiles').length, 1);
    assert.ok(result.requests.every((r) => r.sourceLanguage === sourceLanguage && r.targetLanguage === targetLanguage && r.tracks[0].codec === 'unknown'));
  });
}

for (const [profileId, profiles, reason] of [
  [undefined, [{ profileId: 7, items: [{ language: 'en' }, { language: 'nl' }] }], 'missing or invalid'],
  [999, [{ profileId: 7, items: [{ language: 'en' }, { language: 'nl' }] }], 'not found'],
  [7, [{ profileId: 7, items: [{ language: 'en' }] }], 'target language not confirmed'],
  [7, [{ profileId: 7, items: [{ language: 'nl' }] }], 'source language not confirmed'],
  [7, [{ profileId: 7, items: [{ language: 'es' }, { language: 'de' }] }], 'source language not confirmed'],
  [7, [], 'not found'],
]) {
  test(`unresolved movie profile remains uncertain: ${reason} ${profileId}`, async (t) => {
    const fixture = await setup(t, [environment()], { Main: { complete: false, desiredOnly: true, profiles,
      movies: [item(1, 'en', 'nl', { profileId })], series: [],
    } });
    const result = await fixture.run();
    assert.equal(result.requests.length, 0); assert.equal(result.summaries[0].uncertain, 1);
    assert.match(fixture.lines.join(), new RegExp(`movie:1 visibility unresolved.*${reason}`));
    assert.deepEqual(await readdir(fixture.directory), []);
  });
}

test('episodes never use their own profileId to compensate for an absent parent-series profile', async (t) => {
  const fixture = await setup(t, [environment()], { Main: { complete: false, desiredOnly: true,
    profiles: [{ profileId: 7, items: [{ language: 'en' }, { language: 'nl' }] }],
    series: [{ ...series, profileId: null }], episodes: [{ ...episode(2), profileId: 7 }],
  } });
  const result = await fixture.run({ type: 'series' });
  assert.equal(result.requests.length, 0); assert.equal(result.summaries[0].uncertain, 1);
  assert.match(fixture.lines.join(), /episode:2 visibility unresolved.*missing or invalid assigned profileId/);
});

test('mixed media profiles are evaluated independently and a visible forced target always wins', async (t) => {
  const fixture = await setup(t, [environment()], { Main: { complete: false, desiredOnly: true,
    profiles: [{ profileId: 7, items: [{ language: 'en' }, { language: 'nl' }] }],
    movies: [item(1, 'en', 'nl', { profileId: 7 }), item(2, 'en', 'nl', { profileId: 999 }),
      item(3, 'en', 'nl', { profileId: null, subtitles: [{ code2: 'nl', forced: true, hi: true, path: null }] })],
    series: [{ ...series, profileId: 7 }], episodes: [episode(4)],
  } });
  const result = await fixture.run({ preview: true });
  assert.deepEqual(result.requests.map((r) => [r.type, r.mediaId]), [['movie', 1], ['episode', 4]]);
  assert.equal(result.summaries[0].uncertain, 1); assert.equal(result.summaries[0].target, 1);
  assert.equal(fixture.calls.filter(([op]) => op === 'profiles').length, 1);
});

test('unfiltered visibility bypasses profiles entirely', async (t) => {
  const fixture = await setup(t);
  const result = await fixture.run({ type: 'movie' }, { bazarrFactory: () => ({
    getLanguages: async () => catalog, getSubtitleVisibility: async () => ({ complete: true, showOnlyDesiredLanguages: false }),
    getLanguageProfiles: () => assert.fail('Profiles are unnecessary when unfiltered'), getMovies: async () => [item(1)],
  }) });
  assert.equal(result.requests.length, 1);
});

test('profile lookup failure aborts safely and preserves the previous batch', async (t) => {
  const fixture = await setup(t);
  const previous = 'requests: [previous]\n'; await writeFile(fixture.path, previous);
  await assert.rejects(fixture.run({ type: 'movie' }, { bazarrFactory: () => ({
    getLanguages: async () => catalog, getSubtitleVisibility: async () => ({ complete: false, showOnlyDesiredLanguages: true }),
    getLanguageProfiles: async () => { throw Object.assign(new Error('TOP_SECRET'), { operation: 'GET /api/system/languages/profiles', httpStatus: 403 }); },
    getMovies: async () => [item(1, 'en', 'nl', { profileId: 7 })],
  }) }), /Language profiles failed.*GET \/api\/system\/languages\/profiles: HTTP 403/);
  assert.doesNotMatch(fixture.lines.join(), /TOP_SECRET/);
  assert.equal(await readFile(fixture.path, 'utf8'), previous);
});

test('profile IDs and languages are scoped to their own instance', async (t) => {
  const instances = [environment('A', 'en', 'nl'), environment('B', 'es', 'de')];
  const fixture = await setup(t, instances, {
    A: { complete: false, desiredOnly: true, profiles: [{ profileId: 7, items: [{ language: 'en' }, { language: 'nl' }] }], movies: [item(1, 'en', 'nl', { profileId: 7 })] },
    B: { complete: false, desiredOnly: true, profiles: [{ profileId: 7, items: [{ language: 'en' }, { language: 'nl' }] }], movies: [item(1, 'es', 'de', { profileId: 7 })] },
  });
  const result = await fixture.run({ type: 'movie', preview: true });
  assert.deepEqual(result.requests.map((r) => r.instance), ['A']);
  assert.equal(result.summaries[1].uncertain, 1); assert.equal(fixture.calls.filter(([op]) => op === 'profiles').length, 2);
});

test('filtered generation uses the named SDK profile GET without provider or write operations', async (t) => {
  const fixture = await setup(t); const paths = [];
  t.mock.method(globalThis, 'fetch', async (request) => {
    const url = new URL(request.url); paths.push(url.pathname);
    assert.equal(request.method, 'GET'); assert.equal(request.body, null);
    assert.equal(request.headers.get('X-Api-Key') === 'TOP_SECRET', true);
    if (url.pathname === '/api/system/languages') return Response.json(catalog);
    if (url.pathname === '/api/system/settings') return Response.json({ general: { embedded_subs_show_desired: true } });
    if (url.pathname === '/api/system/languages/profiles') return Response.json([{ profileId: 7, items: [{ language: 'eng' }, { language: 'nld' }] }]);
    if (url.pathname === '/api/movies') return Response.json({ total: 1, data: [item(1, 'en', 'nl', { profileId: 7, missing_subtitles: [] })] });
    assert.fail('Unexpected endpoint');
  });
  const result = await fixture.run({ type: 'movie', preview: true }, { bazarrFactory: createBazarrClient });
  assert.equal(result.requests.length, 1);
  assert.equal(paths.filter((path) => path.endsWith('/profiles')).length, 1);
  assert.equal(paths.length, 5);
});

test('an unknown setting cannot be overridden by a valid language profile', async (t) => {
  const fixture = await setup(t);
  let profileCalls = 0;
  await assert.rejects(fixture.run({ type: 'movie' }, { bazarrFactory: () => ({
    getLanguages: async () => catalog, getSubtitleVisibility: async () => ({ complete: false, showOnlyDesiredLanguages: null }),
    getLanguageProfiles: async () => { profileCalls++; return [{ profileId: 7, items: [{ language: 'en' }, { language: 'nl' }] }]; },
    getMovies: async () => [item(1, 'en', 'nl', { profileId: 7 })],
  }) }), /Subtitle visibility response is incomplete/);
  assert.equal(profileCalls, 0);
});

test('filtered visibility becoming unknown at recheck prevents batch publication', async (t) => {
  const fixture = await setup(t); let visibilityCalls = 0; let profileCalls = 0;
  await assert.rejects(fixture.run({ type: 'movie' }, { bazarrFactory: () => ({
    getLanguages: async () => catalog, getMovies: async () => [item(1, 'en', 'nl', { profileId: 7 })],
    getLanguageProfiles: async () => { profileCalls++; return [{ profileId: 7, items: [{ language: 'en' }, { language: 'nl' }] }]; },
    getSubtitleVisibility: async () => ({ complete: false, showOnlyDesiredLanguages: ++visibilityCalls === 1 ? true : null }),
  }) }), /visibility changed/);
  assert.equal(profileCalls, 1); assert.deepEqual(await readdir(fixture.directory), []);
});
