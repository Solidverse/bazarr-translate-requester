import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse, stringify } from 'yaml';
import { processRequests } from '../src/request.js';
import { openRequestBatch } from '../src/request-batch.js';

const catalog = [['en','eng'],['nl','nld'],['es','spa'],['de','deu'],['fr','fra']].map(([code2,code3])=>({code2,code3}));
const track = (id, extra={}) => ({id,source:'embedded',language:'en',hi:false,forced:false,codec:'unknown',embedded_track_id:id+1,...extra});
const entry = (mediaId, extra={}) => ({instance:'HD',type:'movie',title:`Movie ${mediaId}`,mediaId,sourceLanguage:'en',targetLanguage:'nl',selectedSubtitleId:11,tracks:[track(11),track(22,{hi:true})],...extra});
const environment = (name='HD', sourceLanguage='en', targetLanguage='nl') => ({name,enabled:true,bazarr:{url:'http://bazarr.invalid',apiKey:'TOP_SECRET'},translation:{sourceLanguage,targetLanguage,onlyEmbedded:true}});
const metadata = (e, changes={}) => ({radarrId:e.mediaId,sonarrEpisodeId:e.mediaId,sonarrSeriesId:e.seriesId,title:e.title,path:'/media.mkv',profileId:7,
  subtitles:e.tracks.map(t=>({id:t.id,code2:t.language,hi:t.hi,forced:t.forced,codec:t.codec,format:t.format,
    path:t.source==='embedded'?null:t.path,embedded_track_id:t.source==='embedded'?t.embedded_track_id:null})),...changes});
async function fixture(t, entries=[entry(1),entry(2)], {dryRun=false,instances=[environment()]}={}) {
  const directory=await mkdtemp(join(tmpdir(),'bazarr-request-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const path=join(directory,'requests.yml');await writeFile(path,stringify({requests:entries}));
  const lines=[],calls=[],submitted=[];
  const logger=Object.fromEntries(['info','warn','error','debug'].map(level=>[level,line=>lines.push(line)]));
  const data=new Map(entries.map(e=>[`${e.instance}:${e.mediaId}`,metadata(e)]));
  const factory=connection=>({
    getLanguages:async()=>{calls.push(['languages',connection.name]);return catalog;},
    getSubtitleVisibility:async()=>({complete:true,showOnlyDesiredLanguages:false}),
    getLanguageProfiles:async()=>[{profileId:7,items:[{language:'en'},{language:'nl'}]}],
    getMovie:async id=>{calls.push(['movie',id,connection.name]);return data.get(`${connection.name}:${id}`)??null;},
    getEpisodes:async({episodeIds})=>{calls.push(['episode',episodeIds[0]]);const m=data.get(`${connection.name}:${episodeIds[0]}`);return m?[m]:[];},
    getSeriesById:async id=>({sonarrSeriesId:id,profileId:7}),
    submitTranslation:async(request,options)=>{submitted.push({request,options});return {accepted:true,httpStatus:204};},
  });
  const config={instances,dryRun,logging:{level:'info'}};
  return {directory,path,lines,calls,submitted,data,factory,config,
    run:(options={},dependencies={})=>processRequests(config,options,{logger,configPath:join(directory,'config.yml'),bazarrFactory:factory,...dependencies})};
}

test('manual HI selection is respected, entries submit sequentially and cleanup precedes the next media read',async t=>{
  const entries=[entry(1,{selectedSubtitleId:22}),entry(2,{selectedSubtitleId:22})];const f=await fixture(t,entries);
  const base=f.factory;let active=0;let sent=0;
  const result=await f.run({}, {bazarrFactory:c=>{
    const client=base(c);
    return {...client,getMovie:async id=>{
      const current=parse(await readFile(f.path,'utf8')).requests;
      assert.equal(current.length,id===1?2:1);return client.getMovie(id);
    },submitTranslation:async(r,o)=>{
      active++;assert.equal(active,1);assert.equal(r.track.id,22);assert.equal(r.track.hi,true);assert.equal(o.dryRun,false);
      await new Promise(resolve=>setImmediate(resolve));active--;sent++;return {accepted:true,httpStatus:204};
    }};
  }});
  assert.equal(sent,2);assert.equal(result.accepted,2);assert.equal(result.remaining,0);
  await assert.rejects(readFile(f.path),{code:'ENOENT'});assert.deepEqual(await readdir(f.directory),[]);
  assert.match(f.lines.join(),/Accepted: subtitle 22/);assert.doesNotMatch(f.lines.join(),/Completed|TOP_SECRET/);
});

test('dry-run validates read-only and leaves exact batch bytes, timestamp and manual choices untouched',async t=>{
  const f=await fixture(t,[entry(1,{selectedSubtitleId:22})],{dryRun:true});const before=await readFile(f.path,'utf8');const timestamp=(await stat(f.path)).mtimeMs;
  const result=await f.run();assert.equal(result.planned,1);assert.equal(result.attempts,0);assert.equal(f.submitted.length,0);
  assert.equal(await readFile(f.path,'utf8'),before);assert.equal((await stat(f.path)).mtimeMs,timestamp);
  assert.deepEqual(await readdir(f.directory),['requests.yml']);assert.match(f.lines.join(),/DRY_RUN would request/);
});

test('max limits submission attempts rather than skipped entries, and limits dry-run planning',async t=>{
  const f=await fixture(t,[entry(1,{instance:'Missing'}),entry(2),entry(3)]);
  const result=await f.run({max:1});assert.equal(result.accepted,1);assert.equal(result.skipped,1);assert.equal(result.attempts,1);
  assert.deepEqual(parse(await readFile(f.path,'utf8')).requests.map(e=>e.mediaId),[1,3]);
  const dry=await fixture(t,[entry(1),entry(2)],{dryRun:true});const planned=await dry.run({max:1});
  assert.equal(planned.planned,1);assert.equal(dry.calls.filter(([op])=>op==='movie').length,1);
});

for(const [status,uncertain] of [[415,false],[403,false],[500,true],[408,true]])test(`HTTP ${status} retains failed entry and continues unrelated requests`,async t=>{
  const f=await fixture(t);let calls=0;
  const result=await f.run({}, {bazarrFactory:c=>({...f.factory(c),submitTranslation:async()=>{
    calls++;if(calls===1)throw Object.assign(new Error('TOP_SECRET secret body'),{httpStatus:status,operation:'PATCH /api/subtitles',uncertain});
    return {accepted:true,httpStatus:204};
  }})});
  assert.equal(result.accepted,1);assert.equal(result.remaining,1);assert.equal(result[uncertain?'uncertain':'failed'],1);
  assert.equal(parse(await readFile(f.path,'utf8')).requests[0].mediaId,1);assert.equal(calls,2);
  assert.doesNotMatch(f.lines.join(),/TOP_SECRET|secret body/);assert.match(f.lines.join(),new RegExp(`HTTP ${status}`));
});

for(const mode of ['network','unconfirmed'])test(`ambiguous ${mode} is retained with a duplicate warning and never retried`,async t=>{
  const f=await fixture(t,[entry(1)]);let calls=0;
  const result=await f.run({}, {bazarrFactory:c=>({...f.factory(c),submitTranslation:async()=>{calls++;if(mode==='network')throw new Error('TOP_SECRET');return {accepted:true,httpStatus:200};}})});
  assert.equal(calls,1);assert.equal(result.uncertain,1);assert.equal(result.accepted,0);
  assert.equal(parse(await readFile(f.path,'utf8')).requests.length,1);assert.match(f.lines.join(),/Possible duplicate submission.*verify Bazarr manually/);
});

for(const [kind,mutate,reason] of [
  ['missing media',f=>f.data.delete('HD:1'),'media no longer exists'],
  ['target forced',f=>f.data.get('HD:1').subtitles.push({code2:'nl',forced:true,hi:true}),'target-language subtitle'],
  ['missing selected subtitle',f=>{f.data.get('HD:1').subtitles=f.data.get('HD:1').subtitles.filter(s=>s.id!==11);},'manually selected subtitle'],
  ['forced selected subtitle',f=>{f.data.get('HD:1').subtitles[0].forced=true;},'manually selected subtitle'],
  ['bitmap selected subtitle',f=>{f.data.get('HD:1').subtitles[0].codec='pgs';},'manually selected subtitle'],
  ['changed languages',f=>{f.config.instances[0].translation.targetLanguage='de';},'languages no longer match'],
  ['disabled instance',f=>{f.config.instances[0].enabled=false;},'unknown or disabled'],
])test(`${kind} is retained without choosing a different track`,async t=>{
  const f=await fixture(t,[entry(1)]);mutate(f);const before=await readFile(f.path,'utf8');
  const result=await f.run();assert.equal(result.skipped,1);assert.equal(f.submitted.length,0);
  assert.equal(await readFile(f.path,'utf8'),before);assert.match(f.lines.join(),new RegExp(reason));
});

test('external track source/path and onlyEmbedded are revalidated from fresh metadata',async t=>{
  const external=track(33,{source:'external',language:'fr',path:'/source.fr.srt',embedded_track_id:undefined});
  const instance=environment('French','fr','en');instance.translation.onlyEmbedded=false;
  const f=await fixture(t,[entry(1,{instance:'French',sourceLanguage:'fra',targetLanguage:'eng',selectedSubtitleId:33,tracks:[external]})],{instances:[instance]});
  const result=await f.run();assert.equal(result.accepted,1);assert.equal(f.submitted[0].request.targetLanguage,'en');assert.equal(f.submitted[0].request.track.path,'/source.fr.srt');
  const disallowed=await fixture(t,[entry(1,{selectedSubtitleId:33,tracks:[{...external,language:'en'}]})]);
  assert.equal((await disallowed.run()).skipped,1);assert.equal(disallowed.submitted.length,0);
});

test('episodes use parent-series profiles and cannot migrate to another series',async t=>{
  const ep=entry(2,{type:'episode',seriesId:5});const f=await fixture(t,[ep]);
  const result=await f.run({}, {bazarrFactory:c=>({...f.factory(c),getSubtitleVisibility:async()=>({complete:false,showOnlyDesiredLanguages:true})})});
  assert.equal(result.accepted,1);assert.equal(f.submitted[0].request.mediaType,'episode');
  const moved=await fixture(t,[ep]);moved.data.get('HD:2').sonarrSeriesId=999;
  assert.equal((await moved.run()).skipped,1);assert.equal(moved.submitted.length,0);
});

test('unknown/insufficient visibility and changed selected paths remain retained',async t=>{
  const f=await fixture(t,[entry(1)]);
  const result=await f.run({}, {bazarrFactory:c=>({...f.factory(c),getSubtitleVisibility:async()=>({complete:false,showOnlyDesiredLanguages:true}),getLanguageProfiles:async()=>[{profileId:7,items:[{language:'en'}]}]})});
  assert.equal(result.skipped,1);assert.equal(f.submitted.length,0);
});

test('partial cleanup preserves remaining order, numeric-string selection, comments and extra review metadata',async t=>{
  const f=await fixture(t,[entry(1),entry(2,{selectedSubtitleId:'22',reviewNote:'keep me'}),entry(3)]);
  await writeFile(f.path,'# My review\n'+stringify({requests:[entry(1),entry(2,{selectedSubtitleId:'22',reviewNote:'keep me'}),entry(3)]}));
  await f.run({max:1});const remaining=await readFile(f.path,'utf8');
  assert.match(remaining,/# My review/);assert.deepEqual(parse(remaining).requests.map(e=>e.mediaId),[2,3]);
  assert.equal(parse(remaining).requests[0].selectedSubtitleId,'22');assert.equal(parse(remaining).requests[0].reviewNote,'keep me');
});

test('cleanup failure after acceptance is fatal, preserves batch and stops subsequent submissions',async t=>{
  const f=await fixture(t);const before=await readFile(f.path,'utf8');
  await assert.rejects(f.run({}, {batchFactory:async path=>{const batch=await openRequestBatch(path);return {...batch,removeAccepted:async()=>{throw new Error('simulated filesystem failure');}};}}),error=>error.summary.accepted===1&&error.mediaId===1);
  assert.equal(f.submitted.length,1);assert.equal(await readFile(f.path,'utf8'),before);assert.match(f.lines.join(),/CRITICAL.*accepted but batch cleanup failed/);
});

test('manual edits during the HTTP call are not overwritten and cause a fatal stop',async t=>{
  const f=await fixture(t);const edited=stringify({requests:[entry(2,{selectedSubtitleId:22})]});
  await assert.rejects(f.run({}, {bazarrFactory:c=>({...f.factory(c),submitTranslation:async()=>{await writeFile(f.path,edited);return {accepted:true,httpStatus:204};}})}),/could not be removed safely/);
  assert.equal(await readFile(f.path,'utf8'),edited);
});

test('concurrent requester execution is rejected without a second submission',async t=>{
  const f=await fixture(t,[entry(1)]);let unblock;let entered;
  const ready=new Promise(resolve=>{entered=resolve;});const pending=new Promise(resolve=>{unblock=resolve;});
  const running=f.run({}, {bazarrFactory:c=>({...f.factory(c),submitTranslation:async()=>{entered();await pending;return {accepted:true,httpStatus:204};}})});
  await ready;await assert.rejects(f.run(),/Another requester holds/);unblock();await running;
  assert.deepEqual(await readdir(f.directory),[]);
});

test('empty batches are removed only in live mode',async t=>{
  const live=await fixture(t,[]);assert.equal((await live.run()).remaining,0);await assert.rejects(readFile(live.path),{code:'ENOENT'});
  const dry=await fixture(t,[],{dryRun:true});assert.equal((await dry.run()).remaining,0);assert.deepEqual(parse(await readFile(dry.path,'utf8')),{requests:[]});
});

test('interruption finishes current acceptance/cleanup before stopping, without another submission',async t=>{
  const f=await fixture(t);const controller=new AbortController();
  const result=await f.run({}, {signal:controller.signal,bazarrFactory:c=>({...f.factory(c),submitTranslation:async()=>{controller.abort();return {accepted:true,httpStatus:204};}})});
  assert.equal(result.accepted,1);assert.equal(result.interrupted,true);assert.equal(result.remaining,1);
  assert.deepEqual(parse(await readFile(f.path,'utf8')).requests.map(e=>e.mediaId),[2]);
});

test('max also counts failed submission attempts and does not validate further entries',async t=>{
  const f=await fixture(t);const result=await f.run({max:1},{bazarrFactory:c=>({...f.factory(c),submitTranslation:async()=>{throw Object.assign(new Error('refused'),{httpStatus:415,uncertain:false});}})});
  assert.equal(result.attempts,1);assert.equal(result.failed,1);assert.equal(f.calls.filter(([op])=>op==='movie').length,1);
  assert.equal(parse(await readFile(f.path,'utf8')).requests.length,2);
});

test('read failures retain affected requests and allow unrelated requests to continue',async t=>{
  const f=await fixture(t);const result=await f.run({}, {bazarrFactory:c=>({...f.factory(c),getMovie:async id=>{
    if(id===1)throw Object.assign(new Error('TOP_SECRET response body'),{httpStatus:403,operation:'GET /api/movies'});return f.data.get('HD:2');
  }})});
  assert.equal(result.failed,1);assert.equal(result.accepted,1);assert.equal(result.attempts,1);
  assert.match(f.lines.join(),/GET \/api\/movies: HTTP 403/);assert.doesNotMatch(f.lines.join(),/TOP_SECRET|response body/);
});

test('instances with distinct language pairs and repeated numeric IDs remain independent',async t=>{
  const entries=[entry(1),entry(1,{instance:'Spanish',sourceLanguage:'es',targetLanguage:'de',tracks:[track(11,{language:'es'})]})];
  const f=await fixture(t,entries,{instances:[environment(),environment('Spanish','es','de')]});const result=await f.run();
  assert.equal(result.accepted,2);assert.deepEqual(f.submitted.map(s=>s.request.targetLanguage),['nl','de']);
  assert.deepEqual(f.calls.filter(([op])=>op==='languages').map(([,name])=>name),['HD','Spanish']);
});

test('changed external paths or recorded bitmap flags do not authorize another source',async t=>{
  for(const kind of ['path','bitmap']){
    const e=entry(1,{selectedSubtitleId:33,tracks:[track(33,{source:'external',path:'/old.srt',embedded_track_id:undefined,...(kind==='bitmap'?{codec:'pgs'}:{})})]});
    const instance=environment();instance.translation.onlyEmbedded=false;const f=await fixture(t,[e],{instances:[instance]});
    if(kind==='path')f.data.get('HD:1').subtitles[0].path='/new.srt';
    else delete f.data.get('HD:1').subtitles[0].codec;
    assert.equal((await f.run()).skipped,1);assert.equal(f.submitted.length,0);
  }
});

test('filtered language profiles are freshly revalidated for each submission',async t=>{
  const f=await fixture(t);let profileReads=0;
  const result=await f.run({}, {bazarrFactory:c=>({...f.factory(c),
    getSubtitleVisibility:async()=>({complete:false,showOnlyDesiredLanguages:true}),
    getLanguageProfiles:async()=>[{profileId:7,items:++profileReads===1?[{language:'en'},{language:'nl'}]:[{language:'en'}]}],
  })});
  assert.equal(result.accepted,1);assert.equal(result.skipped,1);assert.equal(profileReads,2);
  assert.deepEqual(parse(await readFile(f.path,'utf8')).requests.map(e=>e.mediaId),[2]);
});

test('end-to-end SDK requester uses only filtered metadata and sequential translate PATCHes, with cleanup between responses',async t=>{
  const {createBazarrClient}=await import('../src/bazarr.js');
  const external=track(33,{source:'external',path:'/media/example.en.srt',embedded_track_id:undefined});
  const instance=environment();instance.translation.onlyEmbedded=false;
  const f=await fixture(t,[entry(1,{selectedSubtitleId:22}),entry(2,{selectedSubtitleId:33,tracks:[external]})],{instances:[instance]});
  const calls=[];let patches=0;
  t.mock.method(globalThis,'fetch',async request=>{
    const url=new URL(request.url);calls.push([request.method,url.pathname]);
    assert.equal(request.body,null);assert.equal(request.headers.get('X-API-KEY')==='TOP_SECRET',true);
    if(request.method==='PATCH'){
      assert.equal(url.pathname,'/api/subtitles');assert.equal(url.searchParams.get('action'),'translate');
      const batch=parse(await readFile(f.path,'utf8')).requests;assert.equal(batch.length,2-patches);
      if(patches===0){assert.equal(url.searchParams.get('subtitles_id'),'22');assert.equal(url.searchParams.get('hi'),'True');assert.equal(url.searchParams.has('path'),false);}
      else {assert.equal(url.searchParams.get('path'),external.path);assert.equal(url.searchParams.has('subtitles_id'),false);}
      patches++;return new Response(null,{status:204});
    }
    assert.equal(request.method,'GET');
    if(url.pathname==='/api/system/languages')return Response.json(catalog);
    if(url.pathname==='/api/system/settings')return Response.json({general:{embedded_subs_show_desired:true},auth:{apikey:'PRIVATE_SETTINGS_KEY'}});
    if(url.pathname==='/api/system/languages/profiles')return Response.json([{profileId:7,items:[{language:'en'},{language:'nl'}]}]);
    if(url.pathname==='/api/movies'){
      const ids=url.searchParams.getAll('radarrid[]');assert.equal(ids.length,1);const id=Number(ids[0]);return Response.json({data:[f.data.get(`HD:${id}`)],total:1});
    }
    assert.fail('Unexpected metadata, job-polling or provider endpoint');
  });
  const result=await f.run({}, {bazarrFactory:createBazarrClient});
  assert.equal(result.accepted,2);assert.equal(result.remaining,0);assert.equal(patches,2);
  assert.equal(calls.filter(([,path])=>path==='/api/system/languages').length,1);
  assert.doesNotMatch(f.lines.join(),/TOP_SECRET|PRIVATE_SETTINGS_KEY/);
  await assert.rejects(readFile(f.path),{code:'ENOENT'});
});
