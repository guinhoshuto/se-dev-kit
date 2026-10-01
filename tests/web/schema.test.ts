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
test('widget.fieldUpdate takes reload or event, and nothing else', () => {
  for (const mode of ['reload', 'event']) assert.equal(parseSnapshot({...input,widget:{...input.widget,fieldUpdate:mode}}).widget.fieldUpdate, mode);
  assert.equal(parseSnapshot(input).widget.fieldUpdate, undefined, 'left out, the engine default applies');
  assert.throws(() => parseSnapshot({...input,widget:{...input.widget,fieldUpdate:'sometimes'}}), /widget\.fieldUpdate: Invalid enum value\. Expected 'reload' \| 'event'/);
});
// The video caps, which apply only on Vercel, are in limits.test.ts.
test('caps raster work before execution', () => {
  assert.throws(() => parseSnapshot({...input,widget:{...input.widget,viewport:{width:4096,height:640,deviceScaleFactor:2}}}),/4096/);
});
