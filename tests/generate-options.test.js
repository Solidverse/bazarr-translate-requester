import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGenerateArgs } from '../src/generate-options.js';

test('default generation, both media selections, series implication and combined arguments', () => {
  assert.deepEqual(parseGenerateArgs([]), { type: undefined, instance: undefined, seriesId: undefined, minAge: undefined, preview: false });
  for (const type of ['movie','series']) assert.equal(parseGenerateArgs(['--type',type]).type, type);
  assert.deepEqual(parseGenerateArgs(['--instance','HD','--series','123','--min-age','7','--preview']), { type: 'series', instance: 'HD', seriesId: 123, minAge: 7, preview: true });
  assert.equal(parseGenerateArgs(['--min-age=0']).minAge, 0);
});
for (const args of [['--type','episode'], ['--series','0'], ['--series','-2'], ['--min-age','-1'], ['--min-age','1.2'], ['--min-age','9007199254740991'], ['--preview=false'], ['--series','1','--type','movie'], ['--instance',''], ['--limit','1'], ['--unknown','TOP_SECRET'], ['--type','movie','--type','series'], ['position'], ['--series']]) {
  test(`invalid arguments fail without echoing input: ${JSON.stringify(args)}`, () => {
    assert.throws(() => parseGenerateArgs(args), (error) => !error.message.includes('TOP_SECRET'));
  });
}
