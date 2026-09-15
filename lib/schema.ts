import {z} from 'zod';
import {fixtureSchema, jsonObjectSchema, jsonValueSchema, readySchema, recipeSchema, scenarioSchema, sceneSchema, themeSchema} from '../src/config/schemas';
import type {WidgetSnapshot} from './model';
import {HttpError} from './errors';

export const MAX_REQUEST_BYTES = 4_000_000;
export const ID = /^[a-zA-Z0-9_-]{1,100}$/;
export function safeId(value: string): string {
  if (!ID.test(value)) throw new HttpError(400, 'Invalid identifier.');
  return value;
}
export function safeKey(value: string): string {
  if (!value || value.length > 600 || value.startsWith('/') || /[\\\x00-\x1f?#%]/.test(value) || value.split('/').some(p => !p || p === '.' || p === '..')) {
    throw new HttpError(400, 'Invalid storage path.');
  }
  return value;
}
const viewport = z.object({width:z.number().int().min(1).max(4096),height:z.number().int().min(1).max(4096),deviceScaleFactor:z.number().min(0.25).max(2).optional()}).strict();
const snapshotSchema = z.object({
  schemaVersion:z.literal(1), name:z.string().trim().min(1).max(100),
  widget:z.object({html:z.string(),css:z.string(),js:z.string(),fields:jsonValueSchema,viewport:viewport.default({width:430,height:640}),ready:readySchema.optional()}).strict(),
  channel:jsonObjectSchema.default({username:'streamer'}),
  themes:z.array(themeSchema).max(48).default([]), fixtures:z.array(fixtureSchema).max(48).default([]),
  scenes:z.array(sceneSchema).max(48).default([]), scenarios:z.array(scenarioSchema).max(48).default([]), recipes:z.array(recipeSchema).max(48).default([]),
  assets:z.array(z.object({path:z.string().min(1),url:z.string().url().optional(),content:z.string().optional(),encoding:z.enum(['utf8','base64']).optional(),contentType:z.string().max(100).optional(),uploadId:z.string().optional()}).strict()).max(256).default([])
}).strict();

export function parseSnapshot(input: unknown): WidgetSnapshot {
  const parsed = snapshotSchema.safeParse(input);
  if (!parsed.success) throw new HttpError(422, parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
  const snapshot = parsed.data as WidgetSnapshot;
  const assert = (okay: boolean, message: string) => { if (!okay) throw new HttpError(422, message); };
  for (const catalog of [snapshot.themes,snapshot.fixtures,snapshot.scenes,snapshot.scenarios,snapshot.recipes]) {
    const ids = new Set<string>();
    for (const item of catalog) { safeId(item.id); assert(!ids.has(item.id), `Duplicate catalog identifier: ${item.id}`); ids.add(item.id); }
  }
  const dimensions = (v?: {width:number;height:number;deviceScaleFactor?:number}) => {
    if (v) assert(v.width * (v.deviceScaleFactor ?? 1) <= 4096 && v.height * (v.deviceScaleFactor ?? 1) <= 4096, 'Raster dimensions must not exceed 4096 pixels.');
  };
  dimensions(snapshot.widget.viewport);
  assert((snapshot.widget.ready?.timeoutMs ?? 10000) <= 30000, 'Ready timeout must not exceed 30 seconds.');
  for (const scene of snapshot.scenes) {
    dimensions(scene.viewport); dimensions(scene.output); dimensions(scene.crop);
    assert((scene.captureAtMs ?? 0) <= 15000,'Scene capture time must not exceed 15 seconds.');
    if (scene.theme) assert(snapshot.themes.some(t => t.id === scene.theme),`Unknown theme: ${scene.theme}`);
    if (scene.fixture) assert(snapshot.fixtures.some(t => t.id === scene.fixture),`Unknown fixture: ${scene.fixture}`);
  }
  for (const scenario of snapshot.scenarios) {
    assert(scenario.steps.length <= 100,'Scenarios are limited to 100 steps.');
    assert(scenario.steps.reduce((sum,s) => sum + (s.action === 'wait' ? s.ms : 0),0) <= 30000,'Scenario waits must not exceed 30 seconds.');
  }
  for (const recipe of snapshot.recipes) {
    const matrix = recipe.matrix;
    const count = recipe.scenes.length * (matrix?.themes?.length || 1) * (matrix?.backgrounds?.length || 1) * (matrix?.viewports?.length || 1) * (matrix?.cameras?.length || 1);
    assert(count <= 48 && (recipe.limit ?? 48) <= 48,'A recipe may contain at most 48 variants.');
    for (const id of recipe.scenes) assert(id === 'default' || snapshot.scenes.some(s => s.id === id),`Unknown scene: ${id}`);
    for (const id of matrix?.themes ?? []) assert(snapshot.themes.some(t => t.id === id),`Unknown theme: ${id}`);
    for (const v of matrix?.viewports ?? []) dimensions(v);
    dimensions(recipe.outputs?.thumbnails);
    const video = recipe.outputs?.video;
    if (video?.enabled) {
      assert(video.durationMs <= 15000 && video.fps <= 30,'Video is limited to 15 seconds at 30 fps.');
      assert(count <= 4,'Video recipes are limited to four variants.');
    }
    if (recipe.marketplacePreset) safeId(recipe.marketplacePreset);
  }
  const assetPaths = new Set<string>();
  for (const asset of snapshot.assets) {
    safeKey(asset.path);
    assert(!assetPaths.has(asset.path),`Duplicate asset path: ${asset.path}`); assetPaths.add(asset.path);
    assert([asset.url,asset.content,asset.uploadId].filter(x => x !== undefined).length === 1,'Each asset must have exactly one of url, content, or uploadId.');
    if (asset.uploadId) safeId(asset.uploadId);
  }
  return snapshot;
}
