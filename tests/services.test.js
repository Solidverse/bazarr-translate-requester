import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectServices } from '../src/services.js';
import { createLogger } from '../src/logger.js';

const connection = (name, service) => ({ url: `http://${name}.invalid/prefix/${service}/`, apiKey: `${name}_${service}_SECRET` });
const environment = (name, services = ['bazarr', 'sonarr', 'radarr']) => ({ name, enabled: true,
  ...Object.fromEntries(services.map((service) => [service, connection(name, service)])),
  translation: { sourceLanguage: 'en', targetLanguage: 'nl' },
});
const silent = { info() {}, warn() {}, error() {} };
function transport(t, instances, handler = () => undefined) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (request) => {
    const url = new URL(request.url);
    calls.push({ url, request });
    assert.equal(request.method, 'GET'); assert.equal(request.body, null);
    assert.ok(['/api/system/status', '/api/v3/system/status'].some((path) => url.pathname.endsWith(path)));
    assert.equal(url.searchParams.has('apikey'), false);
    const name = url.hostname.split('.')[0];
    const service = url.pathname.split('/')[2];
    assert.equal(request.headers.get('X-API-KEY') === instances.find((i) => i.name.toLowerCase() === name)[service].apiKey, true);
    const override = handler(service, name);
    if (override !== undefined) return override;
    return Response.json(service === 'bazarr' ? { data: { bazarr_version: '1.5.5' } } : { version: service === 'sonarr' ? '4.0.0' : '5.0.0', appName: service });
  });
  return calls;
}

for (const services of [['bazarr'], ['bazarr', 'sonarr'], ['bazarr', 'radarr'], ['bazarr', 'sonarr', 'radarr']]) {
  test(`initializes only configured services with separate credentials: ${services.join(', ')}`, async (t) => {
    const instance = environment('main', services);
    const calls = transport(t, [instance]);
    const result = await inspectServices({ instances: [instance] }, { logger: silent });
    assert.equal(result.failed, false); assert.equal(calls.length, services.length);
    assert.equal(result.summaries[0].bazarr.version, '1.5.5');
    for (const service of services) assert.equal(result.summaries[0][service].connected, true);
  });
}

test('multiple instances remain independent; disabled instances initialize nothing', async (t) => {
  const instances = [environment('first'), { name: 'disabled', enabled: false }, environment('second')];
  const calls = transport(t, instances);
  const result = await inspectServices({ instances }, { logger: silent });
  assert.equal(result.failed, false); assert.equal(result.summaries.length, 2); assert.equal(calls.length, 6);
});

for (const service of ['bazarr', 'sonarr', 'radarr']) {
  for (const fault of ['401', '503', 'network', 'timeout', 'json', 'structure']) {
    test(`${service} ${fault} failure remains isolated and credential safe`, async (t) => {
      const instances = [environment('first'), environment('second')];
      const lines = [];
      t.mock.method(console, 'log', (line) => lines.push(line)); t.mock.method(console, 'error', (line) => lines.push(line));
      const calls = transport(t, instances, (current, name) => {
        if (current !== service || name !== 'first') return;
        if (fault === 'network') throw Object.assign(new Error('TOP_SECRET http://private.invalid'), { cause: { code: 'ECONNREFUSED' } });
        if (fault === 'timeout') throw new DOMException('TOP_SECRET', 'TimeoutError');
        if (fault === 'json') return new Response('TOP_SECRET', { headers: { 'Content-Type': 'application/json' } });
        if (fault === 'structure') return Response.json([]);
        return new Response('TOP_SECRET sensitive body', { status: Number(fault) });
      });
      const result = await inspectServices({ instances }, { logger: createLogger('info', instances.flatMap((i) => ['bazarr', 'sonarr', 'radarr'].map((s) => i[s].apiKey))) });
      assert.equal(result.failed, true); assert.equal(calls.length, 6);
      assert.equal(result.summaries[0][service].connected, false);
      assert.equal(result.summaries[1][service].connected, true);
      assert.match(lines.join(), new RegExp(`\\[first\\] ${service}: Failed`));
      if (['401', '503'].includes(fault)) assert.match(lines.join(), new RegExp(`HTTP ${fault}`));
      assert.doesNotMatch(lines.join(), /TOP_SECRET|_SECRET|X-API-KEY|private.invalid|sensitive body/);
    });
  }
}

test('missing versions are unavailable; untrusted version text and nested keys are not logged', async (t) => {
  const instances = [environment('SECRET')];
  const lines = []; t.mock.method(console, 'log', (line) => lines.push(line));
  transport(t, instances, (service) => service === 'sonarr' ? Response.json({ version: 'http://private.invalid/TOP_SECRET' }) : service === 'radarr' ? Response.json({ appName: 'Radarr' }) : undefined);
  const result = await inspectServices({ instances }, { logger: createLogger('info', ['SECRET']) });
  assert.equal(result.failed, false);
  assert.equal(result.summaries[0].sonarr.version, null); assert.equal(result.summaries[0].radarr.version, null);
  assert.doesNotMatch(lines.join(), /SECRET|private.invalid/);
});

test('disabled environments do not initialize any service client', async () => {
  const forbidden = () => assert.fail('Disabled service initialized');
  const result = await inspectServices({ instances: [{ name: 'Offline', enabled: false }] }, {
    logger: silent, bazarrFactory: forbidden, sonarrFactory: forbidden, radarrFactory: forbidden,
  });
  assert.deepEqual(result, { failed: false, summaries: [] });
});
