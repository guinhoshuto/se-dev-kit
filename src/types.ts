export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export type JsonObject = {[key: string]: JsonValue};

export interface WidgetViewport {
  width: number;
  height: number;
  deviceScaleFactor?: number;
}

export interface ReadyRule {
  selector?: string;
  timeoutMs?: number;
}

export interface WidgetFilesConfig {
  html?: string;
  css?: string;
  js?: string;
  fields?: string;
}

export interface StudioConfig {
  schemaVersion: 1;
  widget: {
    root?: string;
    files?: WidgetFilesConfig;
    assets?: string[];
    viewport?: WidgetViewport;
    ready?: ReadyRule;
    adapter?: string;
  };
  channel?: JsonObject & {username?: string};
  themes?: {glob: string};
  fixtures?: {glob: string};
  scenarios?: {glob: string};
  scenes?: {glob: string};
  recipes?: {glob: string};
  output?: {root: string};
}

export interface ResolvedWidgetFiles {
  html: string;
  css: string;
  js: string;
  fields: string;
}

export interface NormalizedFieldOption {
  label: string;
  value: JsonPrimitive;
}

export interface NormalizedField {
  id: string;
  label: string;
  type: string;
  value: JsonValue;
  group?: string;
  min?: number;
  max?: number;
  step?: number;
  options: NormalizedFieldOption[];
  definition: JsonObject;
  editable: boolean;
}

export interface ThemeDefinition {
  schemaVersion: 1;
  id: string;
  name: string;
  description?: string;
  fieldData: JsonObject;
}

export interface TimelineEvent {
  atMs: number;
  listener: string;
  event: JsonValue;
}

export interface FixtureDefinition {
  schemaVersion: 1;
  id: string;
  name: string;
  description?: string;
  channel?: JsonObject;
  recents?: JsonObject;
  fieldData?: JsonObject;
  events: TimelineEvent[];
}

export type ScenarioStep =
  | {action: "dispatch"; listener: string; event: JsonValue}
  | {action: "updateFields"; fieldData: JsonObject}
  | {action: "wait"; ms: number}
  | {
      action: "assert";
      selector: string;
      exists?: boolean;
      visible?: boolean;
      count?: number;
      text?: string;
      attribute?: {name: string; value?: string};
    };

export interface ScenarioDefinition {
  schemaVersion: 1;
  id: string;
  name: string;
  description?: string;
  theme?: string;
  fixture?: string;
  scene?: string;
  steps: ScenarioStep[];
}

export interface StageBackground {
  id: string;
  label?: string;
  color?: string;
  image?: string;
  checkerboard?: boolean;
}

export interface CameraDefinition {
  id: string;
  label?: string;
  scale: number;
  x: number;
  y: number;
  origin?: string;
}

export interface OutputDefinition {
  width: number;
  height: number;
  format?: "png" | "jpeg";
  quality?: number;
}

export interface CropDefinition {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SceneDefinition {
  schemaVersion: 1;
  id: string;
  name: string;
  description?: string;
  theme?: string;
  fixture?: string;
  fieldData?: JsonObject;
  background?: StageBackground;
  viewport?: WidgetViewport;
  output?: OutputDefinition;
  camera?: CameraDefinition;
  crop?: CropDefinition;
  captureAtMs?: number;
}

export interface ThumbnailDefinition {
  width: number;
  height: number;
  fit?: "contain" | "cover";
  format?: "png" | "jpeg";
}

export interface VideoDefinition {
  enabled: boolean;
  durationMs: number;
  fps: number;
  format?: "mp4" | "webm";
  codec?: "h264" | "vp9";
  pixelFormat?: "yuv420p" | "yuva420p";
  audio?: "none";
}

export interface RecipeDefinition {
  schemaVersion: 1;
  id: string;
  name: string;
  description?: string;
  marketplacePreset?: string;
  scenes: string[];
  matrix?: {
    themes?: string[];
    backgrounds?: StageBackground[];
    viewports?: (WidgetViewport & {id: string; label?: string})[];
    cameras?: CameraDefinition[];
  };
  outputs?: {
    screenshots?: boolean;
    thumbnails?: ThumbnailDefinition;
    contactSheet?: boolean;
    video?: VideoDefinition;
  };
  limit?: number;
}

export interface MarketplacePreset {
  schemaVersion: 1;
  id: string;
  marketplace: string;
  verifiedAt: string;
  sources: {url: string; scope: string}[];
  constraints: JsonObject;
  recipeDefaults?: JsonObject;
  validation?: {
    images?: {
      maximumCount?: number;
      formats?: string[];
      minimumWidth?: number;
      minimumHeight?: number;
      requireOpaque?: boolean;
    };
    video?: {
      maximumCount?: number;
      formats?: string[];
      minimumDurationMs?: number;
      maximumDurationMs?: number;
      minimumWidth?: number;
      minimumHeight?: number;
      aspectRatios?: string[];
      audio?: "none";
      maximumBytes?: number;
    };
  };
}

export interface CatalogItem<T> {
  id: string;
  filePath: string;
  value: T;
}

export interface ResolvedProject {
  packageVersion: string;
  inputDirectory: string;
  configPath?: string;
  configDirectory: string;
  widgetRoot: string;
  outputRoot: string;
  files: ResolvedWidgetFiles;
  relativeFiles: ResolvedWidgetFiles;
  adapterPath?: string;
  config: StudioConfig;
  fields: NormalizedField[];
  fieldDefaults: JsonObject;
  rawFields: JsonValue;
  themes: CatalogItem<ThemeDefinition>[];
  fixtures: CatalogItem<FixtureDefinition>[];
  scenarios: CatalogItem<ScenarioDefinition>[];
  scenes: CatalogItem<SceneDefinition>[];
  recipes: CatalogItem<RecipeDefinition>[];
}

export interface RuntimeState {
  sessionId: string;
  fieldData: JsonObject;
  channel: JsonObject;
  recents: JsonObject;
  seed: number;
  fixedTime: string;
}

export interface Diagnostic {
  status: "ok" | "warning" | "error";
  code: string;
  detail: string;
  hint?: string;
}

export interface CaptureVariant {
  id: string;
  scene: SceneDefinition;
  theme?: ThemeDefinition;
  background: StageBackground;
  viewport: WidgetViewport;
  output: OutputDefinition;
  camera: CameraDefinition;
  fixture?: FixtureDefinition;
}

export interface CaptureManifestEntry {
  id: string;
  scene: string;
  theme: string | null;
  fixture: string | null;
  screenshot: string | null;
  thumbnail: string | null;
  video: string | null;
  frames: string | null;
  parameters: JsonObject;
  hashes: JsonObject;
  files?: JsonObject;
}
