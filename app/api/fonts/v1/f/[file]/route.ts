import {getStore} from '@/lib/storage';
import {fontFileResponse} from '@/lib/fonts';
export const runtime='nodejs';
export const maxDuration=30;
/**
 * Public and cache-only: font bytes already in the Google Fonts cache, for the editor preview's
 * opaque iframe (`Origin: null`, no credentials). Deliberately outside `endpoint()`/`guardRequest`,
 * which would refuse that origin. It never contacts Google. Serves fonts, never executable content.
 * Rate limited per client address in each function instance (lib/fonts.ts FONT_FILE_RATE_LIMIT).
 */
export async function GET(request:Request,{params}:{params:Promise<{file:string}>}){
  const {file}=await params;
  return fontFileResponse(request,file,getStore);
}
