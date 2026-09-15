import {randomBytes,randomUUID,createHash,timingSafeEqual} from 'node:crypto';
import type {Job, ObjectStore, ProjectRecord, ProjectView, Revision, WidgetSnapshot} from './model';
import {ConflictError,HttpError} from './errors';
import {parseSnapshot,safeId} from './schema';
import {mutateJson,readJson,writeJson} from './storage';
import {prepareSnapshot} from './importer';

const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const projectKey=(id:string)=>`projects/${safeId(id)}/project.json`;
export const revisionKey=(id:string,revisionId:string)=>`projects/${safeId(id)}/revisions/${safeId(revisionId)}.json`;
export async function getProjectAuthorized(store:ObjectStore,id:string,token:string):Promise<{project:ProjectRecord;etag:string}> {
  const entry=await store.get(projectKey(id));
  if(!entry)throw new HttpError(404,'Project not found.');
  const project=JSON.parse(Buffer.from(entry.body).toString()) as ProjectRecord;
  if(!token||token.length>200||!timingSafeEqual(Buffer.from(hash(token),'hex'),Buffer.from(project.accessHash,'hex')))throw new HttpError(403,'This editing link is missing or invalid.');
  return {project,etag:entry.etag};
}
export async function getRevision(store:ObjectStore,id:string,revisionId:string):Promise<Revision> {
  const revision=await readJson<Revision>(store,revisionKey(id,revisionId));
  if(!revision)throw new HttpError(404,'Revision not found.');return revision;
}
export async function listJobs(store:ObjectStore,id:string):Promise<Job[]> {
  const keys=await store.list(`projects/${safeId(id)}/jobs/`);
  const jobs=await Promise.all(keys.filter(k=>k.endsWith('.json')).map(k=>readJson<Job>(store,k)));
  return jobs.filter((j):j is Job=>j!==null).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
}
export async function projectView(store:ObjectStore,project:ProjectRecord,etag:string):Promise<ProjectView> {
  const [revision,keys,jobs]=await Promise.all([getRevision(store,project.id,project.revisionId),store.list(`projects/${project.id}/revisions/`),listJobs(store,project.id)]);
  const history=await Promise.all(keys.filter(k=>k.endsWith('.json')).map(k=>readJson<Revision>(store,k)));
  const {accessHash:_secret,...visible}=project;
  return {project:visible,revision,etag,jobs,revisions:history.filter((r):r is Revision=>r!==null).map(r=>({id:r.id,createdAt:r.createdAt,status:r.status})).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))};
}
export async function dailyBudget(store:ObjectStore,kind:'projects'|'jobs'|'uploads',amount=1):Promise<void> {
  const limits={projects:10,jobs:50,uploads:100*1024*1024};
  await mutateJson(store,`usage/${new Date().toISOString().slice(0,10)}.json`,{projects:0,jobs:0,uploads:0},v=>{
    if(v[kind]+amount>limits[kind])throw new HttpError(429,`The personal daily ${kind} limit has been reached.`);
    return {...v,[kind]:v[kind]+amount};
  });
}
export interface UploadRecord {id:string;key:string;bytes:number;contentType:string;createdAt:string}
export async function expandUploads(store:ObjectStore,id:string,snapshot:WidgetSnapshot):Promise<WidgetSnapshot> {
  const expanded=structuredClone(snapshot);let total=0;
  for(const asset of expanded.assets) {
    if(!asset.uploadId)continue;
    const record=await readJson<UploadRecord>(store,`projects/${safeId(id)}/uploads/${safeId(asset.uploadId)}.json`);
    if(!record)throw new HttpError(422,'Upload does not belong to this project or does not exist.');
    const entry=await store.get(record.key);
    if(!entry||entry.body.length!==record.bytes)throw new HttpError(422,'Upload is incomplete or its size does not match.');
    total+=entry.body.length;if(total>100*1024*1024)throw new HttpError(413,'Assets exceed the 100 MB revision budget.');
    asset.content=Buffer.from(entry.body).toString('base64');asset.encoding='base64';asset.contentType=record.contentType;delete asset.uploadId;
  }
  return expanded;
}
async function makeRevision(store:ObjectStore,id:string,snapshot:WidgetSnapshot):Promise<Revision> {
  const revision:Revision={id:randomUUID(),projectId:id,createdAt:new Date().toISOString(),snapshot,status:'preparing',diagnostics:[]};
  try {
    revision.prepared=await prepareSnapshot(await expandUploads(store,id,snapshot),store,`projects/${id}/prepared/${revision.id}`);
    revision.status='ready';revision.diagnostics=revision.prepared.warnings;
  }catch(error){revision.status='blocked';revision.diagnostics=[error instanceof Error?error.message:'Dependency preparation failed.'];}
  await writeJson(store,revisionKey(id,revision.id),revision);return revision;
}
export async function createProject(store:ObjectStore,input:unknown):Promise<{project:ProjectRecord;revision:Revision;token:string;etag:string}> {
  const snapshot=parseSnapshot(input);
  await dailyBudget(store,'projects');
  await mutateJson(store,'usage/projects.json',{count:0},v=>{if(v.count>=100)throw new HttpError(429,'The personal workspace is limited to 100 projects.');return {count:v.count+1};});
  const id=randomUUID(),token=randomBytes(32).toString('base64url');const now=new Date().toISOString();
  const revision=await makeRevision(store,id,snapshot);
  const project:ProjectRecord={id,name:snapshot.name,revisionId:revision.id,accessHash:hash(token),createdAt:now,updatedAt:now};
  const {etag}=await writeJson(store,projectKey(id),project);return {project,revision,token,etag};
}
export async function replaceProject(store:ObjectStore,id:string,token:string,expected:string|null,input:unknown):Promise<ProjectView> {
  const {project,etag}=await getProjectAuthorized(store,id,token);
  if(!expected)throw new HttpError(428,'If-Match is required for full replacement.');if(expected!==etag)throw new ConflictError();
  const snapshot=parseSnapshot(input);const revision=await makeRevision(store,id,snapshot);
  const next={...project,name:snapshot.name,revisionId:revision.id,updatedAt:new Date().toISOString()};
  const result=await writeJson(store,projectKey(id),next,{ifMatch:etag});return projectView(store,next,result.etag);
}
export async function restoreProject(store:ObjectStore,id:string,token:string,expected:string|null,revisionId:string):Promise<ProjectView> {
  const {project,etag}=await getProjectAuthorized(store,id,token);
  if(!expected)throw new HttpError(428,'If-Match is required for restore.');if(expected!==etag)throw new ConflictError();
  const historical=await getRevision(store,id,revisionId);
  const revision={...structuredClone(historical),id:randomUUID(),createdAt:new Date().toISOString()};
  await writeJson(store,revisionKey(id,revision.id),revision);
  const next={...project,name:revision.snapshot.name,revisionId:revision.id,updatedAt:revision.createdAt};
  const result=await writeJson(store,projectKey(id),next,{ifMatch:etag});return projectView(store,next,result.etag);
}
export async function createJob(store:ObjectStore,id:string,revision:Revision,kind:'test'|'render',selection:string):Promise<Job> {
  if(revision.status!=='ready'||!revision.prepared)throw new HttpError(422,'Resolve preparation errors before running a job.');
  const now=new Date().toISOString();
  const job:Job={id:randomUUID(),projectId:id,revisionId:revision.id,kind,selection,status:'queued',createdAt:now,updatedAt:now,progress:'Queued',artifacts:[]};
  type Lease={id:string;projectId:string;expires:number};
  const ledger=await readJson<{leases:Lease[]}>(store,'usage/active.json');const finished=new Set<string>();
  for(const lease of ledger?.leases??[]) {const previous=await readJson<Job>(store,`projects/${lease.projectId}/jobs/${lease.id}.json`);if(previous&&['completed','failed','cancelled'].includes(previous.status))finished.add(lease.id);}
  await mutateJson(store,'usage/active.json',{leases:[] as Lease[]},v=>{
    const leases=v.leases.filter(l=>l.expires>Date.now()&&!finished.has(l.id));
    if(leases.some(l=>l.projectId===id))throw new HttpError(409,'This project already has an active job.');
    if(leases.length>=2)throw new HttpError(429,'Two jobs are already active. Wait for one to finish.');
    return {leases:[...leases,{id:job.id,projectId:id,expires:Date.now()+11*60*1000}]};
  });
  try{await dailyBudget(store,'jobs');await writeJson(store,`projects/${id}/jobs/${job.id}.json`,job);}catch(error){await mutateJson(store,'usage/active.json',{leases:[] as Lease[]},v=>({leases:v.leases.filter(l=>l.id!==job.id)}));throw error;}
  return job;
}
