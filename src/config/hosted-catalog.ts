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

/** The two production layouts a hosted snapshot reads (lib/importer.ts drops their own link and script tags). */
const HOSTED_LAYOUTS: ResolvedWidgetFiles[] = [
  {html: "widget.html", css: "widget.css", js: "widget.js", fields: "widget.json"},
  {html: "index.html", css: "style.css", js: "script.js", fields: "fields.json"}
];

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

export interface HostedCatalogOptions {
  /** Keep only these recipes and the scenes, themes, and fixtures they use; scenarios are left out. */
  recipes?: string[];
}

/** Every whole `/__sws/widget/<path>` string becomes `<path>`, which local runs and hosted imports both accept. */
function withWidgetPaths<T>(value: T): T {
  const visit = (input: unknown): unknown => {
    if (typeof input === "string") return widgetRouteKey(input) ?? input;
    if (Array.isArray(input)) return input.map(visit);
    if (input && typeof input === "object") return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, visit(item)]));
    return input;
  };
  return visit(value) as T;
}

function values<T extends {id: string}>(items: CatalogItem<T>[], keep?: Set<string>): T[] {
  return items.filter((item) => !keep || keep.has(item.id)).map((item) => withWidgetPaths(structuredClone(item.value)));
}

/**
 * Flattens a local project into the catalog a hosted revision holds: each catalog glob becomes an
 * array, and every file the local frame server serves besides the production sources becomes an
 * upload under its widget-relative path, so field values that name widget files resolve in both
 * modes. `/__sws/widget/<path>` values become `<path>`, a matrix `"*"` becomes every theme ID, and
 * `outputs.video.keepFrames` is dropped, because hosted jobs ignore it.
 */
export async function hostedCatalog(project: ResolvedProject, options: HostedCatalogOptions = {}): Promise<HostedCatalog> {
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
  const selected = options.recipes ? new Set(options.recipes) : undefined;
  const recipes = values(project.recipes, selected);
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

  const assets: HostedCatalogAsset[] = [];
  const sources = new Set<string>(Object.values(project.files));
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
    assets.push({path: entry.key, file: entry.key, contentType});
  }
  assets.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const {viewport, ready, fieldUpdate} = project.config.widget;
  return {
    widget: {...(viewport ? {viewport} : {}), ...(ready ? {ready} : {}), ...(fieldUpdate ? {fieldUpdate} : {})},
    ...(project.config.channel ? {channel: withWidgetPaths(structuredClone(project.config.channel))} : {}),
    themes: values(project.themes, themes),
    fixtures: values(project.fixtures, fixtures),
    scenes: values(project.scenes, scenes),
    scenarios: selected ? [] : values(project.scenarios),
    recipes,
    assets
  };
}

/** Loads a `se-widget-studio.config.mjs` as the local CLI does and flattens it; the skill client's `--config`. */
export async function hostedCatalogFromConfig(
  configPath: string,
  options: HostedCatalogOptions = {}
): Promise<{widgetRoot: string; files: ResolvedWidgetFiles; catalog: HostedCatalog}> {
  const absolute = resolve(configPath);
  const project = await loadProject({inputDirectory: dirname(absolute), configPath: absolute});
  return {widgetRoot: project.widgetRoot, files: project.relativeFiles, catalog: await hostedCatalog(project, options)};
}
