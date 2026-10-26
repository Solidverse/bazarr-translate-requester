import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { main } from '../src/index.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'bazarr-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'config.yml');
  await writeFile(path, await readFile(new URL('../config.example.yml', import.meta.url)));
  return { directory, path };
}
function capture(t) {
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(line));
  t.mock.method(console, 'error', (line) => lines.push(line));
  return lines;
}
for (const operation of ['generate', 'request']) {
  test(`${operation} validates config, reports scaffold and makes no network or batch writes`, async (t) => {
    const { path, directory } = await fixture(t);
    const lines = capture(t);
    const network = t.mock.method(globalThis, 'fetch', () => { throw new Error('Network forbidden'); });
    assert.equal(await main([operation], { configPath: path }), 0);
    assert.deepEqual(await readdir(directory), ['config.yml']);
    const batch = join(directory, 'requests.yml');
    const existing = 'requests:\n  - title: Keep this entry\n';
    await writeFile(batch, existing);
    const before = await stat(batch);
    assert.equal(await main([operation], { configPath: path }), 0);
    assert.equal(await readFile(batch, 'utf8'), existing);
    assert.equal((await stat(batch)).mtimeMs, before.mtimeMs);
    assert.equal(network.mock.callCount(), 0);
    assert.match(lines.join('\n'), /not implemented yet/);
    assert.match(lines.join('\n'), new RegExp(`Operation: ${operation}`));
    assert.doesNotMatch(lines.join('\n'), /YOUR_BAZARR_HD_API_KEY|YOUR_SONARR_HD_API_KEY|YOUR_RADARR_HD_API_KEY|YOUR_BAZARR_4K_API_KEY/);
  });
  test(`${operation} exits nonzero for missing or invalid configuration`, async (t) => {
    const { path } = await fixture(t); const lines = capture(t);
    await rm(path); assert.equal(await main([operation], { configPath: path }), 1);
    await writeFile(path, 'apiKey: [TOP_SECRET');
    assert.equal(await main([operation], { configPath: path }), 1);
    assert.match(lines.join('\n'), /Configuration file not found/);
    assert.match(lines.join('\n'), /Invalid YAML/);
    assert.doesNotMatch(lines.join('\n'), /TOP_SECRET/);
  });
  test(`${operation} scaffold terminates as a separate process`, async (t) => {
    const { path } = await fixture(t);
    const source = `import {main} from './src/index.js'; process.exitCode=await main([${JSON.stringify(operation)}],{configPath:process.argv[1]});`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source, path], { cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 5000 });
    assert.ifError(result.error); assert.equal(result.status, 0);
    assert.match(result.stdout, /not implemented yet/);
  });
}
test('help and npm start usage need no configuration; invalid commands fail safely', async (t) => {
  const lines = capture(t);
  assert.equal(await main([]), 0); assert.equal(await main(['help']), 0);
  assert.equal(await main(['--help']), 0);
  assert.equal(await main(['TOP_SECRET']), 1); assert.equal(await main(['generate', 'extra']), 1);
  assert.match(lines.join('\n'), /Usage:/); assert.doesNotMatch(lines.join('\n'), /TOP_SECRET/);
});
test('actual CLI exit codes and npm routing', () => {
  for (const [args, expected] of [[[], 0], [['help'], 0], [['invalid'], 1]]) {
    const result = spawnSync(process.execPath, ['src/index.js', ...args], { cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 5000 });
    assert.ifError(result.error); assert.equal(result.status, expected);
  }
});

test('inspect routes to the read-only operation with validated multi-instance config', async (t) => {
  const { path } = await fixture(t); capture(t); let calls = 0;
  assert.equal(await main(['inspect'], { configPath: path, inspect: async (config) => {
    calls++; assert.equal(config.instances.length, 2); return { failed: false };
  } }), 0);
  assert.equal(calls, 1);
  assert.equal(await main(['inspect'], { configPath: path, inspect: async () => ({ failed: true }) }), 1);
});

test('services command routes with nested config and reflects inspection failures', async (t) => {
  const { path } = await fixture(t); capture(t);
  const network = t.mock.method(globalThis, 'fetch', () => assert.fail('Routing must not make requests'));
  let calls = 0;
  assert.equal(await main(['services'], { configPath: path, servicesInspect: async (config) => {
    calls++; assert.equal(config.instances[0].sonarr.apiKey, 'YOUR_SONARR_HD_API_KEY'); return { failed: false };
  } }), 0);
  assert.equal(calls, 1);
  assert.equal(await main(['services'], { configPath: path, servicesInspect: async () => ({ failed: true }) }), 1);
  assert.equal(network.mock.callCount(), 0);
});

test('all nested service keys are redacted from CLI diagnostics', async (t) => {
  const { path } = await fixture(t); const lines = capture(t);
  const { parse, stringify } = await import('yaml');
  const config = parse(await readFile(path, 'utf8'));
  config.instances[0].name = 'YOUR_SONARR_HD_API_KEY-YOUR_RADARR_HD_API_KEY-YOUR_BAZARR_HD_API_KEY';
  await writeFile(path, stringify(config));
  assert.equal(await main(['generate'], { configPath: path }), 0);
  assert.doesNotMatch(lines.join(), /YOUR_.*API_KEY/);
});
