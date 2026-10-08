#!/usr/bin/env node
import {resolve} from "node:path";
import {Command, Option} from "commander";
import type {Browser, BrowserContext} from "playwright-core";
import type {Diagnostic, RecipeDefinition, ResolvedProject, SceneDefinition} from "../types.js";
import {StudioError} from "../shared/errors.js";
import {loadProject} from "../config/load.js";
import {initializeWidget} from "../config/init.js";
import {loadMarketplacePresets} from "../config/presets.js";
import {loadSampleMediaCatalog, sampleMediaReferencesByKind} from "../config/sample-media.js";
import {validateProject, hasValidationErrors} from "../validation/project.js";
import {runDoctor} from "../validation/doctor.js";
import {runBrowserSmoke, runScenarios} from "../scenarios/runner.js";
import {createDefaultScene} from "../scenarios/state.js";
import {startStudioServer} from "../server/server.js";
import {closeStudioBrowser, createIsolatedContext, launchStudioBrowser} from "../capture/browser.js";
import {
  planRecipe,
  planTutorialRecipe,
  renderRecipe,
  renderSheetAt,
  sheetInstants,
  singleSceneRecipe,
  tutorialVideo,
  withVideoOverrides,
  type RenderResult,
  type RenderTraceEvent,
  type SheetAtResult,
  type TutorialPlanResult
} from "../capture/renderer.js";
import {reviewSummary, writeReviewPage} from "../capture/review.js";
import {assertSupportedNode} from "../shared/node-support.js";
import {acquireRenderSlot, RenderSlotError} from "../shared/render-slot.js";
import {waitForMachine} from "../shared/machine-check.js";
import {STUDIO_VERSION} from "../version.js";
import {cliFlags} from "./flags.js";

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

/**
 * One stderr line per render phase, so a render that hangs shows where. Not with --json, whose
 * stderr stays a single JSON document.
 */
function renderTrace(command: Command, label?: string): ((event: RenderTraceEvent) => void) | undefined {
  if (globals(command).json) return undefined;
  return (event) => {
    const where = `${label ? `${label}: ` : ""}${event.phase}${event.variant ? ` [${event.variant}]` : ""}${event.detail ? ` (${event.detail})` : ""}`;
    process.stderr.write(`${event.at} +${(event.elapsedMs / 1000).toFixed(1)}s ${where}\n`);
  };
}

const NO_WAIT_HELP = "Fail at once, with the reason, when the render slot is held or the machine check says to wait (default: wait up to 4 hours for each)";
const UNSUPPORTED_NODE_HELP = "Render even on a Node.js version outside package.json engines (Chrome launch and close have hung on Node 26)";

program
  .command("init")
  .description("Create a small Studio configuration without modifying production widget files.")
  .argument("[root]", "Widget root", ".")
  .option("--force", "Replace the exact existing configuration file")
  .action(async (root: string, options: {force?: boolean}, command: Command) => {
    const result = await initializeWidget(resolve(root), options);
    // Placeholders to start themes and scenes from; a broken sample install never fails init.
    const samples = await loadSampleMediaCatalog().then(sampleMediaReferencesByKind, () => undefined);
    print(
      {
        status: "ok",
        config: result.configPath,
        directories: result.directories,
        note: "Production widget files were not modified.",
        ...(samples
          ? {
              sampleMedia: samples,
              sampleMediaNote:
                "Built-in placeholders: use a whole sws-sample: string as an image-input value (gallery, backdrop, avatar), a video-input value (clip), or a scene background image (gallery, backdrop) in themes, fixtures, and scenes. Never in FIELDS defaults or widget files."
            }
          : {})
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
      if (browser) await closeStudioBrowser(browser);
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

/**
 * A local render waits for the machine-wide render slot, which other sessions and background-creator
 * share (src/shared/render-slot.ts): one heavy render at a time on this machine. Holding it, `task`
 * calls `machineFree` before each recipe, which waits until the machine check every repo shares says
 * free (src/shared/machine-check.ts: the game, memory, swap, disk). Under a slot inherited from a
 * parent (a test runner), the parent already asked, and `machineFree` returns at once. With
 * `wait: false` (`--no-wait`) a held slot or a busy machine fails at once, with the reason. A refusal
 * of the slot becomes a StudioError with the same code.
 */
async function inRenderSlot<T>(task: (machineFree: () => Promise<void>) => Promise<T>, wait: boolean): Promise<T> {
  const log = (message: string) => process.stderr.write(`${message}\n`);
  const slot = await acquireRenderSlot({
    command: `se-widget-studio ${process.argv.slice(2).join(" ")}`.slice(0, 200),
    repo: "se-dev-kit",
    wait,
    log
  }).catch((error: unknown) => {
    throw error instanceof RenderSlotError ? new StudioError(error.code, error.detail, error.hint, {cause: error}) : error;
  });
  try {
    return await task(() => (slot.inherited ? Promise.resolve() : waitForMachine({wait, log})));
  } finally {
    slot.release();
  }
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
  if (options.dryRun !== true) assertSupportedNode(options.allowUnsupportedNode === true);
  const trace = options.dryRun === true ? undefined : renderTrace(command);
  const render = () => renderRecipe(project, recipe, {
    ...(trace ? {trace} : {}),
    cliFlags: cliFlags(command),
    ...(typeof options.output === "string" ? {outputRoot: resolve(options.output)} : {}),
    force: options.force === true,
    dryRun: options.dryRun === true,
    allowLargeRender: options.allowLargeRender === true,
    allowIntermediate: options.allowIntermediate === true,
    allowLowDisk: options.allowLowDisk === true,
    ...(options.keepFrames === true ? {keepFrames: true} : {}),
    ...(typeof options.browserPath === "string" ? {browserPath: options.browserPath} : {}),
    ...(typeof options.ffmpegPath === "string" ? {ffmpegPath: options.ffmpegPath} : {}),
    ...(typeof options.ffprobePath === "string" ? {ffprobePath: options.ffprobePath} : {})
  });
  const result = options.dryRun === true
    ? await render()
    : await inRenderSlot(async (machineFree) => {
      await machineFree();
      return render();
    }, options.wait !== false);
  print(result, globals(command).json);
  if (result.status === "intermediate" && options.allowIntermediate !== true) process.exitCode = 3;
}

for (const kind of ["capture", "record"] as const) {
  const media = program
    .command(kind)
    .description(
      kind === "capture"
        ? "Capture one deterministic scene image."
        : "Record one scene to video. PNG frames are removed after a validated encode unless --keep-frames is passed."
    )
    .argument("[root]", "Widget root", ".")
    .option("--scene <id>", "Scene id")
    .option("--theme <id>", "Theme override")
    .option("--output <directory>", "Validated output root")
    .option("--browser-path <file>", "Use an explicit Chromium or Chrome executable")
    .option("--force", "Replace only exact planned output files")
    .option("--dry-run", "Print the output plan and disk estimate without starting a browser")
    .option("--allow-intermediate", "Accept PNG frame output when FFmpeg is unavailable")
    .option("--allow-low-disk", "Render even when the estimated peak exceeds 70% of free disk space")
    .option("--no-wait", NO_WAIT_HELP)
    .option("--allow-unsupported-node", UNSUPPORTED_NODE_HELP);
  if (kind === "record") {
    media.option("--ffmpeg-path <file>", "Use an explicit FFmpeg executable");
    media.option("--ffprobe-path <file>", "Use an explicit ffprobe executable");
    media.option("--allow-large-render", "Allow a render plan above the 10,000-file safety limit");
    media.option("--keep-frames", "Keep the PNG frames and frames.json after a validated encode");
  }
  media.action((root: string, options: Record<string, unknown>, command: Command) => runSingleMedia(kind, root, options, command));
}

program
  .command("render")
  .description("Render versioned recipe matrices with manifests and optional contact sheet/video. Several recipes share one process and one browser.")
  .argument("[root]", "Widget root", ".")
  .option("--recipe <id>", "Recipe id; repeat to render several in order", repeat, [])
  .option("--all", "Render every recipe of the widget, in order")
  .option("--output <directory>", "Validated output root")
  .option("--browser-path <file>", "Use an explicit Chromium or Chrome executable")
  .option("--ffmpeg-path <file>", "Use an explicit FFmpeg executable")
  .option("--ffprobe-path <file>", "Use an explicit ffprobe executable")
  .option("--force", "Replace only exact planned output files")
  .option("--dry-run", "Expand and print the matrix and disk estimate without writing files")
  .option("--allow-large-matrix", "Render a matrix above the configured safety limit")
  .option("--allow-large-render", "Allow a render plan above the 10,000-file safety limit")
  .option("--limit <count>", "Override the matrix limit", (value) => Number(value))
  .option("--allow-intermediate", "Accept PNG frame output when FFmpeg is unavailable")
  .option("--allow-low-disk", "Render even when the estimated peak exceeds 70% of free disk space")
  .option("--keep-frames", "Keep the PNG frames and frames.json after a validated encode (takes precedence over a recipe's keepFrames: false)")
  .option("--fps <count>", "Replace outputs.video.fps for this run; the manifest records the replaced recipe", (value) => Number(value))
  .option("--duration <ms>", "Replace outputs.video.durationMs for this run; the manifest records the replaced recipe", (value) => Number(value))
  .option("--plan-only", "Open Chrome once and print each tutorial variant's measured layout and camera plan, without frames or files")
  .option("--sheet-at <ms,...>", "Draw only these instants of the video, comma-separated, into <recipe>/sheet-at.png; no frames, video, or manifest", (value) => value.split(",").map((part) => (part.trim() === "" ? Number.NaN : Number(part))))
  .option("--no-wait", NO_WAIT_HELP)
  .option("--allow-unsupported-node", UNSUPPORTED_NODE_HELP)
  .action(async (
    root: string,
    options: {
      recipe: string[];
      all?: boolean;
      allowUnsupportedNode?: boolean;
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
      allowLowDisk?: boolean;
      keepFrames?: boolean;
      fps?: number;
      duration?: number;
      planOnly?: boolean;
      sheetAt?: number[];
      wait?: boolean;
    },
    command: Command
  ) => {
    const project = await projectFor(root, command);
    if (options.all === true && options.recipe.length > 0) throw new StudioError("RECIPE_SELECTION", "Pass --recipe <id> or --all, not both.");
    const ids = options.all === true ? project.recipes.map((item) => item.id) : options.recipe;
    if (ids.length === 0) throw new StudioError("RECIPE_SELECTION", options.all === true ? "This widget has no recipes." : "Pass --recipe <id> (repeatable) or --all.");
    const recipes = ids.map((id) => {
      const recipe = project.recipes.find((item) => item.id === id)?.value;
      if (!recipe) throw new StudioError("RECIPE_NOT_FOUND", `Recipe not found: ${id}`);
      return withVideoOverrides(recipe, {
        ...(options.fps !== undefined ? {fps: options.fps} : {}),
        ...(options.duration !== undefined ? {durationMs: options.duration} : {})
      });
    });
    const modes = [options.planOnly && "--plan-only", options.sheetAt && "--sheet-at", options.dryRun && "--dry-run"].filter(Boolean);
    if (modes.length > 1) throw new StudioError("RENDER_MODE", `Pass one of ${modes.join(", ")}, not several.`);
    const renderOptions = {
      cliFlags: cliFlags(command),
      ...(options.output ? {outputRoot: resolve(options.output)} : {}),
      ...(options.browserPath ? {browserPath: options.browserPath} : {}),
      ...(options.ffmpegPath ? {ffmpegPath: options.ffmpegPath} : {}),
      ...(options.ffprobePath ? {ffprobePath: options.ffprobePath} : {}),
      ...(options.force !== undefined ? {force: options.force} : {}),
      ...(options.dryRun !== undefined ? {dryRun: options.dryRun} : {}),
      ...(options.allowLargeMatrix !== undefined ? {allowLargeMatrix: options.allowLargeMatrix} : {}),
      ...(options.allowLargeRender !== undefined ? {allowLargeRender: options.allowLargeRender} : {}),
      ...(options.limit !== undefined ? {matrixLimit: options.limit} : {}),
      ...(options.allowIntermediate !== undefined ? {allowIntermediate: options.allowIntermediate} : {}),
      ...(options.allowLowDisk !== undefined ? {allowLowDisk: options.allowLowDisk} : {}),
      ...(options.keepFrames !== undefined ? {keepFrames: options.keepFrames} : {})
    };
    const results: (RenderResult | {plan: RenderResult["plan"]; status: "dry-run"; artifacts: never[]})[] = [];
    const report = () => {
      for (const result of results) for (const warning of result.plan.warnings ?? []) process.stderr.write(`Warning ${warning}\n`);
      print(results.length === 1 ? results[0] : results, globals(command).json);
    };
    if (options.planOnly) {
      // Every recipe is checked before the render slot, so a wrong one never waits for the machine.
      recipes.forEach(tutorialVideo);
      assertSupportedNode(options.allowUnsupportedNode === true);
      const plans: TutorialPlanResult[] = [];
      await inRenderSlot(async (machineFree) => {
        let shared: Awaited<ReturnType<typeof launchStudioBrowser>> | undefined;
        try {
          for (const recipe of recipes) {
            await machineFree();
            if (recipes.length > 1) shared ??= await launchStudioBrowser(options.browserPath ? {browserPath: options.browserPath} : {});
            plans.push(await planTutorialRecipe(project, recipe, {...renderOptions, ...(shared ? {browser: shared} : {})}));
          }
        } finally {
          if (shared) await closeStudioBrowser(shared.browser);
        }
      }, options.wait !== false);
      for (const result of plans) for (const warning of result.warnings ?? []) process.stderr.write(`Warning ${warning}\n`);
      const json = globals(command).json;
      print(json ? (plans.length === 1 ? plans[0] : plans) : tutorialPlanSummary(plans), json);
      return;
    }
    if (options.sheetAt) {
      const instants = options.sheetAt;
      // Every recipe is checked before the render slot, so a wrong one never waits for the machine.
      recipes.forEach((recipe) => sheetInstants(recipe, instants));
      assertSupportedNode(options.allowUnsupportedNode === true);
      const sheets: SheetAtResult[] = [];
      await inRenderSlot(async (machineFree) => {
        let shared: Awaited<ReturnType<typeof launchStudioBrowser>> | undefined;
        try {
          for (const recipe of recipes) {
            await machineFree();
            if (recipes.length > 1) shared ??= await launchStudioBrowser(options.browserPath ? {browserPath: options.browserPath} : {});
            sheets.push(await renderSheetAt(project, recipe, instants, {...renderOptions, ...(shared ? {browser: shared} : {})}));
          }
        } finally {
          if (shared) await closeStudioBrowser(shared.browser);
        }
      }, options.wait !== false);
      for (const result of sheets) {
        for (const warning of [...(result.warnings ?? []), ...result.variants.flatMap((variant) => variant.fontWarnings ?? [])]) {
          process.stderr.write(`Warning ${warning}\n`);
        }
      }
      const json = globals(command).json;
      const outputRoot = resolve(options.output ?? project.outputRoot);
      print(json ? (sheets.length === 1 ? sheets[0] : sheets) : sheets.map((sheet) => `${sheet.recipe}: ${resolve(outputRoot, sheet.sheet)} (${sheet.timestampsMs.join(", ")} ms)`).join("\n"), json);
      return;
    }
    if (options.dryRun) {
      for (const recipe of recipes) results.push(await planRecipe(project, recipe, renderOptions).then(({plan}) => ({plan, status: "dry-run" as const, artifacts: []})));
      report();
      return;
    }
    assertSupportedNode(options.allowUnsupportedNode === true);
    await inRenderSlot(async (machineFree) => {
      // Several recipes share one browser, started once the machine is free for the first.
      let shared: Awaited<ReturnType<typeof launchStudioBrowser>> | undefined;
      try {
        for (const recipe of recipes) {
          await machineFree();
          if (recipes.length > 1) shared ??= await launchStudioBrowser(options.browserPath ? {browserPath: options.browserPath} : {});
          const trace = renderTrace(command, recipes.length > 1 ? recipe.id : undefined);
          results.push(await renderRecipe(project, recipe, {...renderOptions, ...(shared ? {browser: shared} : {}), ...(trace ? {trace} : {})}));
        }
      } catch (error) {
        // What finished stays reported; the error then goes to stderr as for a single recipe.
        if (results.length > 0) report();
        throw error;
      } finally {
        if (shared) {
          const closing = await closeStudioBrowser(shared.browser);
          if (!closing.closed) process.stderr.write(`Browser close timed out; killed PID ${closing.killed.join(", ") || "none found"} after ${closing.elapsedMs} ms.\n`);
        }
      }
    }, options.wait !== false);
    report();
    if (results.some((result) => result.status === "intermediate") && !options.allowIntermediate) process.exitCode = 3;
  });

program
  .command("review")
  .description("Write one HTML page over render folders, each image and video under a short code (LT-03) to quote in a review.")
  .argument("<page>", "Page to write, ending in .html")
  .argument("<folders...>", "Recipe folders (with manifest.json), or output roots that hold them")
  .option("--title <text>", "Page title", "Review")
  .option("--force", "Replace an existing page")
  .action(async (page: string, folders: string[], options: {title: string; force?: boolean}, command: Command) => {
    const result = await writeReviewPage({page, folders, title: options.title, ...(options.force ? {force: true} : {})});
    const json = globals(command).json;
    print(json ? result : reviewSummary(result), json);
  });

/** One block per tutorial variant: its length and every camera key, for reading a plan without --json. */
function tutorialPlanSummary(plans: TutorialPlanResult[]): string {
  const lines: string[] = [];
  for (const result of plans) {
    for (const variant of result.variants) {
      const camera = variant.tutorialPlan.camera as unknown as {
        frame: {width: number};
        keys: {t: number; kind: string; view: {x: number; y: number; w: number}}[];
        holds: unknown[];
        repairedMoves: number[];
        fallback: boolean;
      };
      lines.push(`${result.recipe}/${variant.id}: ${variant.tutorialPlan.endMs} ms, ${camera.keys.length} camera keys, ${camera.holds.length} holds, ${camera.repairedMoves.length} repaired moves${camera.fallback ? ", strict fallback" : ""}`);
      for (const key of camera.keys) {
        const zoom = camera.frame.width / key.view.w;
        lines.push(`  ${String(Math.round(key.t)).padStart(7)} ms  ${key.kind.padEnd(8)} ${zoom.toFixed(2)}x at (${Math.round(key.view.x)}, ${Math.round(key.view.y)})`);
      }
      for (const warning of variant.fontWarnings ?? []) lines.push(`  Warning ${warning}`);
    }
  }
  lines.push("Pass --json for the measured layout and the full camera plan.");
  return lines.join("\n");
}

/** A finished command exits even if a stray handle, such as a browser that never exited, keeps the loop alive. */
function exitWhenIdle(): void {
  setTimeout(() => {
    process.stderr.write("se-widget-studio: still running 10 s after the result; exiting.\n");
    process.exit(process.exitCode ?? 0);
  }, 10_000).unref();
}

program.parseAsync(process.argv).then(exitWhenIdle, (error: unknown) => {
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
  exitWhenIdle();
});
