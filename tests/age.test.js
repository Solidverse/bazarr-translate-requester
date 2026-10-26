import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgeFilter, fileAgeOutcome } from '../src/age.js';
const referenceTime = Date.parse('2026-10-26T00:00:00Z');
const result = (data) => ({ response: new Response(), data });
const instance = { name: 'HD', sonarr: { url: 'http://sonarr.invalid/base', apiKey: 'S_KEY' }, radarr: { url: 'http://radarr.invalid/base', apiKey: 'R_KEY' } };
for (const [date, days, expected] of [['2026-10-25T00:00:00Z',7,'recent'], ['2026-10-19T00:00:00Z',7,'candidate'], ['2026-10-12T00:00:00Z',7,'candidate'], ['2026-10-26T00:00:00Z',0,'candidate'], ['2026-10-19T00:00:01Z',7,'recent'], ['2026-10-19T01:00:00+01:00',7,'candidate'], [undefined,7,'unknownAge'], ['2026-02-30T00:00:00Z',7,'unknownAge'], ['2026-10-19',7,'unknownAge'], ['2026-10-27T00:00:00Z',7,'unknownAge']]) {
  test(`file import age: ${date} / ${days}`, () => assert.equal(fileAgeOutcome(date, days, referenceTime), expected));
}
test('Radarr uses current nested movie file instead of original addition, in one bulk call', async () => {
  let calls = 0;
  const filter = createAgeFilter(instance, { minAge: 7, referenceTime, radarrFactory: (options) => {
    assert.equal(options.baseUrl, instance.radarr.url); assert.equal(options.apiKey === instance.radarr.apiKey,true);
    return { getMovies: async () => { calls++; return result([
      { id: 1, hasFile: true, movieFileId: 10, added: '2020-01-01T00:00:00Z', movieFile: { id: 10, movieId: 1, dateAdded: '2026-10-25T00:00:00Z' } },
      { id: 2, hasFile: true, movieFile: { id: 20, movieId: 2, dateAdded: '2026-10-10T00:00:00Z' } },
      { id: 3, hasFile: true, movieFileId: 31, movieFile: { id: 30, movieId: 3, dateAdded: '2026-10-10T00:00:00Z' } },
    ]); } };
  } });
  assert.equal(await filter({ type:'movie', mediaId:1 }), 'recent');
  assert.equal(await filter({ type:'movie', mediaId:2 }), 'candidate');
  assert.equal(await filter({ type:'movie', mediaId:3 }), 'unknownAge');
  assert.equal(await filter({ type:'movie', mediaId:999 }), 'unknownAge');
  assert.equal(calls,1);
});
test('Sonarr joins episodeFileId to bulk current file records for the same series', async () => {
  const calls = [];
  const filter = createAgeFilter(instance, { minAge: 7, referenceTime, sonarrFactory: () => ({
    getEpisodes: async (seriesId) => { calls.push(['episodes',seriesId]); return result([{ id:1, seriesId, hasFile:true, episodeFileId:10 }, { id:2, seriesId, hasFile:true, episodeFileId:20 }]); },
    getEpisodeFiles: async (seriesId) => { calls.push(['files',seriesId]); return result([{ id:10, seriesId, dateAdded:'2026-10-10T00:00:00Z' }, { id:20, seriesId:999, dateAdded:'2026-10-10T00:00:00Z' }]); },
  }) });
  assert.equal(await filter({ type:'episode', mediaId:1, seriesId:5 }), 'candidate');
  assert.equal(await filter({ type:'episode', mediaId:2, seriesId:5 }), 'unknownAge');
  assert.equal(calls.length,2); assert.ok(calls.every(([,id]) => id === 5));
});
for (const failure of ['network','http','structure']) test(`age retrieval ${failure} aborts with sanitized diagnostics`, async () => {
  const filter = createAgeFilter(instance, { minAge:7, referenceTime, radarrFactory: () => ({ getMovies: async () => {
    if (failure === 'network') throw new Error('SECRET http://private.invalid');
    return failure === 'http' ? { response:new Response('SECRET',{status:403}), error:'SECRET' } : result({});
  } }) });
  await assert.rejects(filter({type:'movie',mediaId:1}), (error) => /Radarr GET.*no batch written/.test(error.message) && !/SECRET|private.invalid/.test(error.message));
});
test('SDK age transport uses only status-free bulk GETs with the nested instance credentials', async (t) => {
  const calls=[];
  t.mock.method(globalThis,'fetch',async (request) => {
    const url=new URL(request.url);calls.push(url.pathname);assert.equal(request.method,'GET');assert.equal(request.body,null);
    assert.equal(request.headers.get('X-Api-Key') === (url.host==='radarr.invalid' ? 'R_KEY' : 'S_KEY'),true);
    if(url.pathname.endsWith('/movie'))return Response.json([{id:1,hasFile:true,movieFile:{id:10,movieId:1,dateAdded:'2026-10-10T00:00:00Z'}}]);
    assert.equal(url.searchParams.get('seriesId'),'5');
    return Response.json(url.pathname.endsWith('/episode') ? [{id:2,seriesId:5,hasFile:true,episodeFileId:20}] : [{id:20,seriesId:5,dateAdded:'2026-10-10T00:00:00Z'}]);
  });
  const filter=createAgeFilter(instance,{minAge:7,referenceTime});
  assert.equal(await filter({type:'movie',mediaId:1}),'candidate');
  assert.equal(await filter({type:'episode',mediaId:2,seriesId:5}),'candidate');
  assert.equal(calls.length,3);
});
