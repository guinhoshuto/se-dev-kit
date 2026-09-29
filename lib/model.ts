import type {JsonValue, JsonObject, WidgetViewport, ReadyRule, FieldUpdateMode, ThemeDefinition, FixtureDefinition, SceneDefinition, ScenarioDefinition, RecipeDefinition} from '../src/types';

export interface AssetInput {path: string; url?: string; content?: string; encoding?: 'utf8' | 'base64'; contentType?: string; uploadId?: string}
export interface WidgetSnapshot {
  schemaVersion: 1;
  name: string;
  widget: {html: string; css: string; js: string; fields: JsonValue; viewport: WidgetViewport; ready?: ReadyRule; fieldUpdate?: FieldUpdateMode};
  channel: JsonObject;
  themes: ThemeDefinition[];
  fixtures: FixtureDefinition[];
  scenes: SceneDefinition[];
  scenarios: ScenarioDefinition[];
  recipes: RecipeDefinition[];
  assets: AssetInput[];
}
export interface StoredAsset {path: string; key: string; contentType: string; bytes: number; sha256: string; sourceUrl?: string}
/**
 * A derived snapshot. Original source remains in Revision.snapshot. Captured assets are
 * offline-ready; Google Fonts come from the content-addressed font cache and are pinned per
 * revision by its font lock (`projects/<id>/fontlocks/<revisionId>/`).
 */
export interface PreparedSnapshot {
  snapshot: WidgetSnapshot; assets: StoredAsset[]; warnings: string[];
  /** Built-in sample references used by the revision, pinned to the SHA-256 of the deployed bytes at preparation. */
  sampleMedia?: Record<string, string>;
  /**
   * Google Fonts cache namespace pinned for this revision, so bumping the global epoch or
   * User-Agent never changes old revisions. `static` lists the canonical stylesheet URLs known
   * without running the widget.
   */
  googleFonts?: {epoch: string; userAgent: string; static: string[]};
}
export interface ProjectRecord {id: string; name: string; revisionId: string; accessHash: string; createdAt: string; updatedAt: string}
export interface Revision {id: string; projectId: string; createdAt: string; snapshot: WidgetSnapshot; status: 'preparing' | 'ready' | 'blocked'; diagnostics: string[]; prepared?: PreparedSnapshot}
export interface Artifact {id: string; name: string; key: string; contentType: string; bytes: number; sha256: string}
export interface Job {
  id: string; projectId: string; revisionId: string; kind: 'render' | 'test'; selection: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  createdAt: string; updatedAt: string; progress: string; artifacts: Artifact[]; error?: string;
  workflowId?: string; sandboxId?: string; commandId?: string;
  /** Discovery pass the recorded command runs (1 when absent). A pass that finds Google Fonts outside the job package leads to the next one, at most four. */
  fontPass?: number;
}
export interface ProjectView {project: Omit<ProjectRecord, 'accessHash'>; revision: Revision; etag: string; revisions: {id: string; createdAt: string; status: Revision['status']}[]; jobs: Job[]}
export interface ObjectValue {body: Uint8Array; etag: string}
export interface ObjectStore {
  get(key: string): Promise<ObjectValue | null>;
  put(key: string, body: Uint8Array, options?: {contentType?: string; ifMatch?: string; overwrite?: boolean}): Promise<{etag: string}>;
  list(prefix: string): Promise<string[]>;
  delete(key: string): Promise<void>;
}
