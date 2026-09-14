import type {JsonValue, JsonObject, WidgetViewport, ReadyRule, ThemeDefinition, FixtureDefinition, SceneDefinition, ScenarioDefinition, RecipeDefinition} from '../src/types';

export interface AssetInput {path: string; url?: string; content?: string; encoding?: 'utf8' | 'base64'; contentType?: string; uploadId?: string}
export interface WidgetSnapshot {
  schemaVersion: 1;
  name: string;
  widget: {html: string; css: string; js: string; fields: JsonValue; viewport: WidgetViewport; ready?: ReadyRule};
  channel: JsonObject;
  themes: ThemeDefinition[];
  fixtures: FixtureDefinition[];
  scenes: SceneDefinition[];
  scenarios: ScenarioDefinition[];
  recipes: RecipeDefinition[];
  assets: AssetInput[];
}
export interface StoredAsset {path: string; key: string; contentType: string; bytes: number; sha256: string; sourceUrl?: string}
/** A derived, offline-ready snapshot. Original source remains in Revision.snapshot. */
export interface PreparedSnapshot {snapshot: WidgetSnapshot; assets: StoredAsset[]; warnings: string[]}
export interface ProjectRecord {id: string; name: string; revisionId: string; accessHash: string; createdAt: string; updatedAt: string}
export interface Revision {id: string; projectId: string; createdAt: string; snapshot: WidgetSnapshot; status: 'preparing' | 'ready' | 'blocked'; diagnostics: string[]; prepared?: PreparedSnapshot}
export interface Artifact {id: string; name: string; key: string; contentType: string; bytes: number; sha256: string}
export interface Job {
  id: string; projectId: string; revisionId: string; kind: 'render' | 'test'; selection: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  createdAt: string; updatedAt: string; progress: string; artifacts: Artifact[]; error?: string;
  workflowId?: string; sandboxId?: string; commandId?: string;
}
export interface ProjectView {project: Omit<ProjectRecord, 'accessHash'>; revision: Revision; etag: string; revisions: {id: string; createdAt: string; status: Revision['status']}[]; jobs: Job[]}
export interface ObjectValue {body: Uint8Array; etag: string}
export interface ObjectStore {
  get(key: string): Promise<ObjectValue | null>;
  put(key: string, body: Uint8Array, options?: {contentType?: string; ifMatch?: string; overwrite?: boolean}): Promise<{etag: string}>;
  list(prefix: string): Promise<string[]>;
  delete(key: string): Promise<void>;
}
