import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, writeFile, rename, unlink, rmdir, readdir, lstat, realpath} from 'node:fs/promises';
import {resolve, dirname, join, sep} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import type {ObjectStore, ObjectValue} from './model';
import {safeKey} from './schema';
import {ConflictError, HttpError} from './errors';

type PutOptions = {contentType?:string;ifMatch?:string;overwrite?:boolean};
const digest = (body:Uint8Array) => `"${createHash('sha256').update(body).digest('hex')}"`;
const isMissing = (error:unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** Local development only. Atomic replacement plus per-key cross-process lock. */
export class LocalStore implements ObjectStore {
  readonly root:string;
  constructor(directory:string) {
    this.root=resolve(directory);
    if (this.root === '/' || this.root === process.env.HOME || this.root === process.cwd()) throw new Error('Storage must have a dedicated directory.');
  }
  private async path(key:string):Promise<string> {
    safeKey(key); await mkdir(this.root,{recursive:true});
    const base=await realpath(this.root); const target=resolve(base,key);
    if (!target.startsWith(base+sep)) throw new HttpError(400,'Storage path escapes its directory.');
    let cursor=base;
    for (const part of key.split('/')) {
      cursor=join(cursor,part);
      try { if ((await lstat(cursor)).isSymbolicLink()) throw new HttpError(400,'Storage symlinks are not allowed.'); } catch(error) { if (!isMissing(error)) throw error; }
    }
    return target;
  }
  async get(key:string):Promise<ObjectValue|null> {
    const path=await this.path(key);
    try {const body=await readFile(path); return {body,etag:digest(body)};} catch(error) {if(isMissing(error)) return null;throw error;}
  }
  async put(key:string,body:Uint8Array,options:PutOptions={}):Promise<{etag:string}> {
    const path=await this.path(key); await mkdir(dirname(path),{recursive:true});
    const lock=path+'.lock'; let acquired=false;
    for(let attempt=0;attempt<100;attempt++) {
      try {await mkdir(lock);acquired=true;break;} catch(error) {if ((error as NodeJS.ErrnoException).code!=='EEXIST') throw error;await delay(20);}
    }
    if(!acquired) throw new HttpError(503,'Storage is busy. Retry shortly.');
    const temporary=path+'.tmp-'+randomUUID();
    try {
      const existing=await this.get(key);
      if(options.ifMatch && existing?.etag!==options.ifMatch) throw new ConflictError();
      if(existing && !options.overwrite && !options.ifMatch) throw new ConflictError();
      await writeFile(temporary,body,{flag:'wx',mode:0o600}); await rename(temporary,path);
      return {etag:digest(body)};
    } finally {await unlink(temporary).catch(e=>{if(!isMissing(e)) throw e;});await rmdir(lock);}
  }
  async list(prefix:string):Promise<string[]> {
    const clean=prefix.replace(/\/$/,''); const root=await this.path(clean); const found:string[]=[];
    const walk=async (dir:string,relative:string):Promise<void> => {
      let entries;try{entries=await readdir(dir,{withFileTypes:true});}catch(error){if(isMissing(error)) return;throw error;}
      for(const entry of entries) {
        if(entry.isSymbolicLink()||entry.name.endsWith('.lock')||entry.name.includes('.tmp-')) continue;
        const key=relative+'/'+entry.name;
        if(entry.isDirectory()) await walk(join(dir,entry.name),key);else if(entry.isFile()) found.push(key);
      }
    };
    await walk(root,clean);return found.sort();
  }
  async delete(key:string):Promise<void>{await unlink(await this.path(key)).catch(error=>{if(!isMissing(error))throw error;});}
}

export class BlobStore implements ObjectStore {
  async get(key:string):Promise<ObjectValue|null> {
    const {get}=await import('@vercel/blob');
    const response=await get(safeKey(key),{access:'private',useCache:false});
    if(!response)return null;
    if(!response.stream)throw new Error('Unexpected empty Blob response.');
    return {body:new Uint8Array(await new Response(response.stream).arrayBuffer()),etag:response.blob.etag};
  }
  async put(key:string,body:Uint8Array,options:PutOptions={}):Promise<{etag:string}> {
    const {put,BlobPreconditionFailedError,BlobError}=await import('@vercel/blob');
    try {
      const result=await put(safeKey(key),Buffer.from(body),{access:'private',addRandomSuffix:false,allowOverwrite:Boolean(options.overwrite||options.ifMatch),contentType:options.contentType??'application/octet-stream',cacheControlMaxAge:60,...(options.ifMatch?{ifMatch:options.ifMatch}:{})});
      return {etag:result.etag};
    }catch(error){if(error instanceof BlobPreconditionFailedError||(error instanceof BlobError && /already exists/i.test(error.message)))throw new ConflictError();throw error;}
  }
  async list(prefix:string):Promise<string[]> {
    safeKey(prefix.replace(/\/$/,''));const {list}=await import('@vercel/blob');const keys:string[]=[];let cursor:string|undefined;
    do {const result=await list({prefix,cursor,limit:1000});keys.push(...result.blobs.map(b=>b.pathname));cursor=result.hasMore?result.cursor:undefined;}while(cursor);
    return keys.sort();
  }
  async delete(key:string):Promise<void>{const {del}=await import('@vercel/blob');await del(safeKey(key));}
}

export function getStore():ObjectStore {
  const mode=process.env.STUDIO_STORAGE??(process.env.VERCEL?'blob':'local');
  if(mode==='blob') {
    // In Vercel Functions the rotating OIDC credential lives in the request context
    // (`x-vercel-oidc-token`), where @vercel/blob retrieves it. It is not a runtime env var.
    const hasOidcStore=Boolean(process.env.BLOB_STORE_ID&&(process.env.VERCEL||process.env.VERCEL_OIDC_TOKEN));
    if(!process.env.BLOB_READ_WRITE_TOKEN&&!hasOidcStore)throw new HttpError(503,'Connect a private Vercel Blob store before using this deployment.');
    return new BlobStore();
  }
  if(mode!=='local'||process.env.VERCEL)throw new HttpError(503,'Vercel requires private Blob storage; local disk fallback is disabled.');
  return new LocalStore(process.env.STUDIO_DATA_DIR??'.studio-data');
}
export async function readJson<T>(store:ObjectStore,key:string):Promise<T|null>{const value=await store.get(key);return value?JSON.parse(Buffer.from(value.body).toString('utf8')) as T:null;}
export async function writeJson(store:ObjectStore,key:string,value:unknown,options:PutOptions={}):Promise<{etag:string}>{return store.put(key,Buffer.from(JSON.stringify(value)),{contentType:'application/json',...options});}

/** Compare-and-swap update. Used for global usage reservations, not in-memory rate limits. */
export async function mutateJson<T>(store:ObjectStore,key:string,initial:T,change:(value:T)=>T):Promise<T> {
  for(let attempt=0;attempt<8;attempt++) {
    const previous=await store.get(key);const value=change(previous?JSON.parse(Buffer.from(previous.body).toString()):structuredClone(initial));
    try{await writeJson(store,key,value,previous?{ifMatch:previous.etag}:{});return value;}catch(error){if(!(error instanceof ConflictError))throw error;}
  }
  throw new HttpError(503,'Concurrent requests exceeded the retry limit. Please retry.');
}

/**
 * In-memory LRU with single-flight for write-once keys (content-addressed objects, font index
 * entries). `BlobStore.get` always reads with `useCache: false`, so repeated reads of immutable
 * objects would otherwise pay a Blob round trip each time. Only present objects are cached, since a
 * missing key may be written later. Callers still verify content hashes on every read.
 */
export class ImmutableReadCache {
  private readonly entries=new Map<string,Uint8Array>();
  private readonly flights=new Map<string,Promise<Uint8Array|null>>();
  private readonly stores=new WeakMap<ObjectStore,number>();
  private nextStore=0;
  private size=0;
  constructor(readonly maxBytes=64*1024*1024,readonly maxEntries=512) {}
  private id(store:ObjectStore):number {let id=this.stores.get(store);if(id===undefined){id=this.nextStore++;this.stores.set(store,id);}return id;}
  get bytes():number {return this.size;}
  get count():number {return this.entries.size;}
  async read(store:ObjectStore,key:string):Promise<Uint8Array|null> {
    const slot=`${this.id(store)}:${key}`;
    const hit=this.entries.get(slot);
    if(hit){this.entries.delete(slot);this.entries.set(slot,hit);return hit;}
    const pending=this.flights.get(slot);
    if(pending)return pending;
    const flight=store.get(key).then(value=>{
      if(!value)return null;
      const body=value.body;
      if(body.byteLength<=this.maxBytes){
        this.entries.set(slot,body);this.size+=body.byteLength;
        for(const [oldest,old] of this.entries){if(this.size<=this.maxBytes&&this.entries.size<=this.maxEntries)break;this.entries.delete(oldest);this.size-=old.byteLength;}
      }
      return body;
    }).finally(()=>{this.flights.delete(slot);});
    this.flights.set(slot,flight);
    return flight;
  }
}
