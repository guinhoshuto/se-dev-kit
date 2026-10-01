import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LocalStore} from '../../lib/storage';
import {temporaryDirectory} from './temporary';
import {createProject,getProjectAuthorized,getRevision,projectView,replaceProject,createJob} from '../../lib/projects';
const snapshot={schemaVersion:1,name:'Sample',widget:{html:'<main id="chat"></main>',css:'body{margin:0}',js:'window.addEventListener("onWidgetLoad",()=>{});',fields:{}},themes:[{schemaVersion:1,id:'day',name:'Day',fieldData:{}}]};
async function store(){return new LocalStore(await temporaryDirectory('studio-projects-'));}
test('create, authorize, immutable revisions, full replacement, and concurrency',async()=>{
  const storage=await store();const created=await createProject(storage,snapshot);
  assert.equal(created.revision.status,'ready');assert.equal(created.revision.snapshot.widget.html,snapshot.widget.html);
  await assert.rejects(()=>getProjectAuthorized(storage,created.project.id,'wrong'),/invalid/);
  const {themes:_removed,...replacement}=snapshot;
  const updated=await replaceProject(storage,created.project.id,created.token,created.etag,replacement);
  assert.deepEqual(updated.revision.snapshot.themes,[]);assert.equal(updated.revisions.length,2);assert.ok(!('accessHash' in updated.project));
  assert.equal((await getRevision(storage,created.project.id,created.revision.id)).snapshot.themes.length,1);
  await assert.rejects(()=>replaceProject(storage,created.project.id,created.token,created.etag,snapshot),/changed elsewhere/);
  await assert.rejects(()=>replaceProject(storage,created.project.id,created.token,null,snapshot),/If-Match/);
});
test('failed imports are visible and cannot start jobs',async()=>{
  const storage=await store();const result=await createProject(storage,{...snapshot,widget:{...snapshot.widget,html:'<img src="missing.png">'}});
  const view=await projectView(storage,result.project,result.etag);assert.equal(view.revision.status,'blocked');assert.ok(view.revision.diagnostics.length);
  await assert.rejects(()=>createJob(storage,result.project.id,result.revision,'render','default'),/preparation/);
});
test('project and global render reservations reject concurrent overload',async()=>{
  const storage=await store();const result=await createProject(storage,snapshot);
  const outcomes=await Promise.allSettled([createJob(storage,result.project.id,result.revision,'test','all'),createJob(storage,result.project.id,result.revision,'test','all')]);
  assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1);
});
test('an inline base64 asset of 3.5 MB prepares, and malformed base64 is still refused (SDK-38)',async()=>{
  const storage=await store();const asset=(content:string)=>({...snapshot,assets:[{path:'media/blob.bin',content,encoding:'base64' as const,contentType:'application/octet-stream'}]});
  const big=await createProject(storage,asset(Buffer.alloc(3_500_000,7).toString('base64')));
  assert.equal(big.revision.status,'ready',big.revision.diagnostics.join('\n'));
  for(const content of ['QUJD','QUI=','QQ==',''])assert.equal((await createProject(storage,asset(content))).revision.status,'ready',content);
  for(const content of ['QUJ','Q===','====','QQ=A','QUJD\n','QU-D','QUJDQQ']){
    const result=await createProject(storage,asset(content));
    assert.equal(result.revision.status,'blocked',content);assert.match(result.revision.diagnostics.join('\n'),/Invalid base64/,content);
  }
});
