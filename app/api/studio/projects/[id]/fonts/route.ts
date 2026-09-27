import {z} from 'zod';
import {getStore} from '@/lib/storage';
import {getProjectAuthorized,getRevision} from '@/lib/projects';
import {bearer,endpoint,json,readInput,requestOrigin} from '@/lib/http';
import {previewFontAnswer,takePreviewFontRequest} from '@/lib/fonts';
import {HttpError} from '@/lib/errors';
import {FONT_CACHE_EPOCH,GOOGLE_FONTS_UA} from '@/src/runtime/google-fonts-url';
export const runtime='nodejs';
export const maxDuration=60;
/** Resolve deadline; the preview frame's own font wait is shorter and reports a timeout first. */
const RESOLVE_MS=20_000;
/**
 * The editor preview broker: the editor (never the iframe) resolves a Google Fonts stylesheet the
 * widget asked for. Widget code can drive these requests, so they are rate limited per project and
 * spend only the `preview` budget. The revision lock is written only when the editor passes the
 * saved current revision, which it does only for a preview without drafts or field overrides.
 */
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){return endpoint(request,async()=>{
  const {id}=await params;const store=getStore();const {project}=await getProjectAuthorized(store,id,bearer(request));
  const input=z.object({url:z.string().min(1).max(2048),sampleText:z.string().max(2000).optional(),revisionId:z.string().max(100).optional()}).strict().safeParse(await readInput(request));
  if(!input.success)throw new HttpError(422,'Invalid font request.');
  if(!takePreviewFontRequest(id))throw new HttpError(429,'This project asked for too many Google Fonts stylesheets in the last minute. Wait a moment and reload the preview.');
  const revision=await getRevision(store,id,project.revisionId);
  const pinned=revision.prepared?.googleFonts;
  const lock=input.data.revisionId&&input.data.revisionId===project.revisionId&&revision.status==='ready'?{projectId:id,revisionId:project.revisionId}:undefined;
  const answer=await previewFontAnswer(input.data.url,{store,origin:requestOrigin(request),epoch:pinned?.epoch??FONT_CACHE_EPOCH,userAgent:pinned?.userAgent??GOOGLE_FONTS_UA,sampleText:input.data.sampleText??'',deadline:Date.now()+RESOLVE_MS,...(lock?{lock}:{})});
  return json(answer);
});}
