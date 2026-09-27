import {endpoint,json} from '@/lib/http';
import {HttpError} from '@/lib/errors';
import {deployedSampleMedia} from '@/lib/sample-media';
export const runtime='nodejs';
export const maxDuration=30;
/**
 * Read-only, capability-free list of the built-in sample media this deployment ships. It verifies the
 * traced files like every other consumer, so clients can confirm `sws-sample:` support before creating a
 * project that cannot be deleted. Metadata only: the bytes are never served on the editor origin.
 */
export async function GET(request:Request){return endpoint(request,async()=>{
  let catalog;
  try{catalog=await deployedSampleMedia();}catch{throw new HttpError(503,'Built-in sample media is unavailable in this deployment.');}
  return json({schemaVersion:1,items:catalog.items.map(({reference,kind,contentType,width,height,bytes,sha256,label,alt,color,tone})=>({reference,kind,contentType,width,height,bytes,sha256,label,alt,color,...(tone?{tone}:{})}))});
});}
