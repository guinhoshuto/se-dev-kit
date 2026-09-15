import {test} from 'node:test';
import assert from 'node:assert/strict';
import {endpoint,readInput,readBody,guardRequest} from '../../lib/http';
test('API guards reject cross-origin requests and invalid JSON',async()=>{
  assert.throws(()=>guardRequest(new Request('http://127.0.0.1/api',{headers:{origin:'https://evil.example'}})),/Cross-origin/);
  await assert.rejects(()=>readInput(new Request('http://127.0.0.1',{method:'POST',body:'oops',headers:{'content-type':'application/json'}})),/Invalid JSON/);
  await assert.rejects(()=>readBody(new Request('http://127.0.0.1',{method:'POST',body:'12345'}),4),/size limit/);
});
test('unexpected server errors never disclose provider secrets',async()=>{
  const response=await endpoint(new Request('http://127.0.0.1'),async()=>{throw new Error('Secret provider credentials here');});
  assert.equal(response.status,500);assert.ok(!(await response.text()).includes('credentials here'));
});
