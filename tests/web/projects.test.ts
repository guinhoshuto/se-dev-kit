import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {LocalStore,readJson,writeJson} from '../../lib/storage';
import {temporaryDirectory} from './temporary';
import {activeJobs,createProject,getJob,getProjectAuthorized,getRevision,listJobs,projectView,replaceProject,createJob} from '../../lib/projects';
import {ORPHANED_JOB_ERROR} from '../../lib/jobs';
import type {Job} from '../../lib/model';
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

/** The pid of a process that has exited, as a stopped local Studio's is. */
async function exitedPid():Promise<number>{
  const child=spawn(process.execPath,['-e','']);await new Promise(done=>child.once('exit',done));
  assert.ok(child.pid);return child.pid;
}
const leases=async(storage:LocalStore)=>(await readJson<{leases:{id:string}[]}>(storage,'usage/active.json'))?.leases.map(l=>l.id);
const running=(storage:LocalStore,job:Job,pid:number)=>writeJson(storage,`projects/${job.projectId}/jobs/${job.id}.json`,{...job,status:'running',progress:'Fetching Google Fonts (pass 2/4).',server:{pid}},{overwrite:true});

test('a local job whose server process is gone fails, and its lease no longer holds the project',async()=>{
  const storage=await store();const result=await createProject(storage,snapshot);const id=result.project.id;
  const first=await createJob(storage,id,result.revision,'render','default');
  assert.deepEqual(first.server,{pid:process.pid},'a local job records the server process that runs it');
  // The server that runs it is alive (this process, then another one): the project stays held.
  await assert.rejects(()=>createJob(storage,id,result.revision,'render','default'),/already has an active job/);
  await running(storage,first,process.ppid);
  await assert.rejects(()=>createJob(storage,id,result.revision,'render','default'),/already has an active job/);
  assert.equal((await getJob(storage,id,first.id)).status,'running');
  assert.equal(await activeJobs(storage),1);
  // That server stops: the job died with it.
  await running(storage,first,await exitedPid());
  assert.equal(await activeJobs(storage),0,'an orphaned job is not active');
  const second=await createJob(storage,id,result.revision,'render','default');
  const old=await readJson<Job>(storage,`projects/${id}/jobs/${first.id}.json`);
  assert.equal(old?.status,'failed');assert.equal(old?.error,ORPHANED_JOB_ERROR);
  assert.deepEqual(await leases(storage),[second.id]);
  assert.equal(await activeJobs(storage),1);
});
test('polling or listing a local job whose server process is gone reports it failed',async()=>{
  const storage=await store();const result=await createProject(storage,snapshot);const id=result.project.id;
  const polled=await createJob(storage,id,result.revision,'render','default');
  const listed={...polled,id:'listed-job',createdAt:new Date(Date.now()-1000).toISOString()};
  const gone=await exitedPid();
  await running(storage,polled,gone);await running(storage,listed,gone);
  const answer=await getJob(storage,id,polled.id);
  assert.equal(answer.status,'failed');assert.equal(answer.error,ORPHANED_JOB_ERROR);
  assert.equal((await readJson<Job>(storage,`projects/${id}/jobs/listed-job.json`))?.status,'running','polling one job reads only that job');
  assert.deepEqual((await listJobs(storage,id)).map(job=>[job.id,job.status]),[[polled.id,'failed'],['listed-job','failed']]);
  assert.equal((await readJson<Job>(storage,`projects/${id}/jobs/listed-job.json`))?.status,'failed');
});
test('a hosted job records no server process, so a dead pid never fails it',async()=>{
  const previous=process.env.STUDIO_EXECUTION;process.env.STUDIO_EXECUTION='vercel';
  try{
    const storage=await store();const result=await createProject(storage,snapshot);
    const job=await createJob(storage,result.project.id,result.revision,'render','default');
    assert.equal(job.server,undefined);
    await writeJson(storage,`projects/${job.projectId}/jobs/${job.id}.json`,{...job,status:'running'},{overwrite:true});
    assert.equal((await getJob(storage,job.projectId,job.id)).status,'running');
    assert.equal(await activeJobs(storage),1);
  }finally{previous===undefined?delete process.env.STUDIO_EXECUTION:process.env.STUDIO_EXECUTION=previous;}
});
