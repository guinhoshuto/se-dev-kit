import {getStore} from '@/lib/storage';
import {getProjectAuthorized,getRevision} from '@/lib/projects';
import {bearer,endpoint,json} from '@/lib/http';
export const runtime='nodejs';
export async function GET(request:Request,{params}:{params:Promise<{id:string;revisionId:string}>}){return endpoint(request,async()=>{const {id,revisionId}=await params;const store=getStore();await getProjectAuthorized(store,id,bearer(request));return json(await getRevision(store,id,revisionId));});}
