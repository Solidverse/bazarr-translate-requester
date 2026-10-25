import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('specification status requires no configuration, credentials, instance, network or writes', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'bazarr-spec-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = new URL('../scripts/update-bazarr-openapi.js', import.meta.url).href;
  const before = await readdir(dir);
  const code = `globalThis.fetch=()=>{throw new Error('Network forbidden');}; await import(${JSON.stringify(script)});`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: dir, encoding: 'utf8', timeout: 5000 });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /does not publish a static/); assert.match(result.stdout, /No specification was downloaded/);
  assert.deepEqual(await readdir(dir), before);
});
test('previous documentation is preserved by the specification status command', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'bazarr-spec-existing-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'bazarr-swagger.json'); await writeFile(path, 'existing reference');
  const result = spawnSync(process.execPath, [new URL('../scripts/update-bazarr-openapi.js', import.meta.url).pathname], { cwd: dir, encoding: 'utf8', timeout: 5000 });
  assert.ifError(result.error); assert.equal(result.status, 0);
  assert.equal(await readFile(path, 'utf8'), 'existing reference');
});
