import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BazarrClient } from 'tsarr/bazarr';

// Serialization experiment only. This transport never contacts a server.
for (const type of ['movie', 'episode']) {
  test(`Tsarr preserves embedded ${type} translation parameters through patchSubtitles`, async (t) => {
    let captured;
    t.mock.method(globalThis, 'fetch', async (request) => {
      captured = request;
      return new Response(null, { status: 204 });
    });
    const client = new BazarrClient({ baseUrl: 'http://bazarr.invalid', apiKey: 'MOCK_KEY' });
    const query = { action: 'translate', language: 'nl', type, id: 123,
      subtitles_id: 456, forced: 'False', hi: 'False', original_format: 'True' };
    const result = await client.applySubtitleMods({ query });
    assert.equal(result.response.status, 204);
    assert.equal(result.error, undefined);
    assert.equal(captured.method, 'PATCH');
    const url = new URL(captured.url);
    assert.equal(url.pathname, '/api/subtitles');
    assert.deepEqual(Object.fromEntries(url.searchParams), Object.fromEntries(Object.entries(query).map(([key, value]) => [key, String(value)])));
    assert.equal(captured.headers.get('X-API-KEY') === 'MOCK_KEY', true);
    assert.equal(captured.body, null);
    assert.equal(url.searchParams.has('apikey'), false);
    assert.equal(url.searchParams.has('path'), false);
  });
}

test('mocked embedded bitmap rejection remains an SDK error with HTTP 415 and no retry', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (request) => {
    calls++; assert.equal(request.method, 'PATCH');
    assert.equal(new URL(request.url).searchParams.get('subtitles_id'), '456');
    return Response.json({ message: 'Image based embedded subtitles cannot be extracted' }, { status: 415 });
  });
  const client = new BazarrClient({ baseUrl: 'http://bazarr.invalid', apiKey: 'MOCK_KEY' });
  const result = await client.applySubtitleMods({ query: { action: 'translate', language: 'nl', type: 'movie', id: 123, subtitles_id: 456 } });
  assert.equal(result.response.status, 415); assert.notEqual(result.error, undefined);
  assert.equal(result.data, undefined); assert.equal(calls, 1);
});
