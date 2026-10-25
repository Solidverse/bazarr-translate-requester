import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { loadConfig, validateCron } from '../src/config.js';
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
  assert.equal((await loadConfig(path)).bazarr.length, 2);
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

test('enabled instances require name, URL and key; disabled instances may omit them', async (t) => {
  const path = await fixture(t);
  const config = await loadConfig(path);
  config.bazarr = [{ enabled: false }];
  await writeFile(path, stringify(config));
  assert.equal((await loadConfig(path)).bazarr[0].enabled, false);
  config.bazarr[0].enabled = true;
  await writeFile(path, stringify(config));
  await assert.rejects(loadConfig(path), /bazarr\[0\].name/);
  config.bazarr = [];
  await writeFile(path, stringify(config));
  assert.deepEqual((await loadConfig(path)).bazarr, []);
});

test('invalid types and values fail with field-specific, secret-free diagnostics', async (t) => {
  const path = await fixture(t);
  const base = await loadConfig(path);
  const cases = [
    [null, 'root'],
    [{ ...base, scheduleCron: '* * * * *\nTOP_SECRET' }, 'scheduleCron'],
    [{ ...base, translation: null }, 'translation'],
    [{ ...base, translation: { ...base.translation, minimumAgeHours: -1 } }, 'minimumAgeHours'],
    [{ ...base, translation: { ...base.translation, sourceLanguage: '' } }, 'sourceLanguage'],
    [{ ...base, logging: { level: 'TOP_SECRET' } }, 'logging.level'],
    [{ ...base, dryRun: 'true' }, 'dryRun'],
    [{ ...base, bazarr: {} }, 'bazarr'],
    [{ ...base, bazarr: [{ enabled: 'true' }] }, 'bazarr'],
    [{ ...base, bazarr: [{ ...base.bazarr[0], apiKey: '' }] }, 'apiKey'],
    [{ ...base, bazarr: [{ ...base.bazarr[0], url: 'ftp://TOP_SECRET' }] }, 'url'],
    [{ ...base, bazarr: [{ ...base.bazarr[0], url: ['http://example.org'] }] }, 'url'],
    [{ ...base, bazarr: [{ ...base.bazarr[0], url: 'https://user:TOP_SECRET@example.org' }] }, 'url'],
  ];
  for (const [config, field] of cases) {
    await writeFile(path, stringify(config));
    await assert.rejects(loadConfig(path), (error) => error.message.includes(field) && !error.message.includes('TOP_SECRET'));
  }
});

test('cron accepts numeric five-field Debian syntax', () => {
  for (const value of ['0 */6 * * *', '* * * * *', '0,30 8-18/2 1,15 1-12 0-7', '59 23 31 12 7', ' 0\t0 * * * ']) {
    assert.equal(validateCron(value), true, value);
  }
});

test('cron rejects invalid ranges, extensions, and injection', () => {
  for (const value of [null, '', '* * * *', '* * * * * *', '@hourly', '60 * * * *', '0 24 * * *', '0 0 0 * *', '0 0 * 13 *', '0 0 * * 8', '*/0 * * * *', '*/61 * * * *', '9-2 * * * *', '0/2 * * * *', '0 0 * * MON', '0 0 L * *', '0 0 * * 1#2', '* * * * *\nroot evil', '* * * * *%evil', '* * * * *;evil']) {
    assert.equal(validateCron(value), false, String(value));
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

