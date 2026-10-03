import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import type {
  CatalogItem,
  FieldUpdateMode,
  FixtureDefinition,
  JsonObject,
  ReadyRule,
  RecipeDefinition,
  ResolvedProject,
  ResolvedWidgetFiles,
  ScenarioDefinition,
  SceneDefinition,
  ThemeDefinition,
  WidgetViewport
} from "../types.js";
import {StudioError} from "../shared/errors.js";
import {widgetRouteKey} from "../shared/widget-route.js";
import {buildAssetMap} from "../server/assets.js";
import {loadProject} from "./load.js";
import {loadSampleMediaCatalog} from "./sample-media.js";

/** The two production layouts a hosted snapshot reads (lib/importer.ts drops their own link and script tags). */
const HOSTED_LAYOUTS: ResolvedWidgetFiles[] = [
  {html: "widget.html", css: "widget.css", js: "widget.js", fields: "widget.json"},
  {html: "index.html", css: "style.css", js: "script.js", fields: "fields.json"}
];

/**
 * SHA-256 of the PNG originals that sample-media/ was converted from on 2026-09-29 and 2026-10-02: the art the owner
 * supplied, which a widget may carry as its own test files. Copies of retired art are uploads again.
 */
export const SAMPLE_MEDIA_ORIGINALS: Readonly<Record<string, string>> = Object.freeze({
  "295a157f2ee6a0a77645643d701a3243f7435b31a1ae586f252accb41c2dd7a2": "sws-sample:gallery/streamer-2.jpg",
  "a449ae723eafc2eba8e4012abf8d09fa4ffa3d72de6590cccaf2d15158c9ba7a": "sws-sample:gallery/streamer-1-blur.jpg",
  "f5437868dd609605507a3ca87844b3d6b3f8ef533165161d8e8c9ae9e9d735e2": "sws-sample:gallery/streamer-2-blur.jpg",
  "57e5e2a3c54a799791c5ff76d4860db4005148c9ae152ac54c49e2bd2e13bc69": "sws-sample:backdrops/aero.jpg",
  "e9c1198c7321d17b1512456e02bee85173a1b69262ff7a5f11bb6233c3b8c72b": "sws-sample:backdrops/blueprint.jpg",
  "26e5ecf681cdea93be3b12515fde680a9e5905c15218e3dad0e8d9ba23c7fc7f": "sws-sample:backdrops/cute.jpg",
  "b0badfb85dfdd6b19934fc35252a4d6dd49aa83e75d400486f4e609dfb17e709": "sws-sample:backdrops/cute-2.jpg",
  "26a58cbf563d58899f8e3ecd21a9a712f70dd9a927d3a45cc0afc21ea8424d66": "sws-sample:backdrops/patterns.jpg",
  "5a1082e297ba0cfd46246c2986badd8200d4fbfac00afaa9f3d1172fb6f976e9": "sws-sample:backdrops/plants.jpg",
  "7d69c41a667cfacc9ecab095201c3b5dfdac76cca52b3a40db82c76888532e63": "sws-sample:backdrops/plants-2.jpg"
});

/** A widget file to upload: `path` in the hosted revision, `file` relative to the widget root. */
export interface HostedCatalogAsset {
  path: string;
  file: string;
  contentType: string;
}

/** The JSON catalog that the hosted skill client's `import --catalog` takes. */
export interface HostedCatalog {
  widget: {viewport?: WidgetViewport; ready?: ReadyRule; fieldUpdate?: FieldUpdateMode};
  channel?: JsonObject;
  themes: ThemeDefinition[];
  fixtures: FixtureDefinition[];
  scenes: SceneDefinition[];
  scenarios: ScenarioDefinition[];
  recipes: RecipeDefinition[];
  assets: HostedCatalogAsset[];
}

/** A widget file that copies a built-in sample: the catalog names the sample instead, and the file is not uploaded. */
export interface HostedSampleCopy {
  /** The widget-relative path the local config names. */
  path: string;
  /** The `sws-sample:` reference that replaces the path in every catalog value. */
  reference: string;
  /** False when the file is the original the sample was recompressed from: renders show the sample's bytes. */
  identical: boolean;
}

export interface HostedCatalogOptions {
  /** Keep only these recipes and the scenes, themes, and fixtures they use; scenarios are left out. */
  recipes?: string[];
}

interface SampleMatch {
  reference: string;
  identical: boolean;
}

/** Every sample this build ships, by the SHA-256 of its bytes and of the original it was recompressed from. */
async function knownSamples(): Promise<Map<string, SampleMatch>> {
  const samples = await loadSampleMediaCatalog();
  const known = new Map<string, SampleMatch>();
  for (const [sha256, reference] of Object.entries(SAMPLE_MEDIA_ORIGINALS)) {
    if (samples.entry(reference)) known.set(sha256, {reference, identical: false});
  }
  for (const item of samples.items) known.set(item.sha256, {reference: item.reference, identical: true});
  return known;
}

/**
 * Every whole `/__sws/widget/<path>` string becomes `<path>`, which local runs and hosted imports both accept, and a
 * `<path>` in `copies` becomes the `sws-sample:` reference of the sample that file copies.
 */
function withWidgetPaths<T>(value: T, copies: ReadonlyMap<string, string>): T {
  const visit = (input: unknown): unknown => {
    if (typeof input === "string") {
      const path = widgetRouteKey(input) ?? input;
      return copies.get(path) ?? path;
    }
    if (Array.isArray(input)) return input.map(visit);
    if (input && typeof input === "object") return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, visit(item)]));
    return input;
  };
  return visit(value) as T;
}

function values<T extends {id: string}>(items: CatalogItem<T>[], copies: ReadonlyMap<string, string>, keep?: Set<string>): T[] {
  return items.filter((item) => !keep || keep.has(item.id)).map((item) => withWidgetPaths(structuredClone(item.value), copies));
}

const byPath = (a: {path: string}, b: {path: string}): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/**
 * Flattens a local project into the catalog a hosted revision holds: each catalog glob becomes an
 * array, and every file the local frame server serves besides the production sources becomes an
 * upload under its widget-relative path, so field values that name widget files resolve in both
 * modes. `/__sws/widget/<path>` values become `<path>`, a matrix `"*"` becomes every theme ID, and
 * `outputs.video.keepFrames` is dropped, because hosted jobs ignore it. An image that copies a
 * built-in sample, byte for byte or as the original the sample was recompressed from, is not an
 * upload: the values that name it become the sample's `sws-sample:` reference. A file the widget's
 * own source references stays an upload, because the widget loads it by its path.
 */
export async function hostedCatalog(
  project: ResolvedProject,
  options: HostedCatalogOptions = {}
): Promise<{catalog: HostedCatalog; samples: HostedSampleCopy[]}> {
  const {relativeFiles} = project;
  const layout = HOSTED_LAYOUTS.some((candidate) =>
    (Object.keys(candidate) as (keyof ResolvedWidgetFiles)[]).every((kind) => candidate[kind] === relativeFiles[kind])
  );
  if (!layout) {
    throw new StudioError(
      "HOSTED_LAYOUT_UNSUPPORTED",
      `Hosted import reads widget.html, widget.css, widget.js, and widget.json, or index.html, style.css, script.js, and fields.json, at the widget root; this widget uses ${Object.values(relativeFiles).join(", ")}.`
    );
  }
  if (project.adapterPath) {
    throw new StudioError("HOSTED_ADAPTER_UNSUPPORTED", "Hosted projects do not run browser adapters, so a widget with widget.adapter cannot be imported.");
  }

  if (options.recipes) {
    const unknown = options.recipes.filter((id) => !project.recipes.some((item) => item.id === id));
    if (unknown.length > 0) throw new StudioError("RECIPE_NOT_FOUND", `Recipe not found: ${unknown.join(", ")}`);
  }

  const assets: HostedCatalogAsset[] = [];
  const samples: HostedSampleCopy[] = [];
  const sources = new Set<string>(Object.values(project.files));
  let known: Map<string, SampleMatch> | undefined;
  for (const entry of (await buildAssetMap(project)).values()) {
    if (sources.has(entry.filePath)) continue;
    const contentType = entry.contentType.split(";")[0]?.trim() ?? "application/octet-stream";
    if (contentType === "text/html") {
      throw new StudioError(
        "HOSTED_ASSET_UNSUPPORTED",
        `Hosted revisions cannot hold HTML files, and the local Studio serves ${entry.key}.`,
        "Narrow widget.assets in the config so it matches only media, fonts, and other static files."
      );
    }
    if (contentType.startsWith("image/") && !entry.referenced) {
      known ??= await knownSamples();
      const sample = known.get(createHash("sha256").update(await readFile(entry.filePath)).digest("hex"));
      if (sample) {
        samples.push({path: entry.key, ...sample});
        continue;
      }
    }
    assets.push({path: entry.key, file: entry.key, contentType});
  }
  assets.sort(byPath);
  samples.sort(byPath);
  const copies = new Map(samples.map((sample) => [sample.path, sample.reference]));

  const selected = options.recipes ? new Set(options.recipes) : undefined;
  const recipes = values(project.recipes, copies, selected);
  for (const recipe of recipes) {
    delete recipe.outputs?.video?.keepFrames;
    // The local "*" stands for every theme, in catalog order; the hosted schema takes explicit IDs.
    if (recipe.matrix?.themes?.includes("*")) recipe.matrix.themes = project.themes.map((item) => item.id);
  }
  let scenes: Set<string> | undefined;
  let themes: Set<string> | undefined;
  let fixtures: Set<string> | undefined;
  if (selected) {
    scenes = new Set(recipes.flatMap((recipe) => recipe.scenes));
    const used = project.scenes.filter((item) => scenes?.has(item.id)).map((item) => item.value);
    themes = new Set([...used.flatMap((scene) => (scene.theme ? [scene.theme] : [])), ...recipes.flatMap((recipe) => recipe.matrix?.themes ?? [])]);
    fixtures = new Set(used.flatMap((scene) => (scene.fixture ? [scene.fixture] : [])));
  }

  const {viewport, ready, fieldUpdate} = project.config.widget;
  return {
    catalog: {
      widget: {...(viewport ? {viewport} : {}), ...(ready ? {ready} : {}), ...(fieldUpdate ? {fieldUpdate} : {})},
      ...(project.config.channel ? {channel: withWidgetPaths(structuredClone(project.config.channel), copies)} : {}),
      themes: values(project.themes, copies, themes),
      fixtures: values(project.fixtures, copies, fixtures),
      scenes: values(project.scenes, copies, scenes),
      scenarios: selected ? [] : values(project.scenarios, copies),
      recipes,
      assets
    },
    samples
  };
}

/** Loads a `se-widget-studio.config.mjs` as the local CLI does and flattens it; the skill client's `--config`. */
export async function hostedCatalogFromConfig(
  configPath: string,
  options: HostedCatalogOptions = {}
): Promise<{widgetRoot: string; files: ResolvedWidgetFiles; catalog: HostedCatalog; samples: HostedSampleCopy[]}> {
  const absolute = resolve(configPath);
  const project = await loadProject({inputDirectory: dirname(absolute), configPath: absolute});
  return {widgetRoot: project.widgetRoot, files: project.relativeFiles, ...(await hostedCatalog(project, options))};
}
