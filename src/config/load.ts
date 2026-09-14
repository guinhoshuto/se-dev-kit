import {access, realpath, stat} from "node:fs/promises";
import {constants} from "node:fs";
import {dirname, relative, resolve, sep} from "node:path";
import {pathToFileURL} from "node:url";
import type {ResolvedProject, ResolvedWidgetFiles, StudioConfig, WidgetFilesConfig} from "../types.js";
import {StudioError, toErrorMessage} from "../shared/errors.js";
import {readJsonFile} from "../shared/json.js";
import {assertSafeOutputRoot, resolveExistingPath, resolveFileInside} from "../shared/paths.js";
import {STUDIO_VERSION} from "../version.js";
import {loadFixtures, loadRecipes, loadScenarios, loadScenes, loadThemes} from "./catalog.js";
import {normalizeFields} from "./fields.js";
import {configSchema} from "./schemas.js";

export const CONFIG_FILE_NAME = "se-widget-studio.config.mjs";

const LAYOUTS: ResolvedWidgetFiles[] = [
  {html: "widget.html", css: "widget.css", js: "widget.js", fields: "widget.json"},
  {html: "index.html", css: "style.css", js: "script.js", fields: "fields.json"}
];

export interface LoadProjectOptions {
  inputDirectory?: string;
  configPath?: string;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function loadConfigModule(configPath: string): Promise<StudioConfig> {
  let imported: unknown;
  try {
    const metadata = await stat(configPath);
    imported = await import(`${pathToFileURL(configPath).href}?mtime=${metadata.mtimeMs}`);
  } catch (error) {
    throw new StudioError("CONFIG_IMPORT_FAILED", `Could not import ${configPath}: ${toErrorMessage(error)}`);
  }
  const candidate = (imported as {default?: unknown}).default;
  const parsed = configSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new StudioError(
      "INVALID_CONFIG",
      `Invalid ${CONFIG_FILE_NAME}: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
        .join("; ")}`
    );
  }
  return parsed.data as StudioConfig;
}

async function detectLayout(root: string, explicit?: WidgetFilesConfig): Promise<ResolvedWidgetFiles> {
  if (explicit?.html && explicit.css && explicit.js && explicit.fields) {
    return {html: explicit.html, css: explicit.css, js: explicit.js, fields: explicit.fields};
  }

  const complete: ResolvedWidgetFiles[] = [];
  for (const layout of LAYOUTS) {
    const checks = await Promise.all(Object.values(layout).map((file) => fileExists(resolve(root, file))));
    if (checks.every(Boolean)) complete.push(layout);
  }
  if (complete.length > 1) {
    throw new StudioError(
      "AMBIGUOUS_LAYOUT",
      "Both supported widget layouts were detected. Set widget.files explicitly in se-widget-studio.config.mjs."
    );
  }
  if (complete.length === 0) {
    throw new StudioError(
      "WIDGET_FILES_NOT_FOUND",
      "Could not detect a supported widget layout. Expected widget.html/widget.css/widget.js/widget.json or index.html/style.css/script.js/fields.json."
    );
  }
  const detected = complete[0];
  if (!detected) throw new StudioError("WIDGET_FILES_NOT_FOUND", "No widget layout was detected.");
  return {
    html: explicit?.html ?? detected.html,
    css: explicit?.css ?? detected.css,
    js: explicit?.js ?? detected.js,
    fields: explicit?.fields ?? detected.fields
  };
}

function toPortableRelative(root: string, filePath: string): string {
  return relative(root, filePath).split(sep).join("/");
}

export async function loadProject(options: LoadProjectOptions = {}): Promise<ResolvedProject> {
  const requestedInput = resolve(options.inputDirectory ?? process.cwd());
  const inputDirectory = await resolveExistingPath(requestedInput, "Widget directory");
  const inputMetadata = await stat(inputDirectory);
  if (!inputMetadata.isDirectory()) {
    throw new StudioError("NOT_A_DIRECTORY", `Widget directory is not a directory: ${requestedInput}`);
  }

  const requestedConfig = options.configPath
    ? resolve(options.configPath)
    : resolve(inputDirectory, CONFIG_FILE_NAME);
  const hasConfig = await fileExists(requestedConfig);
  if (options.configPath && !hasConfig) {
    throw new StudioError("CONFIG_NOT_FOUND", `Configuration file does not exist: ${requestedConfig}`);
  }
  const configPath = hasConfig ? await realpath(requestedConfig) : undefined;
  const configDirectory = configPath ? dirname(configPath) : inputDirectory;
  const config: StudioConfig = configPath
    ? await loadConfigModule(configPath)
    : {schemaVersion: 1, widget: {root: "."}};

  const widgetRoot = await resolveExistingPath(resolve(configDirectory, config.widget.root ?? "."), "Widget root");
  const relativeFiles = await detectLayout(widgetRoot, config.widget.files);
  const files: ResolvedWidgetFiles = {
    html: await resolveFileInside(widgetRoot, relativeFiles.html, "Widget HTML"),
    css: await resolveFileInside(widgetRoot, relativeFiles.css, "Widget CSS"),
    js: await resolveFileInside(widgetRoot, relativeFiles.js, "Widget JavaScript"),
    fields: await resolveFileInside(widgetRoot, relativeFiles.fields, "FIELDS schema")
  };

  const rawFields = await readJsonFile(files.fields);
  const {fields: normalizedFields, defaults: fieldDefaults} = normalizeFields(rawFields);
  const outputRoot = await assertSafeOutputRoot(resolve(widgetRoot, config.output?.root ?? ".se-widget-studio/output"), [
    inputDirectory,
    configDirectory,
    widgetRoot
  ]);
  const adapterPath = config.widget.adapter
    ? await resolveFileInside(widgetRoot, config.widget.adapter, "Browser adapter")
    : undefined;

  const [themes, fixtures, scenarios, scenes, recipes] = await Promise.all([
    loadThemes(widgetRoot, config.themes?.glob),
    loadFixtures(widgetRoot, config.fixtures?.glob),
    loadScenarios(widgetRoot, config.scenarios?.glob),
    loadScenes(widgetRoot, config.scenes?.glob),
    loadRecipes(widgetRoot, config.recipes?.glob)
  ]);

  const project: ResolvedProject = {
    packageVersion: STUDIO_VERSION,
    inputDirectory,
    configDirectory,
    widgetRoot,
    outputRoot,
    files,
    relativeFiles: {
      html: toPortableRelative(widgetRoot, files.html),
      css: toPortableRelative(widgetRoot, files.css),
      js: toPortableRelative(widgetRoot, files.js),
      fields: toPortableRelative(widgetRoot, files.fields)
    },
    config,
    fields: normalizedFields,
    fieldDefaults,
    rawFields,
    themes,
    fixtures,
    scenarios,
    scenes,
    recipes
  };
  if (configPath) project.configPath = configPath;
  if (adapterPath) project.adapterPath = adapterPath;
  return project;
}

export function defaultViewport(project: ResolvedProject) {
  return project.config.widget.viewport ?? {width: 430, height: 640, deviceScaleFactor: 1};
}

export function defaultReadyRule(project: ResolvedProject) {
  return project.config.widget.ready ?? {timeoutMs: 10_000};
}
