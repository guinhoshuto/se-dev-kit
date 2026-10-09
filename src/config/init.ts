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

const DEFAULT_OUTPUT_ROOT = ".se-widget-studio/output";

const GITIGNORE = `.DS_Store
.se-widget-studio/
.claude/settings.local.json
`;

/** Generic instructions for a coding agent in a widget repository, naming its files as `root` sees them. */
function agentInstructions(root: string, widgetRoot: string, files: ResolvedWidgetFiles, outputRoot: string): string {
  const code = (target: string) => `\`${toPortableRelative(root, target)}\``;
  const named = [files.html, files.css, files.js, files.fields].map((file) => code(resolve(widgetRoot, file)));
  const themes = toPortableRelative(root, resolve(widgetRoot, "themes"));
  return `# Agent instructions

- Test, preview, capture, and render this widget with SE Widget Studio (the \`se-widget-studio\` skill or CLI), never with a sandbox, preview page, or runtime of your own.
- ${named.slice(0, -1).join(", ")}, and ${named.at(-1)} are the production source, pasted as they are into the StreamElements Custom Widget tabs: never rewrite or copy them to make the Studio work.
- Themes are field values, not code: \`${themes}/<id>.json\` holds partial \`fieldData\`, and \`${themes}/<id>.data.json\` a DATA-tab payload.
- Studio output goes to \`${toPortableRelative(root, outputRoot)}/\`; it is regenerable, so keep it out of git.
`;
}

/** Creates each file that does not exist yet; an existing path, even a symlink, is never opened or replaced. */
async function writeAgentFiles(root: string, contents: Record<string, string>): Promise<{written: string[]; kept: string[]}> {
  const result: {written: string[]; kept: string[]} = {written: [], kept: []};
  for (const [name, content] of Object.entries(contents)) {
    const path = resolve(root, name);
    try {
      await writeFile(path, content, {flag: "wx"});
      result.written.push(path);
    } catch (error) {
      if ((error as {code?: unknown}).code !== "EEXIST") {
        throw new StudioError("AGENT_FILE_WRITE_FAILED", `Could not write ${path}: ${toErrorMessage(error)}`);
      }
      result.kept.push(path);
    }
  }
  return result;
}

export interface InitializeResult {
  configPath: string;
  /** `kept` only with `agents`, when a configuration already existed and `force` was absent. */
  config: "written" | "kept";
  directories: string[];
  agents?: {written: string[]; kept: string[]};
}

export async function initializeWidget(
  inputDirectory: string,
  options: {force?: boolean; agents?: boolean} = {}
): Promise<InitializeResult> {
  const requestedInput = resolve(inputDirectory);
  const resolvedInput = await resolveExistingPath(requestedInput, "Widget directory");
  const inputMetadata = await stat(resolvedInput);
  if (!inputMetadata.isDirectory()) {
    throw new StudioError("NOT_A_DIRECTORY", `Widget directory is not a directory: ${requestedInput}`);
  }

  const configPath = resolve(resolvedInput, CONFIG_FILE_NAME);
  const configExists = await inspectConfigTarget(configPath);
  const keepConfig = configExists && !options.force && options.agents === true;
  if (configExists && !options.force && !keepConfig) {
    throw new StudioError(
      "CONFIG_EXISTS",
      `${CONFIG_FILE_NAME} already exists.`,
      "Pass --force to replace only this configuration file."
    );
  }

  let widgetRoot = resolvedInput;
  let widgetRootRelative = ".";
  let relativeFiles: ResolvedWidgetFiles | undefined;
  let outputRoot: string | undefined;
  let existingConfigError: unknown;

  if (configExists) {
    try {
      const project = await loadProject({inputDirectory: resolvedInput});
      widgetRoot = project.widgetRoot;
      widgetRootRelative = toPortableRelative(resolvedInput, widgetRoot);
      relativeFiles = project.relativeFiles;
      outputRoot = project.outputRoot;
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

  const agentFiles = options.agents
    ? {
        "AGENTS.md": agentInstructions(
          resolvedInput,
          widgetRoot,
          relativeFiles,
          outputRoot ?? resolve(widgetRoot, DEFAULT_OUTPUT_ROOT)
        ),
        ".gitignore": GITIGNORE
      }
    : undefined;
  if (keepConfig) {
    return {
      configPath,
      config: "kept",
      directories: [],
      ...(agentFiles ? {agents: await writeAgentFiles(resolvedInput, agentFiles)} : {})
    };
  }

  const directories = ["themes", "fixtures", "scenarios", "scenes", "recipes"].map((name) =>
    resolve(widgetRoot, name)
  );
  for (const directory of directories) await mkdir(directory, {recursive: true});
  // A plain object, not defineConfig(): most widget repositories do not install se-widget-studio, so the import would fail.
  const source = `/** @type {import("se-widget-studio").StudioConfig} */
export default {
  schemaVersion: 1,
  widget: {
    root: ${JSON.stringify(widgetRootRelative)},
    files: ${JSON.stringify(relativeFiles, null, 6).replace(/^/gm, "    ").trimStart()},
    assets: ["assets/**/*", "fonts/**/*", "media/**/*"],
    viewport: {width: 430, height: 640, deviceScaleFactor: 1},
    ready: {timeoutMs: 10_000}
  },
  channel: {username: "streamer"},
  themes: {glob: "themes/!(*.data).json"},
  fixtures: {glob: "fixtures/*.json"},
  scenarios: {glob: "scenarios/*.json"},
  scenes: {glob: "scenes/*.json"},
  recipes: {glob: "recipes/*.json"},
  output: {root: ${JSON.stringify(DEFAULT_OUTPUT_ROOT)}}
};
`;
  const temporaryPath = resolve(dirname(configPath), `.${basename(configPath)}.${randomBytes(6).toString("hex")}.tmp`);
  await writeFile(temporaryPath, source, {flag: "wx"});
  await rename(temporaryPath, configPath);
  return {
    configPath,
    config: "written",
    directories,
    ...(agentFiles ? {agents: await writeAgentFiles(resolvedInput, agentFiles)} : {})
  };
}
