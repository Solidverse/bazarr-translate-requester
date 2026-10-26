import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRequestArgs } from '../src/request-options.js';
test('request max is optional and parsed as a positive safe integer', () => {
  assert.deepEqual(parseRequestArgs([]), { max: undefined });
  assert.deepEqual(parseRequestArgs(['--max','1']), { max: 1 });
  assert.deepEqual(parseRequestArgs(['--max=27']), { max: 27 });
});
for (const args of [['--max','0'],['--max','-1'],['--max','1.5'],['--max','9007199254740992'],['--max','TOP_SECRET'],['--max','1','--max','2'],['--max'],['--preview'],['extra']]) {
  test(`invalid request arguments: ${JSON.stringify(args)}`, () => assert.throws(() => parseRequestArgs(args), (error) => !error.message.includes('TOP_SECRET')));
}
