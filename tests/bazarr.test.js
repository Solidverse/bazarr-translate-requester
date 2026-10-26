import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createBazarrClient } from '../src/bazarr.js';
import { inspectBazarr } from '../src/inspect.js';
import { createLogger } from '../src/logger.js';
const nativeFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = nativeFetch; });
function transportClient(instance, { fetchImpl, ...options }) {
  globalThis.fetch = (request) => fetchImpl(new URL(request.url), {
    method: request.method, headers: { 'X-API-KEY': request.headers.get('X-API-KEY') },
    redirect: request.redirect, signal: request.signal,
  });
  return createBazarrClient(instance, options);
}
const instance = { name: 'HD', enabled: true, url: 'http://bazarr:6767/proxy/bazarr/', apiKey: 'TOP_SECRET' };
const environment = (connection) => ({ name: connection.name, enabled: connection.enabled, bazarr: { url: connection.url, apiKey: connection.apiKey }, translation: { sourceLanguage: 'en', targetLanguage: 'nl' } });
const movie = (id) => ({ radarrId: id, title: 'Movie', year: '2025', path: '/movies/test.mkv', monitored: true, subtitles: [{ code2: 'en', path: null, embedded_track_id: 2 }], missing_subtitles: [{ code2: 'nl' }] });
const series = (id) => ({ sonarrSeriesId: id, title: 'Series' });
const episode = (id, sid = 1) => ({ sonarrEpisodeId: id, sonarrSeriesId: sid, title: 'Episode', season: 1, episode: 2, path: '/series/test.mkv' });
function setup(handler, options = {}) {
  const calls = [];
  const client = transportClient(instance, { ...options, fetchImpl: async (url, init) => {
    calls.push({ url: new URL(url), init });
    return handler(new URL(url), init, calls.length);
  } });
  return { client, calls };
}
test('authentication and reverse-proxy base path; original metadata is preserved', async () => {
  const data = [movie(1)]; const { client, calls } = setup(() => Response.json({ data, total: 1 }));
  assert.deepEqual(await client.getMovies(), data);
  assert.equal(calls[0].url.pathname, '/proxy/bazarr/api/movies');
  assert.equal(calls[0].init.method, 'GET'); assert.equal(calls[0].init.headers['X-API-KEY'], instance.apiKey);
  assert.equal(calls[0].url.searchParams.has('apikey'), false); assert.equal(calls[0].init.redirect, 'follow');
});
for (const [method, data] of [['getMovies', [movie(1)]], ['getSeries', [series(1)]], ['getWantedMovies', [movie(1)]], ['getWantedEpisodes', [{ sonarrEpisodeId: 1, episodeTitle: 'Episode', seriesTitle: 'Series', episode_number: '1x2', missing_subtitles: [] }]]]) {
  test(`${method} handles its data/total envelope and an empty library`, async () => {
    assert.deepEqual(await setup(() => Response.json({ data, total: 1 })).client[method](), data);
    assert.deepEqual(await setup(() => Response.json({ data: [], total: 0 })).client[method](), []);
  });
}
test('status uses data object rather than list envelope', async () => {
  const { client } = setup(() => Response.json({ data: { bazarr_version: '1.5.5', python_version: '3.12' } }));
  assert.equal((await client.getStatus()).bazarr_version, '1.5.5');
});
test('pagination follows total and actual page lengths, including more than 1000 movies', async () => {
  const total = 1101;
  const { client, calls } = setup((url) => {
    const start = Number(url.searchParams.get('start'));
    assert.equal(url.searchParams.get('length'), '100');
    return Response.json({ data: Array.from({ length: Math.min(100, total - start) }, (_, i) => movie(start + i + 1)), total });
  });
  assert.equal((await client.getMovies()).length, total); assert.equal(calls.length, 12);
});
for (const fault of ['repeated', 'empty', 'changed']) {
  test(`incomplete pagination fails instead of returning partial results: ${fault}`, async () => {
    const { client } = setup((_url, _init, index) => Response.json({
      data: index === 1 || fault === 'repeated' ? [movie(1)] : [], total: index === 2 && fault === 'changed' ? 3 : 2,
    }));
    await assert.rejects(client.getMovies(), /REPEATED|INCOMPLETE|COLLECTION_CHANGED/);
  });
}
test('episodes require explicit IDs and use only documented repeated array parameters', async () => {
  const { client, calls } = setup((url) => {
    assert.deepEqual(url.searchParams.getAll('seriesid[]'), ['1', '2']);
    assert.equal(url.searchParams.has('start'), false); return Response.json({ data: [episode(11, 1), episode(12, 2)] });
  });
  assert.equal((await client.getEpisodes({ seriesIds: [1, 2, 1] })).length, 2);
  await assert.rejects(client.getEpisodes(), /IDS_REQUIRED/);
  await assert.rejects(client.getEpisodes({ seriesIds: [-1] }), /INVALID_IDS/);
  assert.deepEqual(await client.getEpisodes({ seriesIds: [] }), []); assert.equal(calls.length, 1);
  const filtered = setup((url) => { assert.deepEqual(url.searchParams.getAll('episodeid[]'), ['5']); return Response.json({ data: [episode(5)] }); });
  assert.equal((await filtered.client.getEpisodes({ episodeIds: [5] })).length, 1);
});
for (const status of [401, 403, 404, 429, 500]) {
  test(`HTTP ${status} fails safely without leaking body or credentials`, async () => {
    const { client, calls } = setup(() => new Response('TOP_SECRET http://user:pass@private-host secret body', { status }));
    await assert.rejects(client.getMovies(), (error) => {
      assert.equal(error.httpStatus, status); assert.match(error.message, /GET \/api\/movies/);
      assert.doesNotMatch(JSON.stringify(error) + error.message, /TOP_SECRET|private-host|secret body|user:pass/); return true;
    });
    assert.equal(calls.length, 1);
  });
}
for (const mode of ['connection', 'timeout', 'JSON', 'structure']) {
  test(`errors remain distinguishable and credential safe: ${mode}`, async () => {
    const { client } = setup(() => {
      if (mode === 'connection') throw Object.assign(new Error('TOP_SECRET'), { cause: { code: 'ECONNREFUSED' } });
      if (mode === 'timeout') throw new DOMException('TOP_SECRET', 'TimeoutError');
      if (mode === 'JSON') return new Response('TOP_SECRET <html>', { headers: { 'Content-Type': 'application/json' } });
      return Response.json({ data: {}, total: 1 });
    });
    await assert.rejects(client.getMovies(), (error) => {
      assert.equal(error.code, { connection: 'ECONNREFUSED', timeout: 'TIMEOUT', JSON: 'INVALID_JSON', structure: 'INVALID_RESPONSE' }[mode]);
      assert.doesNotMatch(error.message, /TOP_SECRET/); return true;
    });
  });
}
test('native timeout aborts a stalled fetch', async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const { client } = setup((_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })), { timeoutMs: 10 });
    await assert.rejects(client.getMovies(), /TIMEOUT/);
  } finally { clearTimeout(keepAlive); }
});
test('multi-instance inspection isolates failures, skips disabled instances and never searches providers', async (t) => {
  const lines = []; t.mock.method(console, 'log', (line) => lines.push(line)); t.mock.method(console, 'error', (line) => lines.push(line));
  const config = { instances: [{ ...instance, name: 'broken' }, { ...instance, name: '4K', enabled: false }, { ...instance, name: 'TOP_SECRET-HD', url: 'http://other:6767' }].map(environment) };
  const calls = [];
  const result = await inspectBazarr(config, { logger: createLogger('info', [instance.apiKey]), clientFactory: (item) => transportClient(item, { fetchImpl: async (url, init) => {
    calls.push({ url: new URL(url), init });
    assert.equal(init.method, 'GET'); assert.doesNotMatch(url.pathname, /providers|subtitles|scan|search/);
    if (item.name === 'broken') throw new Error('TOP_SECRET');
    if (url.pathname.endsWith('/system/status')) return Response.json({ data: { bazarr_version: '1.5.5' } });
    return Response.json({ data: [], total: 0 });
  } }) });
  assert.equal(result.failed, true); assert.equal(result.summaries.length, 2);
  assert.equal(result.summaries[1].movies, 0); assert.ok(calls.every((call) => call.init.method === 'GET'));
  assert.match(lines.join(), /Disabled.*Skipping/); assert.match(lines.join(), /all configured languages/);
  assert.doesNotMatch(lines.join(), /TOP_SECRET|X-API-KEY/);
});

test('partial inspection failures keep other reliable counts and never invent totals', async () => {
  const lines = []; const logger = Object.fromEntries(['info', 'warn', 'error'].map((level) => [level, (line) => lines.push(line)]));
  const result = await inspectBazarr({ instances: [environment(instance)] }, { logger, clientFactory: () => ({
    getStatus: async () => ({}), getMovies: async () => [movie(1)], getSeries: async () => { throw new Error('TOP_SECRET'); },
    getEpisodes: async () => assert.fail('Unfiltered episode calls forbidden'), getWantedMovies: async () => [], getWantedEpisodes: async () => [],
  }) });
  assert.equal(result.failed, true); assert.equal(result.summaries[0].movies, 1); assert.equal(result.summaries[0].episodes, null);
  assert.match(lines.join(), /unavailable/); assert.doesNotMatch(lines.join(), /TOP_SECRET/);
});
test('single instance inspection uses all read-only metadata operations including filtered episodes', async () => {
  const calls = []; const logger = { info() {}, warn() {}, error() {} };
  const result = await inspectBazarr({ instances: [environment(instance)] }, { logger, clientFactory: (item) => transportClient(item, { fetchImpl: async (url, init) => {
    calls.push(url.pathname); assert.equal(init.method, 'GET');
    if (url.pathname.endsWith('/system/status')) return Response.json({ data: { bazarr_version: '1.5.5' } });
    if (url.pathname.endsWith('/series')) return Response.json({ data: [series(1)], total: 1 });
    if (url.pathname.endsWith('/episodes')) { assert.deepEqual(url.searchParams.getAll('seriesid[]'), ['1']); return Response.json({ data: [episode(1)] }); }
    return Response.json({ data: [], total: 0 });
  } }) });
  assert.equal(result.failed, false); assert.equal(result.summaries[0].episodes, 1);
  assert.equal(calls.length, 6); assert.ok(!calls.some((path) => /providers|search|scan|subtitles/.test(path)));
});

test('each configured instance uses its own API key without cross-instance state', async () => {
  const keys = [];
  for (const apiKey of ['FIRST_SECRET', 'SECOND_SECRET']) {
    const client = transportClient({ ...instance, apiKey }, { fetchImpl: async (_url, options) => {
      keys.push(options.headers['X-API-KEY']); return Response.json({ data: [], total: 0 });
    } });
    assert.deepEqual(await client.getMovies(), []);
  }
  assert.deepEqual(keys, ['FIRST_SECRET', 'SECOND_SECRET']);
});
test('episode identifiers are batched without an unfiltered fallback', async () => {
  const ids = Array.from({ length: 101 }, (_, i) => i + 1);
  const { client, calls } = setup((url) => {
    const selected = url.searchParams.getAll('episodeid[]').map(Number);
    assert.ok(selected.length > 0 && selected.length <= 50);
    return Response.json({ data: selected.map((id) => episode(id)) });
  });
  assert.equal((await client.getEpisodes({ episodeIds: ids })).length, 101); assert.equal(calls.length, 3);
});

for (const identity of [{ radarrMovieId: 12 }, { sonarrEpisodeId: 34 }]) {
  test(`subtitle metadata uses Tsarr with explicit media identity: ${Object.keys(identity)[0]}`, async () => {
    const tracks = { audio_tracks: [], embedded_subtitles_tracks: [{ stream: 's:0', language: 'eng' }], external_subtitles_tracks: [] };
    const { client, calls } = setup((url) => {
      assert.equal(url.pathname, '/proxy/bazarr/api/subtitles');
      assert.equal(url.searchParams.get('subtitlesPath'), '/media/example.en.srt');
      const [field, id] = Object.entries(identity)[0];
      assert.equal(url.searchParams.get(field), String(id));
      assert.equal(url.searchParams.has('action'), false);
      return Response.json({ data: tracks });
    });
    assert.deepEqual(await client.getSubtitles({ subtitlesPath: '/media/example.en.srt', ...identity }), tracks);
    assert.equal(calls.length, 1);
    await assert.rejects(client.getSubtitles(), /INVALID_IDS/);
    assert.equal(calls.length, 1);
  });
}

test('HTML and malformed subtitle metadata fail rather than appearing empty', async () => {
  await assert.rejects(setup(() => new Response('<html>secret</html>')).client.getMovies(), /INVALID_RESPONSE/);
  await assert.rejects(setup(() => Response.json({ data: {} })).client.getSubtitles({ subtitlesPath: '/subs.srt', radarrMovieId: 1 }), /INVALID_RESPONSE/);
});

test('two simultaneous SDK objects keep authentication separate during interleaved calls', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (request) => {
    calls.push([new URL(request.url).host, request.headers.get('X-API-KEY')]);
    return Response.json({ data: [], total: 0 });
  });
  const a = createBazarrClient({ ...instance, url: 'http://first', apiKey: 'FIRST' });
  const b = createBazarrClient({ ...instance, url: 'http://second', apiKey: 'SECOND' });
  await a.getMovies(); await b.getMovies(); await a.getSeries();
  assert.deepEqual(calls, [['first', 'FIRST'], ['second', 'SECOND'], ['first', 'FIRST']]);
});

for (const [value, complete] of [[false, true], [true, false], ['false', false], [undefined, false], [null, false]]) {
  test(`visibility GET reduces settings to booleans only: ${JSON.stringify(value)}`, async () => {
    const { client, calls } = setup(() => Response.json({ general: { embedded_subs_show_desired: value },
      auth: { apikey: 'OTHER_SECRET' }, sonarr: { apikey: 'SONARR_SECRET' } }));
    const result = await client.getSubtitleVisibility();
    assert.equal(result.complete, complete);
    assert.deepEqual(Object.keys(result).sort(), ['complete', 'showOnlyDesiredLanguages']);
    assert.doesNotMatch(JSON.stringify(result), /SECRET|apikey|sonarr/);
    assert.equal(calls.length, 1); assert.equal(calls[0].url.pathname, '/proxy/bazarr/api/system/settings');
    assert.equal(calls[0].init.method, 'GET'); assert.equal(calls[0].init.headers['X-API-KEY'] === instance.apiKey, true);
    assert.equal(calls[0].url.search, '');
  });
}
for (const status of [403, 404, 500]) {
  test(`visibility HTTP ${status} does not expose settings bodies`, async () => {
    const { client } = setup(() => new Response('OTHER_SECRET private settings', { status }));
    await assert.rejects(client.getSubtitleVisibility(), (error) => error.httpStatus === status
      && !/OTHER_SECRET|private settings/.test(error.message + JSON.stringify(error)));
  });
}

test('visibility timeout and invalid JSON use safe diagnostics without settings payloads', async () => {
  const stalled = setup((_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })), { timeoutMs: 10 });
  await assert.rejects(stalled.client.getSubtitleVisibility(), /TIMEOUT/);
  const invalid = setup(() => new Response('{"apikey":"OTHER_SECRET"'));
  await assert.rejects(invalid.client.getSubtitleVisibility(), (error) => error.code === 'INVALID_JSON'
    && !/OTHER_SECRET|apikey/.test(error.message + JSON.stringify(error)));
});

test('language profiles use the SDK bare-array contract and authenticated read-only endpoint', async () => {
  const profiles = [{ profileId: 7, name: 'Example', items: [{ language: 'eng', id: 1, hi: 'False', forced: 'False' }, { language: 'nl', id: 2 }] }];
  const { client, calls } = setup(() => Response.json(profiles));
  assert.deepEqual(await client.getLanguageProfiles(), profiles);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, '/proxy/bazarr/api/system/languages/profiles');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers['X-API-KEY'] === instance.apiKey, true);
  assert.equal(calls[0].url.search, '');
});
for (const response of [null, { data: [] }, [{ profileId: '7', items: [] }], [{ profileId: 7, items: '[]' }], [{ profileId: 7, items: [] }, { profileId: 7, items: [] }]]) {
  test(`invalid profile response fails safely: ${JSON.stringify(response)}`, async () => {
    const { client } = setup(() => Response.json(response));
    await assert.rejects(client.getLanguageProfiles(), (error) => error.code === 'INVALID_RESPONSE');
  });
}
test('language-profile API errors retain operation/status without exposing response bodies', async () => {
  const { client, calls } = setup(() => new Response('SECRET_PROFILE_BODY', { status: 403 }));
  await assert.rejects(client.getLanguageProfiles(), (error) => error.httpStatus === 403
    && error.operation === 'GET /api/system/languages/profiles'
    && !error.message.includes('SECRET_PROFILE_BODY'));
  assert.equal(calls.length, 1);
});
