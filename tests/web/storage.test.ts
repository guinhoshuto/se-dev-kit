import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BlobStore,LocalStore,mutateJson,readJson,getStore} from '../../lib/storage';
test('immutable objects, atomic concurrency and path boundaries',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'studio-store-test-'));const store=new LocalStore(dir);
  const {etag}=await store.put('projects/a.json',Buffer.from('first'));
  await assert.rejects(()=>store.put('projects/a.json',Buffer.from('second')),/changed elsewhere/);
  const results=await Promise.allSettled([store.put('projects/a.json',Buffer.from('left'),{ifMatch:etag}),store.put('projects/a.json',Buffer.from('right'),{ifMatch:etag})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  await assert.rejects(()=>store.get('../secret'));
  await symlink(tmpdir(),join(dir,'escape'));await assert.rejects(()=>store.get('escape/test'),/symlinks/);
  assert.deepEqual(await store.list('projects/'),['projects/a.json']);
});
test('CAS reservations cannot lose concurrent increments',async()=>{
  const store=new LocalStore(await mkdtemp(join(tmpdir(),'studio-cas-test-')));
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
