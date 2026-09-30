import {test} from 'node:test';
import assert from 'node:assert/strict';
import {symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BlobStore,LocalStore,mutateJson,readJson,getStore} from '../../lib/storage';
import {temporaryDirectory} from './temporary';
test('immutable objects, atomic concurrency and path boundaries',async()=>{
  const dir=await temporaryDirectory('studio-store-test-');const store=new LocalStore(dir);
  const {etag}=await store.put('projects/a.json',Buffer.from('first'));
  await assert.rejects(()=>store.put('projects/a.json',Buffer.from('second')),/changed elsewhere/);
  const results=await Promise.allSettled([store.put('projects/a.json',Buffer.from('left'),{ifMatch:etag}),store.put('projects/a.json',Buffer.from('right'),{ifMatch:etag})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  await assert.rejects(()=>store.get('../secret'));
  await symlink(tmpdir(),join(dir,'escape'));await assert.rejects(()=>store.get('escape/test'),/symlinks/);
  assert.deepEqual(await store.list('projects/'),['projects/a.json']);
});
test('CAS reservations cannot lose concurrent increments',async()=>{
  const store=new LocalStore(await temporaryDirectory('studio-cas-test-'));
  await Promise.all(Array.from({length:4},()=>mutateJson(store,'usage/day.json',{count:0},v=>({count:v.count+1}))));
  assert.deepEqual(await readJson(store,'usage/day.json'),{count:4});
});
test('Vercel never falls back to local disk',()=>{
  const old={...process.env};try{process.env.VERCEL='1';process.env.STUDIO_STORAGE='local';assert.throws(()=>getStore(),/fallback/);}finally{process.env=old;}
});
test('Vercel accepts an OIDC-connected Blob store without a runtime token environment variable',()=>{
  const old={...process.env};
  try {
    process.env.VERCEL='1';process.env.STUDIO_STORAGE='blob';process.env.BLOB_STORE_ID='store_test';
    delete process.env.BLOB_READ_WRITE_TOKEN;delete process.env.VERCEL_OIDC_TOKEN;
    assert.ok(getStore() instanceof BlobStore);
  } finally {process.env=old;}
});
test('a suspended or refused Blob store answers 503 with the cause, not a bare 500',async()=>{
  const {BlobError,BlobStoreSuspendedError}=await import('@vercel/blob');
  const {HttpError}=await import('../../lib/errors');
  // What @vercel/blob 2.8 throws: get() turns the private URL's 403 into a plain BlobError, the API calls into BlobStoreSuspendedError.
  const refusedRead=async()=>{throw new BlobError('Failed to fetch blob: 403 Forbidden');};
  const suspended=async()=>{throw new BlobStoreSuspendedError();};
  const store=new BlobStore({get:refusedRead,put:suspended,list:suspended,del:suspended} as never);
  const unavailable=(error:unknown)=>error instanceof HttpError&&error.status===503&&/Blob store/.test(error.message)&&/suspended/.test(error.message);
  await assert.rejects(()=>store.get('projects/a/project.json'),unavailable);
  await assert.rejects(()=>store.put('projects/a/project.json',Buffer.from('{}')),unavailable);
  await assert.rejects(()=>store.list('projects/a/jobs/'),unavailable);
  await assert.rejects(()=>store.delete('projects/a/project.json'),unavailable);
});
test('other Blob failures stay unexpected server errors',async()=>{
  const {BlobError}=await import('@vercel/blob');
  const {HttpError}=await import('../../lib/errors');
  const store=new BlobStore({get:async()=>{throw new BlobError('Failed to fetch blob: 500 Internal Server Error');}} as never);
  await assert.rejects(()=>store.get('projects/a/project.json'),(error:unknown)=>error instanceof BlobError&&!(error instanceof HttpError));
});
