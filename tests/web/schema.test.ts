import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseSnapshot,safeKey} from '../../lib/schema';
const input = {schemaVersion:1,name:'Example',widget:{html:'<div></div>',css:'',js:'',fields:{}}};
test('full snapshots default omitted catalogs to empty, without mutating input', () => {
  const result = parseSnapshot(input); assert.deepEqual(result.themes,[]); assert.equal(result.widget.viewport.width,430); assert.ok(!('themes' in input));
});
test('rejects traversal and duplicate catalog IDs', () => {
  for (const value of ['../x','/x','a/../x','a\\x','a/%2e']) assert.throws(() => safeKey(value));
  const theme = {schemaVersion:1,id:'night',name:'Night',fieldData:{}};
  assert.throws(() => parseSnapshot({...input,themes:[theme,theme]}),/Duplicate/);
});
test('caps raster and video work before execution', () => {
  assert.throws(() => parseSnapshot({...input,widget:{...input.widget,viewport:{width:4096,height:640,deviceScaleFactor:2}}}),/4096/);
  assert.throws(() => parseSnapshot({...input,recipes:[{schemaVersion:1,id:'film',name:'Film',scenes:['default'],outputs:{video:{enabled:true,durationMs:16000,fps:30}}}]}),/15 seconds/);
});
