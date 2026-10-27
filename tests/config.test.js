import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';

const example = await readFile(new URL('../config.example.yml', import.meta.url), 'utf8');
async function fixture(t, source = example) {
  const directory = await mkdtemp(join(tmpdir(), 'requester-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'config.yml');
  await writeFile(path, source);
  return path;
}

test('valid example loads and each execution reads the file again', async (t) => {
  const path = await fixture(t);
  assert.equal((await loadConfig(path)).instances.length, 2);
  await writeFile(path, example.replace('dryRun: true', 'dryRun: false'));
  assert.equal((await loadConfig(path)).dryRun, false);
});

test('missing config fails clearly without creating a file', async (t) => {
  const path = await fixture(t);
  await rm(path);
  await assert.rejects(loadConfig(path), /Configuration file not found/);
  await assert.rejects(readFile(path), { code: 'ENOENT' });
});

test('invalid YAML never echoes credentials', async (t) => {
  const path = await fixture(t, 'apiKey: [TOP_SECRET');
  await assert.rejects(loadConfig(path), (error) => error.message === 'Invalid YAML syntax in configuration file.');
});

test('disabled instances require a name and enabled flag but no connections or translation', async (t) => {
  const path = await fixture(t);
  const config = await loadConfig(path);
  config.instances = [{ name: 'Offline', enabled: false, bazarr: { url: 'invalid' } }];
  await writeFile(path, stringify(config));
  assert.equal((await loadConfig(path)).instances[0].enabled, false);
  config.instances[0].enabled = true;
  await writeFile(path, stringify(config));
  await assert.rejects(loadConfig(path), /instances\[0\].bazarr.apiKey/);
});

for (const services of [[], ['sonarr'], ['radarr'], ['sonarr', 'radarr']]) {
  test(`single Bazarr instance with optional services: ${services.join(',') || 'none'}`, async (t) => {
    const path = await fixture(t);
    const config = await loadConfig(path);
    const instance = config.instances[0];
    for (const service of ['sonarr', 'radarr']) if (!services.includes(service)) delete instance[service];
    config.instances = [instance];
    await writeFile(path, stringify(config));
    assert.deepEqual(await loadConfig(path), config);
  });
}

test('invalid types and values fail with field-specific, secret-free diagnostics', async (t) => {
  const path = await fixture(t);
  const base = await loadConfig(path);
  const changed = (change) => { const config = structuredClone(base); change(config); return config; };
  const cases = [
    [null, 'root'],
    [changed((c) => { c.instances = {}; }), 'instances'],
    [changed((c) => { c.instances[0] = null; }), 'instances[0]'],
    [changed((c) => { c.instances[0].name = ''; }), 'name'],
    [changed((c) => { c.instances[0].enabled = 'true'; }), 'enabled'],
    [changed((c) => { c.instances[1].name = c.instances[0].name; }), 'unique'],
    [changed((c) => { c.instances[0].translation = null; }), 'translation'],
    ...['sourceLanguage', 'targetLanguage'].map((key) => [changed((c) => { c.instances[0].translation[key] = ''; }), key]),
    [changed((c) => { delete c.instances[0].bazarr; }), 'bazarr'],
    [changed((c) => { c.logging = { level: 'TOP_SECRET' }; }), 'logging.level'],
    [changed((c) => { c.dryRun = 'true'; }), 'dryRun'],
  ];
  for (const service of ['bazarr', 'sonarr', 'radarr']) {
    cases.push([changed((c) => { c.instances[0][service] = null; }), service]);
    cases.push([changed((c) => { c.instances[0][service].apiKey = ''; }), 'apiKey']);
    for (const url of ['ftp://TOP_SECRET', ['http://example.org'], 'https://user:TOP_SECRET@example.org', 'http://example.org/?apikey=TOP_SECRET']) {
      cases.push([changed((c) => { c.instances[0][service].url = url; }), 'url']);
    }
  }
  for (const [config, field] of cases) {
    await writeFile(path, stringify(config));
    await assert.rejects(loadConfig(path), (error) => error.message.includes(field) && !error.message.includes('TOP_SECRET'));
  }
});

test('old root settings produce a migration error without rewriting the configuration', async (t) => {
  const path = await fixture(t);
  for (const key of ['bazarr', 'sonarr', 'radarr', 'translation', 'scheduleCron', 'minimumAgeHours']) {
    const source = stringify({ [key]: 'TOP_SECRET' });
    await writeFile(path, source);
    await assert.rejects(loadConfig(path), (error) => /migration required.*instances/.test(error.message) && !error.message.includes('TOP_SECRET'));
    assert.equal(await readFile(path, 'utf8'), source);
  }
});

test('logging filters levels and redacts API keys even in instance names', (t) => {
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(JSON.parse(line)));
  const logger = createLogger('info', ['TOP_SECRET']);
  logger.debug('hidden');
  logger.info('Instance TOP_SECRET');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].message, 'Instance [REDACTED]');
});


test('each environment preserves its own translation and connection settings', async (t) => {
  const path = await fixture(t);
  const config = await loadConfig(path);
  config.instances[1].enabled = true;
  config.instances[1].translation.targetLanguage = 'de';
  await writeFile(path, stringify(config));
  const loaded = await loadConfig(path);
  assert.equal(loaded.instances[0].translation.targetLanguage, 'nl');
  assert.equal(loaded.instances[1].translation.targetLanguage, 'de');
  assert.notEqual(loaded.instances[0].bazarr.url, loaded.instances[1].bazarr.url);
});

test('onlyEmbedded defaults to true, accepts booleans and rejects other values', async (t) => {
  const path = await fixture(t);
  const config = await loadConfig(path);
  for (const value of [undefined, true, false, 'true', null, 1]) {
    config.instances[0].translation.onlyEmbedded = value;
    await writeFile(path, stringify(config));
    if (value === undefined || typeof value === 'boolean') assert.equal((await loadConfig(path)).instances[0].translation.onlyEmbedded, value ?? true);
    else await assert.rejects(loadConfig(path), /onlyEmbedded/);
  }
});
test('excludeHI defaults to false independently per instance and accepts only booleans', async (t) => {
  const path = await fixture(t); const config = await loadConfig(path);
  assert.equal(config.instances[0].translation.excludeHI, false);
  config.instances[1].enabled = true;
  config.instances[0].translation.excludeHI = true;
  config.instances[1].translation.excludeHI = false;
  await writeFile(path, stringify(config));
  const loaded = await loadConfig(path);
  assert.equal(loaded.instances[0].translation.excludeHI, true);
  assert.equal(loaded.instances[1].translation.excludeHI, false);
  for (const value of ['true', null, 1]) {
    config.instances[0].translation.excludeHI = value;
    await writeFile(path, stringify(config));
    await assert.rejects(loadConfig(path), /excludeHI/);
  }
});
test('language identifiers must be two or three letters and are never silently defaulted', async (t) => {
  const path = await fixture(t); const config = await loadConfig(path);
  for (const value of [undefined, '', 'English', 'pt-BR', 12]) {
    config.instances[0].translation.sourceLanguage = value;
    await writeFile(path, stringify(config)); await assert.rejects(loadConfig(path), /sourceLanguage/);
  }
});
