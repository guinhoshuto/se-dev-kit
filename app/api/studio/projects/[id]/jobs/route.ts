import {z} from 'zod';
import {getStore,writeJson} from '@/lib/storage';
import {createJob,getProjectAuthorized,getRevision,listJobs} from '@/lib/projects';
import {bearer,endpoint,json,readInput} from '@/lib/http';
import {startJob} from '@/lib/jobs';
import {HttpError} from '@/lib/errors';
export const runtime='nodejs';
export const maxDuration=60;
type Context={params:Promise<{id:string}>};
export async function GET(request:Request,{params}:Context){return endpoint(request,async()=>{const {id}=await params;const store=getStore();await getProjectAuthorized(store,id,bearer(request));return json(await listJobs(store,id));});}
export async function POST(request:Request,{params}:Context){return endpoint(request,async()=>{
  const {id}=await params;const store=getStore();const {project}=await getProjectAuthorized(store,id,bearer(request));
  const input=z.object({kind:z.enum(['test','render']),selection:z.string().min(1).max(120)}).strict().safeParse(await readInput(request));
  if(!input.success)throw new HttpError(422,'Select a test scenario or render recipe.');
  const revision=await getRevision(store,id,project.revisionId);
  const job=await createJob(store,id,revision,input.data.kind,input.data.selection);
  try{return json(await startJob(job,revision,store),202);}catch(error){job.status='failed';job.error=error instanceof Error?error.message:'Job could not start.';job.progress='Failed to start';job.updatedAt=new Date().toISOString();await writeJson(store,`projects/${id}/jobs/${job.id}.json`,job,{overwrite:true});return json(job,422);}
});}
