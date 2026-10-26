import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, readdir, symlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify } from 'yaml';
import { openRequestBatch } from '../src/request-batch.js';
const entry=()=>({instance:'HD',type:'movie',title:'Example',mediaId:1,sourceLanguage:'en',targetLanguage:'nl',selectedSubtitleId:44,
  tracks:[{id:44,source:'embedded',language:'en',hi:false,forced:false,codec:'unknown',embedded_track_id:5}]});
async function fixture(t,source){const directory=await mkdtemp(join(tmpdir(),'request-batch-'));t.after(()=>rm(directory,{recursive:true,force:true}));const path=join(directory,'requests.yml');if(source!==undefined)await writeFile(path,source);return {path,directory};}
for(const [name,change] of [
  ['missing instance',e=>{delete e.instance;}],['bad media type',e=>{e.type='series';}],['unsafe ID',e=>{e.mediaId=0;}],
  ['missing episode parent',e=>{e.type='episode';}],['missing target',e=>{delete e.targetLanguage;}],
  ['missing selection',e=>{e.selectedSubtitleId=999;}],['missing tracks',e=>{e.tracks=[];}],
  ['duplicate tracks',e=>{e.tracks.push({...e.tracks[0],id:'44'});}],['invalid track ID',e=>{e.tracks[0].id=-1;}],
  ['invalid source kind',e=>{e.tracks[0].source='unknown';}],['missing external path',e=>{e.tracks[0].source='external';}],
])test(`malformed batch is rejected safely before processing: ${name}`,async t=>{
  const e=entry();change(e);const source=stringify({requests:[e]});const f=await fixture(t,source);
  await assert.rejects(openRequestBatch(f.path),/Invalid requests.yml entry/);
  assert.equal(await readFile(f.path,'utf8'),source);assert.deepEqual(await readdir(f.directory),['requests.yml']);
});
for(const source of ['apiKey: [TOP_SECRET','requests: null','requests: {}','requests: []\nrequests: []\n','requests: [&a {instance: TOP_SECRET}, *a]']) {
  test('invalid YAML structure never echoes parser excerpts or credentials',async t=>{
    const f=await fixture(t,source);await assert.rejects(openRequestBatch(f.path),error=>/Invalid requests.yml/.test(error.message)&&!error.message.includes('TOP_SECRET'));
    assert.equal(await readFile(f.path,'utf8'),source);
  });
}
test('duplicate media identities reject the complete batch; instance/type namespaces remain distinct',async t=>{
  const a=entry();const invalid=await fixture(t,stringify({requests:[a,{...structuredClone(a),selectedSubtitleId:'44'}]}));
  await assert.rejects(openRequestBatch(invalid.path),/Duplicate requests.yml media/);
  const valid=await fixture(t,stringify({requests:[a,{...structuredClone(a),instance:'4K'},{...structuredClone(a),type:'episode',seriesId:5}]}));
  const batch=await openRequestBatch(valid.path);assert.equal(batch.entries.length,3);await batch.close();
});
test('missing batch has a clear error and releases its temporary lock',async t=>{
  const f=await fixture(t);await assert.rejects(openRequestBatch(f.path),/requests.yml not found/);assert.deepEqual(await readdir(f.directory),[]);
});
test('symlinks and hardlinks cannot redirect batch operations to other files',async t=>{
  for(const hard of [false,true]){
    const f=await fixture(t);const target=join(f.directory,'other.yml');const original=stringify({requests:[entry()]});await writeFile(target,original);
    if(hard)await link(target,f.path);else await symlink(target,f.path);
    await assert.rejects(openRequestBatch(f.path),/Cannot safely read/);assert.equal(await readFile(target,'utf8'),original);
  }
});
test('a pre-existing lock is never overwritten or automatically reclaimed',async t=>{
  const f=await fixture(t,stringify({requests:[entry()]}));const lock=join(f.directory,'.requests.lock');await writeFile(lock,'Existing owner');
  await assert.rejects(openRequestBatch(f.path),/Another requester/);assert.equal(await readFile(lock,'utf8'),'Existing owner');
});
test('batch edits and lock replacement are detected before another operation',async t=>{
  const f=await fixture(t,stringify({requests:[entry()]}));const batch=await openRequestBatch(f.path);
  await writeFile(f.path,'requests: []\n');await assert.rejects(batch.assertUnchanged(),/changed during execution/);
  const lock=join(f.directory,'.requests.lock');await rm(lock);await writeFile(lock,'New owner');
  await assert.rejects(batch.assertUnchanged(),/Requester lock changed/);await batch.close();assert.equal(await readFile(lock,'utf8'),'New owner');
});

test('real filesystem cleanup failure leaves the original YAML intact',async t=>{
  const {chmod}=await import('node:fs/promises');const a=entry();const source=stringify({requests:[a,{...structuredClone(a),mediaId:2}]});
  const f=await fixture(t,source);const batch=await openRequestBatch(f.path);await chmod(f.directory,0o500);
  try{await assert.rejects(batch.removeAccepted(batch.entries[0]),/Cannot persist batch cleanup safely/);}
  finally{await chmod(f.directory,0o700);await batch.close();}
  assert.equal(await readFile(f.path,'utf8'),source);assert.deepEqual(await readdir(f.directory),['requests.yml']);
});
