import {getStore,BlobStore} from '@/lib/storage';
import {getProjectAuthorized,listJobs} from '@/lib/projects';
import {bearer,endpoint} from '@/lib/http';
import {HttpError} from '@/lib/errors';
export const runtime='nodejs';
export async function GET(request:Request,{params}:{params:Promise<{id:string;artifactId:string}>}){return endpoint(request,async()=>{
  const {id,artifactId}=await params;const store=getStore();await getProjectAuthorized(store,id,bearer(request));
  const artifact=(await listJobs(store,id)).flatMap(j=>j.artifacts).find(a=>a.id===artifactId);if(!artifact)throw new HttpError(404,'Artifact not found.');
  // Direct private Blob download avoids Vercel's function response size limit.
  if(store instanceof BlobStore){const {issueSignedToken,presignUrl}=await import('@vercel/blob');const token=await issueSignedToken({pathname:artifact.key,operations:['get'],validUntil:Date.now()+60_000});const {presignedUrl}=await presignUrl(token,{operation:'get',access:'private',pathname:artifact.key});return new Response(null,{status:307,headers:{Location:presignedUrl,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});}
  const value=await store.get(artifact.key);if(!value)throw new HttpError(404,'Artifact not found.');
  return new Response(Buffer.from(value.body),{headers:{'Content-Type':artifact.contentType,'Content-Length':String(value.body.length),'Content-Disposition':`attachment; filename="${artifact.name.replace(/[^a-zA-Z0-9._-]/g,'_')}"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
});}
