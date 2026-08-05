import {readFile} from "node:fs/promises";
import {dirname, relative, resolve, sep} from "node:path";
import {fileURLToPath} from "node:url";
import type {Browser, Page, PageScreenshotOptions} from "playwright-core";
import type {
  CaptureManifestEntry,
  CaptureVariant,
  JsonObject,
  RecipeDefinition,
  ResolvedProject,
  SceneDefinition,
  VideoDefinition
} from "../types.js";
import {StudioError} from "../shared/errors.js";
import {assertSafeOutputRoot, ensureOutputDirectory} from "../shared/paths.js";
import {stableStringify} from "../shared/json.js";
import {STUDIO_VERSION} from "../version.js";
import {loadMarketplacePreset, marketplaceRecipeIssues} from "../config/presets.js";
import {startStudioServer} from "../server/server.js";
import {buildAssetMap} from "../server/assets.js";
import {captureHostDispatch, frameEvents, openScene, sampleFrameAnimations} from "../scenarios/runner.js";
import {DEFAULT_FIXED_TIME, DEFAULT_SEED} from "../scenarios/state.js";
import {launchStudioBrowser} from "./browser.js";
import {hashFile, hashJson, sha256} from "./hash.js";
import {assertRecipeMatrixCardinality, expandRecipe} from "./matrix.js";
import {detectMediaTooling, encodeFrameSequence, type MediaTooling} from "./media.js";
import {atomicWriteFile, createAtomicTarget, preflightOutputTargets} from "./output.js";
import {findExecutable, runExecutable} from "../validation/tools.js";
import {assertPublicSafeProject} from "../validation/privacy.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const DEFAULT_RENDER_TARGET_LIMIT = 10_000;

export interface RenderOptions {
  outputRoot?: string;
  force?: boolean;
  dryRun?: boolean;
  allowLargeMatrix?: boolean;
  allowLargeRender?: boolean;
  matrixLimit?: number;
  allowIntermediate?: boolean;
  browserPath?: string;
  headed?: boolean;
  ffmpegPath?: string;
  ffprobePath?: string;
}

export interface RenderPlan {
  recipe: string;
  outputRoot: string;
  variants: {id: string; scene: string; theme: string | null; output: {width: number; height: number}}[];
  targets: string[];
  count: number;
  totalFrames: number;
  totalTargets: number;
}

export interface RenderResult {
  plan: RenderPlan;
  status: "dry-run" | "final" | "intermediate" | "unvalidated";
  manifestPath?: string;
  artifacts: string[];
}

interface InputSnapshot {
  digest: string;
  inputHashes: JsonObject;
  sourceHashes: JsonObject;
  assetHashes: JsonObject;
}

interface RenderWorkload {
  totalFrames: bigint;
  totalTargets: bigint;
}

function portable(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function imageDimensions(buffer: Buffer): {width: number; height: number} | undefined {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return {width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20)};
  }
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return undefined;
  let offset = 2;
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  while (offset + 8 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === undefined) break;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x00 || marker === 0xff || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > buffer.length) break;
    if (startOfFrame.has(marker)) {
      return {height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7)};
    }
    offset += 2 + length;
  }
  return undefined;
}

function mimeType(path: string): string {
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".mp4")) return "video/mp4";
  if (path.endsWith(".webm")) return "video/webm";
  if (path.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

async function describeArtifact(
  outputRoot: string,
  path: string,
  dimensions?: {width: number; height: number}
): Promise<JsonObject> {
  const bytes = await readFile(path);
  const decodedDimensions = imageDimensions(bytes) ?? dimensions;
  return {
    file: portable(outputRoot, path),
    mimeType: mimeType(path),
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
    ...(decodedDimensions ? decodedDimensions : {})
  };
}

async function captureInputSnapshot(project: ResolvedProject, recipe: RecipeDefinition): Promise<InputSnapshot> {
  const inputHashes: JsonObject = {};
  for (const [kind, filePath] of Object.entries(project.files)) inputHashes[kind] = await hashFile(filePath);
  if (project.configPath) inputHashes.config = await hashFile(project.configPath);
  inputHashes.resolvedConfig = hashJson(JSON.parse(JSON.stringify(project.config)) as JsonObject);
  inputHashes.themes = hashJson(JSON.parse(JSON.stringify(project.themes.map((item) => item.value))));
  inputHashes.fixtures = hashJson(JSON.parse(JSON.stringify(project.fixtures.map((item) => item.value))));
  inputHashes.scenes = hashJson(JSON.parse(JSON.stringify(project.scenes.map((item) => item.value))));
  inputHashes.recipe = hashJson(JSON.parse(JSON.stringify(recipe)) as JsonObject);

  const sourceHashes: JsonObject = {};
  const catalogs = [
    ["theme", project.themes],
    ["fixture", project.fixtures],
    ["scene", project.scenes],
    ["scenario", project.scenarios],
    ["recipe", project.recipes]
  ] as const;
  for (const [kind, items] of catalogs) {
    for (const item of items) {
      if (item.filePath) sourceHashes[`${kind}:${item.id}`] = await hashFile(item.filePath);
    }
  }
  if (project.adapterPath) sourceHashes.adapter = await hashFile(project.adapterPath);

  const assetHashes: JsonObject = {};
  const assets = await buildAssetMap(project);
  for (const [key, asset] of [...assets.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    assetHashes[key] = await hashFile(asset.filePath);
  }
  inputHashes.assets = hashJson(assetHashes);
  const digest = hashJson({inputHashes, sourceHashes, assetHashes});
  return {digest, inputHashes, sourceHashes, assetHashes};
}

async function assertInputsUnchanged(project: ResolvedProject, recipe: RecipeDefinition, expected: InputSnapshot): Promise<void> {
  const current = await captureInputSnapshot(project, recipe);
  if (current.digest !== expected.digest) {
    throw new StudioError(
      "INPUT_CHANGED_DURING_RENDER",
      "Widget source, configuration, catalog data, adapter, or an allowlisted asset changed during rendering.",
      "Review the edits, then rerun the complete recipe with --force so every variant uses one input snapshot."
    );
  }
}

async function widgetCommit(widgetRoot: string): Promise<string | null> {
  const git = await findExecutable("git");
  if (!git) return null;
  const result = await runExecutable(git, ["rev-parse", "HEAD"], {cwd: widgetRoot, maxOutputBytes: 1024});
  return result.code === 0 && /^[a-f0-9]{40,64}$/i.test(result.stdout.trim()) ? result.stdout.trim() : null;
}

function targetPaths(
  outputRoot: string,
  recipe: RecipeDefinition,
  variants: CaptureVariant[],
  includeVideo: boolean
): string[] {
  const targets: string[] = [];
  const directory = resolve(outputRoot, recipe.id);
  const screenshots = recipe.outputs?.screenshots !== false;
  for (const variant of variants) {
    const format = variant.output.format ?? "png";
    if (screenshots) targets.push(resolve(directory, `${variant.id}.${format === "jpeg" ? "jpg" : "png"}`));
    const thumbnail = recipe.outputs?.thumbnails;
    if (thumbnail) {
      targets.push(resolve(directory, `${variant.id}-thumb.${thumbnail.format === "jpeg" ? "jpg" : "png"}`));
    }
    const video = recipe.outputs?.video;
    if (video?.enabled) {
      const frameCount = videoFrameCount(video);
      for (let index = 0; index < frameCount; index += 1) {
        targets.push(resolve(directory, variant.id, "frames", `frame-${String(index).padStart(4, "0")}.png`));
      }
      targets.push(resolve(directory, variant.id, "frames", "frames.json"));
      if (includeVideo) targets.push(resolve(directory, `${variant.id}.${video.format ?? "mp4"}`));
    }
  }
  if (recipe.outputs?.contactSheet) targets.push(resolve(directory, "contact-sheet.png"));
  targets.push(resolve(directory, "manifest.json"));
  return targets;
}

function videoFrameCount(video: VideoDefinition): number {
  if (!Number.isSafeInteger(video.durationMs) || video.durationMs < 1) {
    throw new StudioError("VIDEO_TIMING_INVALID", `Video durationMs must be a positive safe integer; received ${String(video.durationMs)}.`);
  }
  if (!Number.isSafeInteger(video.fps) || video.fps < 1) {
    throw new StudioError("VIDEO_TIMING_INVALID", `Video fps must be a positive safe integer; received ${String(video.fps)}.`);
  }
  const count = (BigInt(video.durationMs) * BigInt(video.fps) + 500n) / 1000n;
  const normalized = count > 0n ? count : 1n;
  if (normalized > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new StudioError(
      "RENDER_LIMIT_EXCEEDED",
      `Video timing expands to ${normalized.toString()} frames per variant, which cannot be represented safely.`
    );
  }
  return Number(normalized);
}

function renderWorkload(
  recipe: RecipeDefinition,
  variantCount: bigint,
  includeVideo: boolean
): RenderWorkload {
  const video = recipe.outputs?.video?.enabled ? recipe.outputs.video : undefined;
  const frameCountPerVariant = video ? videoFrameCount(video) : 0;
  let targetsPerVariant = 0n;
  if (recipe.outputs?.screenshots !== false) targetsPerVariant += 1n;
  if (recipe.outputs?.thumbnails) targetsPerVariant += 1n;
  if (video) targetsPerVariant += BigInt(frameCountPerVariant) + 1n + (includeVideo ? 1n : 0n);
  const totalFrames = variantCount * BigInt(frameCountPerVariant);
  const totalTargets = variantCount * targetsPerVariant
    + (recipe.outputs?.contactSheet ? 1n : 0n)
    + 1n;
  return {totalFrames, totalTargets};
}

function assertRenderWorkload(recipe: RecipeDefinition, workload: RenderWorkload, allowLargeRender: boolean): void {
  const maximumSafeCount = BigInt(Number.MAX_SAFE_INTEGER);
  if (workload.totalTargets > maximumSafeCount || workload.totalFrames > maximumSafeCount) {
    throw new StudioError(
      "RENDER_LIMIT_EXCEEDED",
      `Recipe "${recipe.id}" expands to ${workload.totalFrames.toString()} video frames and ${workload.totalTargets.toString()} planned files, which cannot be represented safely.`,
      "Reduce the matrix or video duration. --allow-large-render cannot bypass the safe-integer boundary."
    );
  }
  if (workload.totalTargets > BigInt(DEFAULT_RENDER_TARGET_LIMIT) && !allowLargeRender) {
    throw new StudioError(
      "RENDER_LIMIT_EXCEEDED",
      `Recipe "${recipe.id}" expands to ${workload.totalFrames.toString()} video frames and ${workload.totalTargets.toString()} planned files, above the limit of ${DEFAULT_RENDER_TARGET_LIMIT}.`,
      "Reduce the matrix, duration, or FPS, or pass --allow-large-render after reviewing the workload."
    );
  }
}

async function replayUntil(page: Page, variant: CaptureVariant, targetTimeMs: number): Promise<void> {
  let currentTime = 0;
  for (const timelineEvent of [...(variant.fixture?.events ?? [])].sort((left, right) => left.atMs - right.atMs)) {
    if (timelineEvent.atMs > targetTimeMs) break;
    const delta = timelineEvent.atMs - currentTime;
    if (delta > 0) await page.clock.fastForward(delta);
    await sampleFrameAnimations(page, timelineEvent.atMs);
    await captureHostDispatch(page, timelineEvent.listener, timelineEvent.event);
    await sampleFrameAnimations(page, timelineEvent.atMs);
    await page.clock.fastForward(1);
    currentTime = timelineEvent.atMs + 1;
  }
  if (targetTimeMs > currentTime) await page.clock.fastForward(targetTimeMs - currentTime);
  await sampleFrameAnimations(page, targetTimeMs);
}

async function screenshotScene(
  page: Page,
  variant: CaptureVariant,
  outputRoot: string,
  target: string
): Promise<void> {
  const atomic = await createAtomicTarget(outputRoot, target);
  const format = variant.output.format ?? "png";
  const base: PageScreenshotOptions = {
    path: atomic.temporaryPath,
    type: format,
    scale: "css",
    animations: "allow",
    omitBackground: format === "png" && (variant.background.color === "transparent" || !variant.background.color)
  };
  if (format === "jpeg") base.quality = variant.output.quality ?? 90;
  if (variant.scene.crop) {
    const crop = variant.scene.crop;
    await page.screenshot({...base, clip: crop});
  } else {
    await page.locator("#capture-stage").screenshot(base);
  }
  await atomic.commit();
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

async function renderThumbnail(
  browser: Browser,
  sourcePath: string,
  outputRoot: string,
  target: string,
  thumbnail: NonNullable<RecipeDefinition["outputs"]>["thumbnails"]
): Promise<void> {
  if (!thumbnail) return;
  const page = await browser.newPage({viewport: {width: thumbnail.width, height: thumbnail.height}, deviceScaleFactor: 1});
  try {
    const extension = sourcePath.endsWith(".jpg") ? "jpeg" : "png";
    const data = (await readFile(sourcePath)).toString("base64");
    await page.setContent(`<!doctype html><style>*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}img{display:block;width:100%;height:100%;object-fit:${thumbnail.fit ?? "contain"}}</style><img alt="" src="data:image/${extension};base64,${data}">`);
    await page.locator("img").evaluate(async (image) => (image as HTMLImageElement).decode());
    const atomic = await createAtomicTarget(outputRoot, target);
    const type = thumbnail.format ?? "png";
    await page.screenshot({path: atomic.temporaryPath, type, ...(type === "jpeg" ? {quality: 88} : {})});
    await atomic.commit();
  } finally {
    await page.close();
  }
}

async function renderContactSheet(
  browser: Browser,
  items: {id: string; path: string}[],
  outputRoot: string,
  target: string
): Promise<void> {
  const width = 1600;
  const columns = Math.min(3, Math.max(1, items.length));
  const rows = Math.max(1, Math.ceil(items.length / columns));
  const height = 80 + rows * 390;
  const page = await browser.newPage({viewport: {width, height}, deviceScaleFactor: 1});
  try {
    const cells = await Promise.all(
      items.map(async (item) => {
        const mime = item.path.endsWith(".jpg") ? "jpeg" : "png";
        const data = (await readFile(item.path)).toString("base64");
        return `<figure><div><img alt="" src="data:image/${mime};base64,${data}"></div><figcaption>${escapeHtml(item.id)}</figcaption></figure>`;
      })
    );
    await page.setContent(`<!doctype html><style>
      *{box-sizing:border-box}html,body{margin:0;background:#0b0d12;color:#e9edf5;font:14px ui-monospace,SFMono-Regular,Menlo,monospace}
      main{padding:32px;display:grid;grid-template-columns:repeat(${columns},1fr);gap:24px}
      figure{margin:0;min-width:0}figure>div{height:326px;display:grid;place-items:center;overflow:hidden;background:#171b23;border:1px solid #2c3340}
      img{display:block;width:100%;height:100%;object-fit:contain}figcaption{padding:12px 2px 0;color:#aeb8c8;overflow-wrap:anywhere}
    </style><main>${cells.join("")}</main>`);
    await Promise.all(await page.locator("img").evaluateAll((images) => images.map((image) => (image as HTMLImageElement).decode())));
    const atomic = await createAtomicTarget(outputRoot, target);
    await page.screenshot({path: atomic.temporaryPath, type: "png", fullPage: true});
    await atomic.commit();
  } finally {
    await page.close();
  }
}

async function renderVideoFrames(options: {
  project: ResolvedProject;
  server: Awaited<ReturnType<typeof startStudioServer>>;
  browser: Browser;
  variant: CaptureVariant;
  video: VideoDefinition;
  outputRoot: string;
  recipeDirectory: string;
}): Promise<{framesDirectory: string; framesManifest: string}> {
  const opened = await openScene(options.project, options.server, options.browser, options.variant.scene);
  const framesDirectory = resolve(options.recipeDirectory, options.variant.id, "frames");
  const frameCount = videoFrameCount(options.video);
  const frames: {file: string; timestampMs: number; sha256: string}[] = [];
  let currentTime = 0;
  let eventIndex = 0;
  const events = [...(options.variant.fixture?.events ?? [])].sort((left, right) => left.atMs - right.atMs);
  try {
    for (let index = 0; index < frameCount; index += 1) {
      const timestampMs = Math.round((index * 1000) / options.video.fps);
      while (events[eventIndex] && events[eventIndex]!.atMs <= timestampMs) {
        const timelineEvent = events[eventIndex]!;
        const delta = timelineEvent.atMs - currentTime;
        if (delta > 0) await opened.page.clock.fastForward(delta);
        await sampleFrameAnimations(opened.page, timelineEvent.atMs);
        await captureHostDispatch(opened.page, timelineEvent.listener, timelineEvent.event);
        await sampleFrameAnimations(opened.page, timelineEvent.atMs);
        await opened.page.clock.fastForward(1);
        currentTime = timelineEvent.atMs + 1;
        eventIndex += 1;
      }
      if (timestampMs > currentTime) {
        await opened.page.clock.fastForward(timestampMs - currentTime);
        currentTime = timestampMs;
      }
      await sampleFrameAnimations(opened.page, timestampMs);
      const target = resolve(framesDirectory, `frame-${String(index).padStart(4, "0")}.png`);
      await screenshotScene(opened.page, {...options.variant, output: {...options.variant.output, format: "png"}}, options.outputRoot, target);
      frames.push({file: portable(framesDirectory, target), timestampMs, sha256: await hashFile(target)});
    }
    const runtimeErrors = (await frameEvents(opened.page)).filter(
      (event) => event.type === "frame:error" || event.type === "frame:unhandled-rejection"
    );
    if (runtimeErrors.length > 0 || opened.issues.errors.length > 0) {
      throw new StudioError(
        "VIDEO_RUNTIME_ERROR",
        [...opened.issues.errors, ...runtimeErrors.map((event) => JSON.stringify(event.payload))].join("; ")
      );
    }
  } finally {
    await opened.context.close();
  }
  const framesManifest = resolve(framesDirectory, "frames.json");
  await atomicWriteFile(
    options.outputRoot,
    framesManifest,
    `${stableStringify(
      {
        schemaVersion: 1,
        fps: options.video.fps,
        durationMs: options.video.durationMs,
        width: options.variant.scene.crop?.width ?? options.variant.output.width,
        height: options.variant.scene.crop?.height ?? options.variant.output.height,
        pattern: "frame-%04d.png",
        frames
      },
      2
    )}\n`
  );
  return {framesDirectory, framesManifest};
}

export async function planRecipe(
  project: ResolvedProject,
  recipe: RecipeDefinition,
  options: RenderOptions = {}
): Promise<{
  plan: RenderPlan;
  variants: CaptureVariant[];
  outputRoot: string;
  tooling: MediaTooling;
  marketplacePreset?: Awaited<ReturnType<typeof loadMarketplacePreset>>;
}> {
  assertPublicSafeProject(project);
  const outputRoot = await assertSafeOutputRoot(resolve(options.outputRoot ?? project.outputRoot), [
    process.cwd(),
    project.widgetRoot,
    project.inputDirectory,
    packageRoot
  ]);
  const matrixOptions = {
    ...(options.matrixLimit !== undefined ? {limit: options.matrixLimit} : {}),
    ...(options.allowLargeMatrix !== undefined ? {allowLargeMatrix: options.allowLargeMatrix} : {})
  };
  const variantCount = assertRecipeMatrixCardinality(project, recipe, matrixOptions);
  const tooling = await detectMediaTooling({
    ...(options.ffmpegPath ? {ffmpegPath: options.ffmpegPath} : {}),
    ...(options.ffprobePath ? {ffprobePath: options.ffprobePath} : {})
  });
  const workload = renderWorkload(recipe, variantCount, Boolean(tooling.ffmpegPath));
  assertRenderWorkload(recipe, workload, options.allowLargeRender ?? false);
  const variants = expandRecipe(project, recipe, {
    ...matrixOptions
  });
  const video = recipe.outputs?.video?.enabled ? recipe.outputs.video : undefined;
  const pixelFormat = video?.pixelFormat ?? "yuv420p";
  if (video && (pixelFormat === "yuv420p" || pixelFormat === "yuva420p")) {
    for (const variant of variants) {
      const width = variant.scene.crop?.width ?? variant.output.width;
      const height = variant.scene.crop?.height ?? variant.output.height;
      if (width % 2 !== 0 || height % 2 !== 0) {
        throw new StudioError(
          "VIDEO_DIMENSIONS_INVALID",
          `Variant "${variant.id}" is ${width}x${height}; 4:2:0 video requires even width and height.`
        );
      }
    }
  }
  const marketplacePreset = recipe.marketplacePreset
    ? await loadMarketplacePreset(recipe.marketplacePreset)
    : undefined;
  if (marketplacePreset) {
    const issues = marketplaceRecipeIssues(recipe, marketplacePreset, variants);
    if (issues.length > 0) {
      throw new StudioError(
        "MARKETPLACE_RECIPE_INVALID",
        `Recipe "${recipe.id}" does not satisfy preset "${marketplacePreset.id}": ${issues.join("; ")}.`
      );
    }
  }
  const targets = targetPaths(outputRoot, recipe, variants, Boolean(tooling.ffmpegPath));
  const result = {
    outputRoot,
    variants,
    tooling,
    plan: {
      recipe: recipe.id,
      outputRoot,
      variants: variants.map((variant) => ({
        id: variant.id,
        scene: variant.scene.id,
        theme: variant.theme?.id ?? null,
        output: {
          width: variant.scene.crop?.width ?? variant.output.width,
          height: variant.scene.crop?.height ?? variant.output.height
        }
      })),
      targets,
      count: variants.length,
      totalFrames: Number(workload.totalFrames),
      totalTargets: Number(workload.totalTargets)
    }
  };
  return marketplacePreset ? {...result, marketplacePreset} : result;
}

export async function renderRecipe(
  project: ResolvedProject,
  recipe: RecipeDefinition,
  options: RenderOptions = {}
): Promise<RenderResult> {
  const {plan, variants, outputRoot, tooling, marketplacePreset} = await planRecipe(project, recipe, options);
  if (options.dryRun) return {plan, status: "dry-run", artifacts: []};
  await ensureOutputDirectory(outputRoot);
  await preflightOutputTargets(outputRoot, plan.targets, options.force ?? false);
  const renderProject: ResolvedProject = outputRoot === project.outputRoot ? project : {...project, outputRoot};
  const inputSnapshot = await captureInputSnapshot(renderProject, recipe);

  const server = await startStudioServer(renderProject, {port: 0, watch: false});
  const recipeDirectory = resolve(outputRoot, recipe.id);
  const artifacts: string[] = [];
  const entries: CaptureManifestEntry[] = [];
  let status: RenderResult["status"] = "final";
  let browser: Browser | undefined;
  try {
    const launched = await launchStudioBrowser({
      ...(options.browserPath ? {browserPath: options.browserPath} : {}),
      ...(options.headed !== undefined ? {headed: options.headed} : {})
    });
    browser = launched.browser;
    const detection = launched.detection;
    const contactItems: {id: string; path: string}[] = [];
    let contactSheetPath: string | undefined;
    for (const variant of variants) {
      await assertInputsUnchanged(renderProject, recipe, inputSnapshot);
      let screenshotPath: string | undefined;
      let thumbnailPath: string | undefined;
      let videoPath: string | undefined;
      let framesPath: string | undefined;
      let framesManifestPath: string | undefined;
      let videoDimensions: {width: number; height: number} | undefined;
      if (recipe.outputs?.screenshots !== false) {
        const resolvedScene = await openScene(renderProject, server, browser, variant.scene);
        try {
          await replayUntil(resolvedScene.page, variant, variant.scene.captureAtMs ?? 0);
          const runtimeErrors = (await frameEvents(resolvedScene.page)).filter(
            (event) => event.type === "frame:error" || event.type === "frame:unhandled-rejection"
          );
          if (runtimeErrors.length > 0 || resolvedScene.issues.errors.length > 0) {
            throw new StudioError(
              "CAPTURE_RUNTIME_ERROR",
              [...resolvedScene.issues.errors, ...runtimeErrors.map((event) => JSON.stringify(event.payload))].join("; ")
            );
          }
          const extension = (variant.output.format ?? "png") === "jpeg" ? "jpg" : "png";
          screenshotPath = resolve(recipeDirectory, `${variant.id}.${extension}`);
          await screenshotScene(resolvedScene.page, variant, outputRoot, screenshotPath);
          artifacts.push(screenshotPath);
          contactItems.push({id: variant.id, path: screenshotPath});
        } finally {
          await resolvedScene.context.close();
        }
      }

      if (recipe.outputs?.thumbnails && screenshotPath) {
        const extension = recipe.outputs.thumbnails.format === "jpeg" ? "jpg" : "png";
        thumbnailPath = resolve(recipeDirectory, `${variant.id}-thumb.${extension}`);
        await renderThumbnail(browser, screenshotPath, outputRoot, thumbnailPath, recipe.outputs.thumbnails);
        artifacts.push(thumbnailPath);
      }

      const video = recipe.outputs?.video;
      if (video?.enabled) {
        const renderedFrames = await renderVideoFrames({
          project: renderProject,
          server,
          browser,
          variant,
          video,
          outputRoot,
          recipeDirectory
        });
        framesPath = renderedFrames.framesDirectory;
        framesManifestPath = renderedFrames.framesManifest;
        artifacts.push(renderedFrames.framesManifest);
        if (tooling.ffmpegPath) {
          videoPath = resolve(recipeDirectory, `${variant.id}.${video.format ?? "mp4"}`);
          const encoded = await encodeFrameSequence({
            outputRoot,
            framePattern: resolve(renderedFrames.framesDirectory, "frame-%04d.png"),
            outputPath: videoPath,
            video,
            force: options.force ?? false,
            tooling,
            expectedWidth: Math.round(
              variant.scene.crop?.width ?? variant.output.width
            ),
            expectedHeight: Math.round(
              variant.scene.crop?.height ?? variant.output.height
            ),
            ...(marketplacePreset?.validation?.video?.maximumBytes
              ? {maximumBytes: marketplacePreset.validation.video.maximumBytes}
              : {})
          });
          videoDimensions = {
            width: variant.scene.crop?.width ?? variant.output.width,
            height: variant.scene.crop?.height ?? variant.output.height
          };
          status = encoded.status === "unvalidated" ? "unvalidated" : status;
          artifacts.push(videoPath);
        } else {
          status = "intermediate";
        }
      }

      const hashes: JsonObject = {};
      if (screenshotPath) hashes.screenshot = await hashFile(screenshotPath);
      if (thumbnailPath) hashes.thumbnail = await hashFile(thumbnailPath);
      if (videoPath) hashes.video = await hashFile(videoPath);
      if (framesManifestPath) hashes.framesManifest = await hashFile(framesManifestPath);
      const files: JsonObject = {};
      if (screenshotPath) files.screenshot = await describeArtifact(outputRoot, screenshotPath);
      if (thumbnailPath) files.thumbnail = await describeArtifact(outputRoot, thumbnailPath);
      if (videoPath) files.video = await describeArtifact(outputRoot, videoPath, videoDimensions);
      if (framesManifestPath) files.framesManifest = await describeArtifact(outputRoot, framesManifestPath);
      entries.push({
        id: variant.id,
        scene: variant.scene.id,
        theme: variant.theme?.id ?? null,
        fixture: variant.fixture?.id ?? null,
        screenshot: screenshotPath ? portable(outputRoot, screenshotPath) : null,
        thumbnail: thumbnailPath ? portable(outputRoot, thumbnailPath) : null,
        video: videoPath ? portable(outputRoot, videoPath) : null,
        frames: framesPath ? portable(outputRoot, framesPath) : null,
        parameters: JSON.parse(JSON.stringify({
          background: variant.background,
          viewport: variant.viewport,
          output: variant.output,
          camera: variant.camera,
          crop: variant.scene.crop ?? null
        })) as JsonObject,
        hashes,
        files
      });
    }

    if (recipe.outputs?.contactSheet && contactItems.length > 0) {
      contactSheetPath = resolve(recipeDirectory, "contact-sheet.png");
      await renderContactSheet(browser, contactItems, outputRoot, contactSheetPath);
      artifacts.push(contactSheetPath);
    }
    await assertInputsUnchanged(renderProject, recipe, inputSnapshot);
    const manifestPath = resolve(recipeDirectory, "manifest.json");
    const manifest = {
      schemaVersion: 1,
      status,
      generatedAt: new Date().toISOString(),
      studio: {name: "se-widget-studio", version: STUDIO_VERSION},
      runtime: {seed: DEFAULT_SEED, fixedTime: DEFAULT_FIXED_TIME, locale: "en-US", timezone: "UTC"},
      widget: {
        files: project.relativeFiles,
        resolvedConfig: renderProject.config,
        commit: await widgetCommit(renderProject.widgetRoot),
        inputDigest: inputSnapshot.digest,
        inputHashes: inputSnapshot.inputHashes,
        sourceHashes: inputSnapshot.sourceHashes,
        assetHashes: inputSnapshot.assetHashes
      },
      recipe,
      marketplacePreset: marketplacePreset ?? null,
      browser: {path: detection.executablePath ?? null, version: browser.version()},
      media: tooling,
      contactSheet: contactSheetPath
        ? await describeArtifact(outputRoot, contactSheetPath)
        : null,
      artifacts: entries
    };
    await atomicWriteFile(outputRoot, manifestPath, `${stableStringify(JSON.parse(JSON.stringify(manifest)), 2)}\n`);
    artifacts.push(manifestPath);
    return {plan, status, manifestPath, artifacts};
  } finally {
    await browser?.close();
    await server.close();
  }
}

export function singleSceneRecipe(
  scene: SceneDefinition,
  options: {video?: boolean; contactSheet?: boolean} = {}
): RecipeDefinition {
  return {
    schemaVersion: 1,
    id: options.video ? `record-${scene.id}` : `capture-${scene.id}`,
    name: options.video ? `Record ${scene.name}` : `Capture ${scene.name}`,
    scenes: [scene.id],
    outputs: options.video
      ? {
          screenshots: false,
          video: {
            enabled: true,
            durationMs: 5_000,
            fps: 30,
            format: "mp4",
            codec: "h264",
            pixelFormat: "yuv420p",
            audio: "none"
          }
        }
      : {screenshots: true, contactSheet: options.contactSheet ?? false}
  };
}
