import {getStore} from '@/lib/storage';
import {getJob,getProjectAuthorized} from '@/lib/projects';
import {bearer,endpoint,json} from '@/lib/http';
export const runtime='nodejs';
type Context={params:Promise<{id:string;jobId:string}>};
/** The poll route: it reads the project and this one job record, and never lists the project's jobs. */
export async function GET(request:Request,{params}:Context){return endpoint(request,async()=>{const {id,jobId}=await params;const store=getStore();await getProjectAuthorized(store,id,bearer(request));return json(await getJob(store,id,jobId));});}
