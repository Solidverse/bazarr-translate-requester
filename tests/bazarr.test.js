import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBazarrClient } from '../src/bazarr.js';
import { inspectBazarr } from '../src/inspect.js';
import { createLogger } from '../src/logger.js';
const instance = { name: 'HD', enabled: true, url: 'http://bazarr:6767/proxy/bazarr/', apiKey: 'TOP_SECRET' };
const movie = (id) => ({ radarrId: id, title: 'Movie', year: '2025', path: '/movies/test.mkv', monitored: true, subtitles: [{ code2: 'en', path: null, embedded_track_id: 2 }], missing_subtitles: [{ code2: 'nl' }] });
const series = (id) => ({ sonarrSeriesId: id, title: 'Series' });
const episode = (id, sid = 1) => ({ sonarrEpisodeId: id, sonarrSeriesId: sid, title: 'Episode', season: 1, episode: 2, path: '/series/test.mkv' });
function setup(handler, options = {}) {
  const calls = [];
  const client = createBazarrClient(instance, { ...options, fetchImpl: async (url, init) => {
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
  assert.equal(calls[0].url.searchParams.has('apikey'), false); assert.equal(calls[0].init.redirect, 'error');
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
      if (mode === 'JSON') return new Response('TOP_SECRET <html>');
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
  const config = { bazarr: [{ ...instance, name: 'broken' }, { ...instance, name: '4K', enabled: false }, { ...instance, name: 'TOP_SECRET-HD', url: 'http://other:6767' }] };
  const calls = [];
  const result = await inspectBazarr(config, { logger: createLogger('info', [instance.apiKey]), clientFactory: (item) => createBazarrClient(item, { fetchImpl: async (url, init) => {
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
  const result = await inspectBazarr({ bazarr: [instance] }, { logger, clientFactory: () => ({
    getStatus: async () => ({}), getMovies: async () => [movie(1)], getSeries: async () => { throw new Error('TOP_SECRET'); },
    getEpisodes: async () => assert.fail('Unfiltered episode calls forbidden'), getWantedMovies: async () => [], getWantedEpisodes: async () => [],
  }) });
  assert.equal(result.failed, true); assert.equal(result.summaries[0].movies, 1); assert.equal(result.summaries[0].episodes, null);
  assert.match(lines.join(), /unavailable/); assert.doesNotMatch(lines.join(), /TOP_SECRET/);
});
test('single instance inspection uses all read-only metadata operations including filtered episodes', async () => {
  const calls = []; const logger = { info() {}, warn() {}, error() {} };
  const result = await inspectBazarr({ bazarr: [instance] }, { logger, clientFactory: (item) => createBazarrClient(item, { fetchImpl: async (url, init) => {
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
    const client = createBazarrClient({ ...instance, apiKey }, { fetchImpl: async (_url, options) => {
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
