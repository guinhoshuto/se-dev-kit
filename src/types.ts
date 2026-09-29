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

/**
 * How a field change reaches the widget in captures, tutorials, and scenarios. `reload` recreates
 * the widget frame with the new values, as the StreamElements editor does: placeholders are
 * substituted again and `onWidgetLoad` fires again. `event` keeps the frame and dispatches the
 * Studio's `onWidgetUpdate`, which StreamElements does not have.
 */
export type FieldUpdateMode = "reload" | "event";

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
    /** Defaults to `reload`. */
    fieldUpdate?: FieldUpdateMode;
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

export type TutorialTarget =
  | "layer"
  | "save"
  | "preview"
  | "emulate"
  | "open-editor"
  | "chat-input"
  | `group:${string}`
  | `field:${string}`
  | {x: number; y: number};

export type TutorialEmulateKind = "follower" | "subscriber" | "tip" | "cheer" | "raid" | "redemption" | "merch";

export type TutorialStep =
  | {action: "wait"; ms: number}
  | {action: "caption"; text: string | null}
  | {action: "move"; target: TutorialTarget; durationMs?: number}
  | {action: "click"; target: TutorialTarget; durationMs?: number}
  | {action: "selectLayer"}
  | {action: "openGroup"; group: string}
  | {action: "setField"; field: string; value: JsonPrimitive}
  | {
      action: "emulate";
      event: TutorialEmulateKind;
      option?: string;
      name?: string;
      amount?: number;
      message?: string;
      listener?: string;
      payload?: JsonValue;
    }
  | {
      action: "chat";
      user: string;
      text: string;
      color?: string;
      badges?: string[];
      typed?: boolean;
      data?: JsonObject;
    }
  | {action: "save"};

export interface TutorialDefinition {
  overlayName?: string;
  layerName?: string;
  overlay?: {width: number; height: number};
  widget?: {x?: number; y?: number; scale?: number};
  uiScale?: number;
  chat?: {enabled?: boolean; title?: string; channel?: string};
  liveEmulation?: boolean;
  typingMsPerChar?: number;
  /** Screen Studio-style camera for tutorial videos: zooms on the cursor. Default on, zoom 1.8. `false` keeps the full editor. */
  autoZoom?: boolean | {zoom?: number};
  steps: TutorialStep[];
}

export interface VideoDefinition {
  enabled: boolean;
  durationMs: number;
  fps: number;
  format?: "mp4" | "webm";
  codec?: "h264" | "vp9";
  pixelFormat?: "yuv420p" | "yuva420p";
  audio?: "none";
  mode?: "stage" | "tutorial";
  tutorial?: TutorialDefinition;
  /** Keep the PNG frames and frames.json after a validated encode. Defaults to false. */
  keepFrames?: boolean;
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
      /** Width over height, inclusive: a range of accepted shapes instead of exact `aspectRatios`. */
      minimumAspectRatio?: number;
      maximumAspectRatio?: number;
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

/**
 * Why a font face used by the widget is shown in a fallback typeface. `stylesheet-blocked`: the
 * Google Fonts stylesheet that declares it failed or was refused; `upstream-4xx`: Google refused
 * the family; `not-in-cache`: a render had no cached copy; `face-error`: a font file failed;
 * `timeout`: the preview's font budget ran out; `partial`: only some subsets are available.
 */
export type FontFallbackReason = "stylesheet-blocked" | "upstream-4xx" | "not-in-cache" | "face-error" | "timeout" | "partial";

/** One family, weight and style the widget uses, from its DOM, its canvas text, or a Google Fonts URL it loaded. */
export interface FontReportEntry {
  family: string;
  /** Computed weight such as `400` or `700`. */
  weight: string;
  style: "normal" | "italic";
  status: "loaded" | "fallback";
  reason?: FontFallbackReason;
  sources: ("dom" | "canvas" | "google")[];
  /** The Google Fonts stylesheet that requests this family, when there is one. */
  url?: string;
}

/** What `settle()` in the widget frame found. */
export interface FontReport {
  families: FontReportEntry[];
  /** A face finished loading after canvas text was last drawn with a fallback; one more frame redraws it. */
  redrawNeeded: boolean;
  /** Google Fonts stylesheets that failed to load, with the frame's reason. */
  failedStylesheets: {href: string; reason: FontFallbackReason}[];
  /** Font loading errors and content-security-policy refusals seen in the frame. */
  issues: string[];
  /** False when the preview's font budget expired before every face settled. */
  complete: boolean;
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
  /** Frame directory relative to the output root, or null when no frames remain on disk. */
  frames: string | null;
  /** Video variants only: whether the PNG frames and frames.json were kept after encoding. */
  framesRetained?: boolean;
  /** Video variants only: the exact frames.json content, kept even after the files are discarded. */
  frameSequence?: JsonObject;
  /** Set when frame removal after a validated encode failed; the frames and frames.json may remain in part. */
  framesDiscardError?: string;
  /** The still's fonts: each family loaded or in fallback, Google refusals, and `redrawMs` for canvas text. */
  fonts?: JsonObject;
  /** The video's fonts, as last settled after an event. */
  videoFonts?: JsonObject;
  parameters: JsonObject;
  hashes: JsonObject;
  files?: JsonObject;
}
