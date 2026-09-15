import {getStore} from '@/lib/storage';
import {createProject} from '@/lib/projects';
import {endpoint,json,readInput} from '@/lib/http';
import {HttpError} from '@/lib/errors';
export const runtime='nodejs';
export const maxDuration=60;
export async function POST(request:Request){return endpoint(request,async()=>{
  if(process.env.STUDIO_CREATE_KEY && request.headers.get('x-studio-key')!==process.env.STUDIO_CREATE_KEY)throw new HttpError(403,'A workspace creation key is required.');
  const result=await createProject(getStore(),await readInput(request));
  return json({projectId:result.project.id,revisionId:result.revision.id,status:result.revision.status,editorUrl:`/p/${result.project.id}#key=${result.token}`,token:result.token,etag:result.etag},201);
});}
