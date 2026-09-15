import {randomBytes} from 'node:crypto';
import {getStore} from '@/lib/storage';
import {expandUploads,getProjectAuthorized,getRevision} from '@/lib/projects';
import {bearer,endpoint,json,readInput} from '@/lib/http';
import {parseSnapshot} from '@/lib/schema';
import {prepareSnapshot} from '@/lib/importer';
import {previewHtml,previewState,previewBackground} from '@/lib/preview';
import {HttpError} from '@/lib/errors';
import {z} from 'zod';
import {jsonObjectSchema} from '@/src/config/schemas';
import type {JsonObject} from '@/src/types';
import type {ObjectStore,ObjectValue} from '@/lib/model';
export const runtime='nodejs';
export const maxDuration=60;
/** Draft preview objects stay in request memory; unsaved source is never persisted. */
class DraftStore implements ObjectStore {
  values=new Map<string,ObjectValue>();
  async get(key:string){return this.values.get(key)??null;}
  async put(key:string,body:Uint8Array){this.values.set(key,{body,etag:'draft'});return {etag:'draft'};}
  async list(prefix:string){return [...this.values.keys()].filter(k=>k.startsWith(prefix));}
  async delete(key:string){this.values.delete(key);}
}
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){return endpoint(request,async()=>{
  const {id}=await params;const store=getStore();const {project}=await getProjectAuthorized(store,id,bearer(request));
  const input=z.object({snapshot:z.unknown().optional(),sceneId:z.string().optional(),themeId:z.string().optional(),fieldData:jsonObjectSchema.optional()}).strict().safeParse(await readInput(request));
  if(!input.success)throw new HttpError(422,'Invalid preview options.');
  const options={origin:new URL(request.url).origin,sessionId:randomBytes(20).toString('hex'),nonce:randomBytes(24).toString('hex'),sceneId:input.data.sceneId,themeId:input.data.themeId,fieldData:input.data.fieldData as JsonObject|undefined};
  try {
    const revision=await getRevision(store,id,project.revisionId);
    const supplied=input.data.snapshot?parseSnapshot(input.data.snapshot):undefined;
    const isSaved=!supplied||JSON.stringify(supplied)===JSON.stringify(parseSnapshot(revision.snapshot));
    const target=isSaved?store:new DraftStore();
    const prepared=isSaved?revision.prepared:await prepareSnapshot(await expandUploads(store,id,supplied!),target,'draft');
    if(!prepared)throw new HttpError(422,'This revision has unresolved dependencies.');
    const html=await previewHtml(prepared,target,options);const state=previewState(prepared.snapshot,options);
    const backgroundImage=await previewBackground(prepared,target,options);
    const response={html,state,backgroundImage,sessionId:options.sessionId,nonce:options.nonce};
    if(Buffer.byteLength(JSON.stringify(response))>4_000_000)throw new HttpError(413,'Preview response exceeds 4 MB. Reduce source or preview assets.');
    return json(response);
  }catch(error){if(error instanceof HttpError)throw error;throw new HttpError(422,error instanceof Error?error.message:'Preview preparation failed.');}
});}
