import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LocalStore} from '../../lib/storage';
import {createProject,getProjectAuthorized,getRevision,projectView,replaceProject,createJob} from '../../lib/projects';
const snapshot={schemaVersion:1,name:'Sample',widget:{html:'<main id="chat"></main>',css:'body{margin:0}',js:'window.addEventListener("onWidgetLoad",()=>{});',fields:{}},themes:[{schemaVersion:1,id:'day',name:'Day',fieldData:{}}]};
async function store(){return new LocalStore(await mkdtemp(join(tmpdir(),'studio-projects-')));}
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
