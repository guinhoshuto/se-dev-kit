import {getStore,readJson,BlobStore} from '@/lib/storage';
import {getProjectAuthorized,type UploadRecord} from '@/lib/projects';
import {bearer,endpoint,json,readBody} from '@/lib/http';
import {safeId} from '@/lib/schema';
import {HttpError} from '@/lib/errors';
export const runtime='nodejs';
export async function PUT(request:Request,{params}:{params:Promise<{id:string;uploadId:string}>}){return endpoint(request,async()=>{
  const {id,uploadId}=await params;const store=getStore();await getProjectAuthorized(store,id,bearer(request));
  if(store instanceof BlobStore)throw new HttpError(400,'Use the direct private Blob upload URL.');
  const record=await readJson<UploadRecord>(store,`projects/${id}/uploads/${safeId(uploadId)}.json`);if(!record)throw new HttpError(404,'Upload reservation not found.');
  const body=await readBody(request);if(body.length!==record.bytes)throw new HttpError(422,'Uploaded byte length does not match the reservation.');
  await store.put(record.key,body,{contentType:'application/octet-stream'});return json({uploadId,bytes:body.length},201);
});}
