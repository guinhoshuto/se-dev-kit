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
// se-dev-kit#6: a catalog of camelCase scene ids ("f-fontName") passed the import, and the job refused
// its variant ids almost 3 h later with INVALID_ID. The import refuses them at once, with the job's rule.
test('the import refuses a scene id the capture job would refuse, with the rule in the message', () => {
  const scene = (id: string) => ({schemaVersion:1,id,name:'Font name'});
  assert.throws(() => parseSnapshot({...input,scenes:[scene('f-fontName')]}),
    {message:'scenes.0.id: Invalid scene id "f-fontName". Use lowercase letters, numbers, and single hyphens.'});
  assert.deepEqual(parseSnapshot({...input,scenes:[scene('f-font-name')]}).scenes.map(s => s.id), ['f-font-name']);
  assert.throws(() => parseSnapshot({...input,themes:[{schemaVersion:1,id:'Neon',name:'Neon',fieldData:{}}]}),
    /themes\.0\.id: Invalid theme id "Neon"\. Use lowercase letters, numbers, and single hyphens\./);
  const recipe = {schemaVersion:1,id:'fields',name:'Fields',scenes:['f-font-name'],matrix:{viewports:[{id:'Wide_1',width:320,height:240}]}};
  assert.throws(() => parseSnapshot({...input,scenes:[scene('f-font-name')],recipes:[recipe]}),
    /recipes\.0\.matrix\.viewports\.0\.id: Invalid viewport id "Wide_1"\./);
});
// The video caps, which apply only on Vercel, are in limits.test.ts.
test('caps raster work before execution', () => {
  assert.throws(() => parseSnapshot({...input,widget:{...input.widget,viewport:{width:4096,height:640,deviceScaleFactor:2}}}),/4096/);
});
