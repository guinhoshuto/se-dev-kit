import {getStore} from '@/lib/storage';
import {getProjectAuthorized,projectView,replaceProject} from '@/lib/projects';
import {bearer,endpoint,json,readInput} from '@/lib/http';
export const runtime='nodejs';
export const maxDuration=60;
type Context={params:Promise<{id:string}>};
export async function GET(request:Request,context:Context){return endpoint(request,async()=>{const {id}=await context.params;const store=getStore();const {project,etag}=await getProjectAuthorized(store,id,bearer(request));return json(await projectView(store,project,etag));});}
export async function PUT(request:Request,context:Context){return endpoint(request,async()=>{const {id}=await context.params;return json(await replaceProject(getStore(),id,bearer(request),request.headers.get('if-match'),await readInput(request)));});}
