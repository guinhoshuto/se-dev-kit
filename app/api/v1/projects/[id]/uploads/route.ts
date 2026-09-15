import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {BlobStore,getStore,writeJson} from '@/lib/storage';
import {dailyBudget,getProjectAuthorized,type UploadRecord} from '@/lib/projects';
import {bearer,endpoint,json,readInput} from '@/lib/http';
import {HttpError} from '@/lib/errors';
export const runtime='nodejs';
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){return endpoint(request,async()=>{
  const {id}=await params;const store=getStore();await getProjectAuthorized(store,id,bearer(request));
  const input=z.object({bytes:z.number().int().min(1).max(10*1024*1024),contentType:z.string().regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i).default('application/octet-stream')}).strict().safeParse(await readInput(request));
  if(!input.success)throw new HttpError(422,'Declare the asset byte length (maximum 10 MB) and MIME contentType.');
  if(!(store instanceof BlobStore)&&input.data.bytes>4_000_000)throw new HttpError(413,'Local uploads are limited to 4 MB per request. Use asset files via the CLI for larger local resources.');
  await dailyBudget(store,'uploads',input.data.bytes);
  const uploadId=randomUUID(),key=`projects/${id}/uploads/${uploadId}.bin`;
  const record:UploadRecord={id:uploadId,key,bytes:input.data.bytes,contentType:input.data.contentType,createdAt:new Date().toISOString()};
  await writeJson(store,`projects/${id}/uploads/${uploadId}.json`,record);
  if(store instanceof BlobStore){
    const {issueSignedToken,presignUrl}=await import('@vercel/blob');const validUntil=Date.now()+5*60_000;
    const signed=await issueSignedToken({pathname:key,operations:['put'],validUntil,maximumSizeInBytes:input.data.bytes,allowedContentTypes:['application/octet-stream']});
    const {presignedUrl}=await presignUrl(signed,{operation:'put',pathname:key,access:'private',addRandomSuffix:false,allowOverwrite:false,maximumSizeInBytes:input.data.bytes,allowedContentTypes:['application/octet-stream']});
    return json({uploadId,url:presignedUrl,method:'PUT',headers:{'Content-Type':'application/octet-stream','x-content-type':'application/octet-stream','x-access':'private'},requiresAuthorization:false,expiresAt:new Date(validUntil).toISOString()},201);
  }
  return json({uploadId,url:`/api/v1/projects/${id}/uploads/${uploadId}`,method:'PUT',headers:{'Content-Type':'application/octet-stream'},requiresAuthorization:true},201);
});}
