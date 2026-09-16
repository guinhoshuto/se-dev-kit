import {HttpError} from './errors';
import {MAX_REQUEST_BYTES} from './schema';
export function bearer(request:Request):string {return request.headers.get('authorization')?.replace(/^Bearer\s+/i,'')??'';}
/** Next may reconstruct request.url with its internal listen hostname. Never infer browser origin from it alone. */
export function requestOrigin(request:Request):string {
  const url=new URL(request.url);
  const host=request.headers.get('host')??url.host;
  if(!/^[a-zA-Z0-9.:[\]-]+$/.test(host))throw new HttpError(403,'Invalid request host.');
  let external:URL;
  try{external=new URL(`${process.env.VERCEL?'https:':url.protocol}//${host}`);}catch{throw new HttpError(403,'Invalid request host.');}
  if(!['http:','https:'].includes(external.protocol))throw new HttpError(403,'Invalid request protocol.');
  if(!process.env.VERCEL && !['localhost','127.0.0.1','[::1]'].includes(external.hostname))throw new HttpError(403,'Local Studio accepts loopback hosts only.');
  return external.origin;
}
export function guardRequest(request:Request):void {
  const expected=requestOrigin(request),origin=request.headers.get('origin');
  if(origin&&origin!==expected)throw new HttpError(403,'Cross-origin API access is disabled.');
}
export async function readBody(request:Request,max=MAX_REQUEST_BYTES):Promise<Uint8Array> {
  if(Number(request.headers.get('content-length'))>max)throw new HttpError(413,'Request exceeds the size limit.');
  const reader=request.body?.getReader();if(!reader)return new Uint8Array();const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max){await reader.cancel();throw new HttpError(413,'Request exceeds the size limit.');}chunks.push(value);}}finally{reader.releaseLock();}
  return Buffer.concat(chunks);
}
export async function readInput(request:Request):Promise<unknown> {
  if(!request.headers.get('content-type')?.includes('application/json'))throw new HttpError(415,'Use Content-Type: application/json.');
  try{return JSON.parse(Buffer.from(await readBody(request)).toString());}catch(error){if(error instanceof HttpError)throw error;throw new HttpError(400,'Invalid JSON.');}
}
export function json(value:unknown,status=200):Response{return Response.json(value,{status,headers:{'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'}});}
export async function endpoint(request:Request,action:()=>Promise<Response>):Promise<Response> {
  try{guardRequest(request);return await action();}catch(error){return json({error:error instanceof HttpError?error.message:'The operation failed. Check the server configuration and retry.'},error instanceof HttpError?error.status:500);}
}
