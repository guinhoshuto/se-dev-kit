import {z} from 'zod';
import {getStore} from '@/lib/storage';
import {getProjectAuthorized,restoreProject} from '@/lib/projects';
import {bearer,endpoint,json,readInput} from '@/lib/http';
import {HttpError} from '@/lib/errors';
export const runtime='nodejs';
export const maxDuration=60;
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){return endpoint(request,async()=>{
  const {id}=await params;const store=getStore();const token=bearer(request);await getProjectAuthorized(store,id,token);
  const input=z.object({revisionId:z.string()}).strict().safeParse(await readInput(request));if(!input.success)throw new HttpError(422,'A revision ID is required.');
  return json(await restoreProject(store,id,token,request.headers.get('if-match'),input.data.revisionId));
});}
