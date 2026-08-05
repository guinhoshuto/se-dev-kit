import {randomBytes} from "node:crypto";
import {lstat, mkdir, rename, stat, writeFile} from "node:fs/promises";
import {basename, dirname, relative, resolve, sep} from "node:path";
import type {ResolvedWidgetFiles} from "../types.js";
import {StudioError, toErrorMessage} from "../shared/errors.js";
import {resolveExistingPath} from "../shared/paths.js";
import {loadProject, CONFIG_FILE_NAME} from "./load.js";

const LAYOUTS: ResolvedWidgetFiles[] = [
  {html: "widget.html", css: "widget.css", js: "widget.js", fields: "widget.json"},
  {html: "index.html", css: "style.css", js: "script.js", fields: "fields.json"}
];

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as {code?: unknown}).code === "ENOENT" || (error as {code?: unknown}).code === "ENOTDIR")
  );
}

async function inspectConfigTarget(configPath: string): Promise<boolean> {
  try {
    const metadata = await lstat(configPath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new StudioError("CONFIG_TARGET_INVALID", `Configuration target is not a regular file: ${configPath}`);
    }
    return true;
  } catch (error) {
    if (error instanceof StudioError) throw error;
    if (isMissingPathError(error)) return false;
    throw new StudioError(
      "CONFIG_TARGET_INSPECTION_FAILED",
      `Could not inspect configuration target ${configPath}: ${toErrorMessage(error)}`
    );
  }
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw new StudioError("WIDGET_FILE_INSPECTION_FAILED", `Could not inspect widget file ${path}: ${toErrorMessage(error)}`);
  }
}

async function detectLayout(root: string): Promise<ResolvedWidgetFiles | undefined> {
  const complete: ResolvedWidgetFiles[] = [];
  for (const layout of LAYOUTS) {
    const checks = await Promise.all(Object.values(layout).map((file) => isRegularFile(resolve(root, file))));
    if (checks.every(Boolean)) complete.push(layout);
  }
  if (complete.length > 1) {
    throw new StudioError(
      "AMBIGUOUS_LAYOUT",
      "Both supported widget layouts were detected. Keep one layout or configure widget.files explicitly before running init."
    );
  }
  return complete[0];
}

function toPortableRelative(root: string, target: string): string {
  return relative(root, target).split(sep).join("/") || ".";
}

export async function initializeWidget(
  inputDirectory: string,
  options: {force?: boolean} = {}
): Promise<{configPath: string; directories: string[]}> {
  const requestedInput = resolve(inputDirectory);
  const resolvedInput = await resolveExistingPath(requestedInput, "Widget directory");
  const inputMetadata = await stat(resolvedInput);
  if (!inputMetadata.isDirectory()) {
    throw new StudioError("NOT_A_DIRECTORY", `Widget directory is not a directory: ${requestedInput}`);
  }

  const configPath = resolve(resolvedInput, CONFIG_FILE_NAME);
  const configExists = await inspectConfigTarget(configPath);
  if (configExists && !options.force) {
    throw new StudioError(
      "CONFIG_EXISTS",
      `${CONFIG_FILE_NAME} already exists.`,
      "Pass --force to replace only this configuration file."
    );
  }

  let widgetRoot = resolvedInput;
  let widgetRootRelative = ".";
  let relativeFiles: ResolvedWidgetFiles | undefined;
  let existingConfigError: unknown;

  if (configExists) {
    try {
      const project = await loadProject({inputDirectory: resolvedInput});
      widgetRoot = project.widgetRoot;
      widgetRootRelative = toPortableRelative(resolvedInput, widgetRoot);
      relativeFiles = project.relativeFiles;
    } catch (error) {
      existingConfigError = error;
    }
  }

  if (!relativeFiles) {
    relativeFiles = await detectLayout(resolvedInput);
    if (!relativeFiles) {
      if (existingConfigError) throw existingConfigError;
      throw new StudioError(
        "WIDGET_FILES_NOT_FOUND",
        "Could not detect a supported widget layout. Expected widget.html/widget.css/widget.js/widget.json or index.html/style.css/script.js/fields.json."
      );
    }
  }

  const directories = ["themes", "fixtures", "scenarios", "scenes", "recipes"].map((name) =>
    resolve(widgetRoot, name)
  );
  for (const directory of directories) await mkdir(directory, {recursive: true});
  const source = `import {defineConfig} from "se-widget-studio";

export default defineConfig({
  schemaVersion: 1,
  widget: {
    root: ${JSON.stringify(widgetRootRelative)},
    files: ${JSON.stringify(relativeFiles, null, 6).replace(/^/gm, "    ").trimStart()},
    assets: ["assets/**/*", "fonts/**/*", "media/**/*"],
    viewport: {width: 430, height: 640, deviceScaleFactor: 1},
    ready: {timeoutMs: 10_000}
  },
  channel: {username: "streamer"},
  themes: {glob: "themes/*.json"},
  fixtures: {glob: "fixtures/*.json"},
  scenarios: {glob: "scenarios/*.json"},
  scenes: {glob: "scenes/*.json"},
  recipes: {glob: "recipes/*.json"},
  output: {root: ".se-widget-studio/output"}
});
`;
  const temporaryPath = resolve(dirname(configPath), `.${basename(configPath)}.${randomBytes(6).toString("hex")}.tmp`);
  await writeFile(temporaryPath, source, {flag: "wx"});
  await rename(temporaryPath, configPath);
  return {configPath, directories};
}
