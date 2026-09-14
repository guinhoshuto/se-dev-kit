#!/usr/bin/env node
import {resolve} from "node:path";
import {Command, Option} from "commander";
import type {Browser, BrowserContext} from "playwright-core";
import type {Diagnostic, RecipeDefinition, ResolvedProject, SceneDefinition} from "../types.js";
import {StudioError} from "../shared/errors.js";
import {loadProject} from "../config/load.js";
import {initializeWidget} from "../config/init.js";
import {loadMarketplacePresets} from "../config/presets.js";
import {validateProject, hasValidationErrors} from "../validation/project.js";
import {runDoctor} from "../validation/doctor.js";
import {runBrowserSmoke, runScenarios} from "../scenarios/runner.js";
import {createDefaultScene} from "../scenarios/state.js";
import {startStudioServer} from "../server/server.js";
import {createIsolatedContext, launchStudioBrowser} from "../capture/browser.js";
import {planRecipe, renderRecipe, singleSceneRecipe} from "../capture/renderer.js";
import {STUDIO_VERSION} from "../version.js";

interface GlobalOptions {
  config?: string;
  json?: boolean;
}

const program = new Command();
program
  .name("se-widget-studio")
  .description("Develop, test, and produce media for StreamElements Custom Widgets.")
  .version(STUDIO_VERSION)
  .option("--config <file>", "Use an explicit se-widget-studio.config.mjs file")
  .option("--json", "Write machine-readable JSON output")
  .showHelpAfterError();

function globals(command: Command): GlobalOptions {
  return command.optsWithGlobals() as GlobalOptions;
}

async function projectFor(root: string | undefined, command: Command): Promise<ResolvedProject> {
  const globalOptions = globals(command);
  return loadProject({
    inputDirectory: resolve(root ?? "."),
    ...(globalOptions.config ? {configPath: resolve(globalOptions.config)} : {})
  });
}

function print(value: unknown, json: boolean | undefined): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  if (typeof value === "string") process.stdout.write(`${value}\n`);
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printDiagnostics(diagnostics: Diagnostic[], json: boolean | undefined): void {
  if (json) {
    print({diagnostics}, true);
    return;
  }
  for (const item of diagnostics) {
    process.stdout.write(`${item.status.toUpperCase().padEnd(7)} ${item.code.padEnd(28)} ${item.detail}\n`);
    if (item.hint) process.stdout.write(`        Hint: ${item.hint}\n`);
  }
}

function repeat(value: string, previous: string[]): string[] {
  return previous.concat(value);
}

program
  .command("init")
  .description("Create a small Studio configuration without modifying production widget files.")
  .argument("[root]", "Widget root", ".")
  .option("--force", "Replace the exact existing configuration file")
  .action(async (root: string, options: {force?: boolean}, command: Command) => {
    const result = await initializeWidget(resolve(root), options);
    print(
      {
        status: "ok",
        config: result.configPath,
        directories: result.directories,
        note: "Production widget files were not modified."
      },
      globals(command).json
    );
  });

program
  .command("doctor")
  .description("Detect local browser and media tools without installing anything.")
  .argument("[root]", "Optional widget root")
  .option("--browser-path <file>", "Use an explicit Chromium or Chrome executable")
  .option("--ffmpeg-path <file>", "Use an explicit FFmpeg executable")
  .option("--ffprobe-path <file>", "Use an explicit ffprobe executable")
  .action(async (root: string | undefined, options: Record<string, string>, command: Command) => {
    const project = root ? await projectFor(root, command) : undefined;
    const report = await runDoctor({
      ...(project ? {project} : {}),
      ...(options.browserPath ? {browserPath: options.browserPath} : {}),
      ...(options.ffmpegPath ? {ffmpegPath: options.ffmpegPath} : {}),
      ...(options.ffprobePath ? {ffprobePath: options.ffprobePath} : {})
    });
    if (globals(command).json) print(report, true);
    else printDiagnostics(report.diagnostics, false);
    if (report.diagnostics.some((item) => item.status === "error")) process.exitCode = 1;
  });

program
  .command("list")
  .description("List discovered fields, themes, fixtures, scenes, scenarios, and recipes.")
  .argument("[root]", "Widget root", ".")
  .action(async (root: string, _options: unknown, command: Command) => {
    const project = await projectFor(root, command);
    const result = {
      fields: project.fields.map(({id, label, type, value}) => ({id, label, type, value})),
      themes: project.themes.map(({value}) => ({id: value.id, name: value.name})),
      fixtures: project.fixtures.map(({value}) => ({id: value.id, name: value.name})),
      scenes: project.scenes.map(({value}) => ({id: value.id, name: value.name})),
      scenarios: project.scenarios.map(({value}) => ({id: value.id, name: value.name})),
      recipes: project.recipes.map(({value}) => ({id: value.id, name: value.name}))
    };
    print(result, globals(command).json);
  });

program
  .command("presets")
  .description("List versioned marketplace media presets and their verification sources.")
  .action(async (_options: unknown, command: Command) => {
    print(await loadMarketplacePresets(), globals(command).json);
  });

program
  .command("validate")
  .description("Validate configuration, schemas, references, paths, and optional browser readiness.")
  .argument("[root]", "Widget root", ".")
  .option("--browser", "Run a browser readiness smoke test")
  .option("--browser-path <file>", "Use an explicit Chromium or Chrome executable")
  .option("--headed", "Show the browser during the smoke test")
  .action(async (root: string, options: {browser?: boolean; browserPath?: string; headed?: boolean}, command: Command) => {
    const project = await projectFor(root, command);
    const diagnostics = await validateProject(project);
    if (options.browser && !hasValidationErrors(diagnostics)) {
      const smoke = await runBrowserSmoke(project, options);
      diagnostics.push({
        status: smoke.status === "passed" ? "ok" : "error",
        code: "BROWSER_SMOKE",
        detail: smoke.status === "passed" ? "Widget reached browser readiness without runtime errors." : smoke.errors.join("; ")
      });
    }
    printDiagnostics(diagnostics, globals(command).json);
    if (hasValidationErrors(diagnostics)) process.exitCode = 1;
  });

program
  .command("dev")
  .alias("studio")
  .description("Start the interactive Studio on the local loopback interface.")
  .argument("[root]", "Widget root", ".")
  .option("--host <host>", "Bind host", "127.0.0.1")
  .option("--port <port>", "Control server port; use 0 for an ephemeral port", (value) => Number(value), 4173)
  .option("--allow-remote", "Allow an explicitly requested non-loopback host")
  .option("--open", "Open a managed temporary browser session")
  .option("--browser-path <file>", "Use an explicit Chromium or Chrome executable")
  .addOption(new Option("--view <view>", "Initial view").choices(["preview", "gallery"]).default("preview"))
  .action(async (
    root: string,
    options: {
      host: string;
      port: number;
      allowRemote?: boolean;
      open?: boolean;
      browserPath?: string;
      view: "preview" | "gallery";
    },
    command: Command
  ) => {
    const project = await projectFor(root, command);
    const diagnostics = await validateProject(project);
    if (hasValidationErrors(diagnostics)) {
      printDiagnostics(diagnostics, globals(command).json);
      process.exitCode = 1;
      return;
    }
    const server = await startStudioServer(project, {
      host: options.host,
      port: options.port,
      ...(options.allowRemote !== undefined ? {allowRemote: options.allowRemote} : {}),
      watch: true,
      onLog: (message) => {
        process.stderr.write(`${message}\n`);
      }
    });
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    try {
      if (options.open) {
        const launched = await launchStudioBrowser({
          ...(options.browserPath ? {browserPath: options.browserPath} : {}),
          headed: true
        });
        browser = launched.browser;
        context = await createIsolatedContext({
          browser,
          allowedOrigins: [server.origin, server.frameOrigin],
          viewport: {width: 1440, height: 960}
        });
        const page = await context.newPage();
        await page.goto(`${server.origin}${options.view === "gallery" ? "/gallery" : "/"}`);
      }
      print(
        {
          status: "running",
          studio: `${server.origin}${options.view === "gallery" ? "/gallery" : "/"}`,
          widgetOrigin: server.frameOrigin,
          host: server.host
        },
        globals(command).json
      );
      await new Promise<void>((resolvePromise) => {
        const stop = () => resolvePromise();
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
    } finally {
      await context?.close();
      await browser?.close();
      await server.close();
    }
  });

program
  .command("test")
  .description("Run deterministic browser scenarios with fresh isolated widget instances.")
  .argument("[root]", "Widget root", ".")
  .option("--scenario <id>", "Run only a named scenario; repeat for multiple", repeat, [])
  .option("--browser-path <file>", "Use an explicit Chromium or Chrome executable")
  .option("--headed", "Show the browser")
  .action(async (
    root: string,
    options: {scenario: string[]; browserPath?: string; headed?: boolean},
    command: Command
  ) => {
    const project = await projectFor(root, command);
    const result = await runScenarios(project, {
      ...(options.scenario.length > 0 ? {scenarioIds: options.scenario} : {}),
      ...(options.browserPath ? {browserPath: options.browserPath} : {}),
      ...(options.headed ? {headed: true} : {})
    });
    print(result, globals(command).json);
    if (result.results.some((item) => item.status === "failed")) process.exitCode = 1;
  });

function sceneProject(project: ResolvedProject, sceneId: string | undefined, themeId: string | undefined) {
  const existing = sceneId
    ? project.scenes.find((item) => item.id === sceneId)?.value
    : project.scenes[0]?.value ?? createDefaultScene(project);
  if (!existing) throw new StudioError("SCENE_NOT_FOUND", `Scene not found: ${sceneId ?? "default"}`);
  const scene: SceneDefinition = {...existing, ...(themeId ? {theme: themeId} : {})};
  const included = project.scenes.some((item) => item.id === scene.id)
    ? project.scenes.map((item) => (item.id === scene.id ? {...item, value: scene} : item))
    : [...project.scenes, {id: scene.id, filePath: "", value: scene}];
  return {project: {...project, scenes: included}, scene};
}

async function runSingleMedia(
  kind: "capture" | "record",
  root: string,
  options: Record<string, unknown>,
  command: Command
): Promise<void> {
  const loaded = await projectFor(root, command);
  const {project, scene} = sceneProject(
    loaded,
    typeof options.scene === "string" ? options.scene : undefined,
    typeof options.theme === "string" ? options.theme : undefined
  );
  const recipe = singleSceneRecipe(scene, {video: kind === "record"});
  const result = await renderRecipe(project, recipe, {
    ...(typeof options.output === "string" ? {outputRoot: resolve(options.output)} : {}),
    force: options.force === true,
    dryRun: options.dryRun === true,
    allowLargeRender: options.allowLargeRender === true,
    allowIntermediate: options.allowIntermediate === true,
    ...(typeof options.browserPath === "string" ? {browserPath: options.browserPath} : {}),
    ...(typeof options.ffmpegPath === "string" ? {ffmpegPath: options.ffmpegPath} : {}),
    ...(typeof options.ffprobePath === "string" ? {ffprobePath: options.ffprobePath} : {})
  });
  print(result, globals(command).json);
  if (result.status === "intermediate" && options.allowIntermediate !== true) process.exitCode = 3;
}

for (const kind of ["capture", "record"] as const) {
  const media = program
    .command(kind)
    .description(kind === "capture" ? "Capture one deterministic scene image." : "Record one scene to PNG frames and optional video.")
    .argument("[root]", "Widget root", ".")
    .option("--scene <id>", "Scene id")
    .option("--theme <id>", "Theme override")
    .option("--output <directory>", "Validated output root")
    .option("--browser-path <file>", "Use an explicit Chromium or Chrome executable")
    .option("--force", "Replace only exact planned output files")
    .option("--dry-run", "Print the output plan without starting a browser")
    .option("--allow-intermediate", "Accept PNG frame output when FFmpeg is unavailable");
  if (kind === "record") {
    media.option("--ffmpeg-path <file>", "Use an explicit FFmpeg executable");
    media.option("--ffprobe-path <file>", "Use an explicit ffprobe executable");
    media.option("--allow-large-render", "Allow a render plan above the 10,000-file safety limit");
  }
  media.action((root: string, options: Record<string, unknown>, command: Command) => runSingleMedia(kind, root, options, command));
}

program
  .command("render")
  .description("Render a versioned recipe matrix with manifests and optional contact sheet/video.")
  .argument("[root]", "Widget root", ".")
  .requiredOption("--recipe <id>", "Recipe id")
  .option("--output <directory>", "Validated output root")
  .option("--browser-path <file>", "Use an explicit Chromium or Chrome executable")
  .option("--ffmpeg-path <file>", "Use an explicit FFmpeg executable")
  .option("--ffprobe-path <file>", "Use an explicit ffprobe executable")
  .option("--force", "Replace only exact planned output files")
  .option("--dry-run", "Expand and print the matrix without writing files")
  .option("--allow-large-matrix", "Render a matrix above the configured safety limit")
  .option("--allow-large-render", "Allow a render plan above the 10,000-file safety limit")
  .option("--limit <count>", "Override the matrix limit", (value) => Number(value))
  .option("--allow-intermediate", "Accept PNG frame output when FFmpeg is unavailable")
  .action(async (
    root: string,
    options: {
      recipe: string;
      output?: string;
      browserPath?: string;
      ffmpegPath?: string;
      ffprobePath?: string;
      force?: boolean;
      dryRun?: boolean;
      allowLargeMatrix?: boolean;
      allowLargeRender?: boolean;
      limit?: number;
      allowIntermediate?: boolean;
    },
    command: Command
  ) => {
    const project = await projectFor(root, command);
    const recipe = project.recipes.find((item) => item.id === options.recipe)?.value;
    if (!recipe) throw new StudioError("RECIPE_NOT_FOUND", `Recipe not found: ${options.recipe}`);
    const renderOptions = {
      ...(options.output ? {outputRoot: resolve(options.output)} : {}),
      ...(options.browserPath ? {browserPath: options.browserPath} : {}),
      ...(options.ffmpegPath ? {ffmpegPath: options.ffmpegPath} : {}),
      ...(options.ffprobePath ? {ffprobePath: options.ffprobePath} : {}),
      ...(options.force !== undefined ? {force: options.force} : {}),
      ...(options.dryRun !== undefined ? {dryRun: options.dryRun} : {}),
      ...(options.allowLargeMatrix !== undefined ? {allowLargeMatrix: options.allowLargeMatrix} : {}),
      ...(options.allowLargeRender !== undefined ? {allowLargeRender: options.allowLargeRender} : {}),
      ...(options.limit !== undefined ? {matrixLimit: options.limit} : {}),
      ...(options.allowIntermediate !== undefined ? {allowIntermediate: options.allowIntermediate} : {})
    };
    const result = options.dryRun
      ? await planRecipe(project, recipe, renderOptions).then(({plan}) => ({plan, status: "dry-run", artifacts: []}))
      : await renderRecipe(project, recipe, renderOptions);
    print(result, globals(command).json);
    if (result.status === "intermediate" && !options.allowIntermediate) process.exitCode = 3;
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const studioError = error instanceof StudioError ? error : undefined;
  const globalOptions = program.opts() as GlobalOptions;
  const output = {
    status: "error",
    code: studioError?.code ?? "UNEXPECTED_ERROR",
    detail: error instanceof Error ? error.message : String(error),
    ...(studioError?.hint ? {hint: studioError.hint} : {})
  };
  if (globalOptions.json) process.stderr.write(`${JSON.stringify(output, null, 2)}\n`);
  else {
    process.stderr.write(`ERROR ${output.code}: ${output.detail}\n`);
    if (output.hint) process.stderr.write(`Hint: ${output.hint}\n`);
  }
  process.exitCode = studioError?.code === "BROWSER_NOT_FOUND" ? 3 : 2;
});
