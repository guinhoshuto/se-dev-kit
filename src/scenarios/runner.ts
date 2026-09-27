import type {Browser, BrowserContext, Frame, Page} from "playwright-core";
import type {
  FixtureDefinition,
  FontReport,
  ResolvedProject,
  ResolvedWidgetFiles,
  ScenarioDefinition,
  ScenarioStep,
  SceneDefinition
} from "../types.js";
import {StudioError} from "../shared/errors.js";
import {assetUrlPath} from "../server/assets.js";
import {startStudioServer, type StudioServer} from "../server/server.js";
import {createIsolatedContext, launchStudioBrowser, observePage, type BrowserIssueLog, type FontRoute} from "../capture/browser.js";
import {checkFonts} from "../capture/fonts.js";
import {FontsMissingError, isFontsMissing, type FontResolver} from "../fonts/resolver.js";
import {createDefaultScene, resolveSceneState, type ResolvedSceneState} from "./state.js";
import {assertPublicSafeProject} from "../validation/privacy.js";
import {claimsSampleMediaScheme} from "../studio-ui/sample-media.js";

export interface ScenarioResult {
  id: string;
  name: string;
  status: "passed" | "failed";
  durationMs: number;
  errors: string[];
  warnings: string[];
}

export interface OpenSceneResult {
  context: BrowserContext;
  page: Page;
  issues: BrowserIssueLog;
  resolved: ResolvedSceneState;
  frame: () => Frame;
  /** The job's font package, when the capture replays one (hosted jobs). */
  fonts?: FontResolver;
}

export async function backgroundForBrowser(
  background: ResolvedSceneState["background"],
  server: Pick<StudioServer, "frameOrigin" | "sampleMediaUrl">
): Promise<ResolvedSceneState["background"]> {
  const frameOrigin = server.frameOrigin;
  const image = background.image;
  if (!image) return background;
  // Built-in samples resolve only through the verified manifest, before the generic scheme block.
  if (claimsSampleMediaScheme(image)) return {...background, image: await server.sampleMediaUrl(image)};
  if (/^(?:data|blob):/i.test(image)) return background;
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/|\/)/i.test(image)) {
    throw new StudioError(
      "EXTERNAL_BACKGROUND_BLOCKED",
      `Background image must be a local widget asset or data URL: ${image}`
    );
  }
  return {...background, image: `${frameOrigin}${assetUrlPath(image)}`};
}

async function captureHostLoad(page: Page, payload: unknown): Promise<void> {
  await page.evaluate(async (options) => {
    const captureWindow = window as unknown as {__SWS_CAPTURE__: {load: (value: unknown) => Promise<void>}};
    await captureWindow.__SWS_CAPTURE__.load(options);
  }, payload);
}

/** Real time a settle may take in a capture before it fails with FONT_SETTLE_TIMEOUT. */
export const SETTLE_DEADLINE_MS = 20_000;

function settlingStarted(events: {type: string}[]): boolean {
  let settling = false;
  for (const event of events) {
    if (event.type === "frame:settling") settling = true;
    else if (event.type === "frame:fonts") settling = false;
  }
  return settling;
}

function settleTimeout(deadlineMs: number, detail = ""): StudioError {
  return new StudioError(
    "FONT_SETTLE_TIMEOUT",
    `Widget fonts and stylesheets did not settle within ${deadlineMs}ms of real time.${detail ? ` ${detail}` : ""}`,
    "A stylesheet or font the widget requested never finished loading."
  );
}

interface FrameFontState {
  phase: string;
  pendingStylesheets: string[];
  fontsStatus: string;
  loadingFaces: string[];
}

/**
 * What the widget frame's settle() was still waiting for, and the Google Fonts requests the
 * browser had not finished, so a FONT_SETTLE_TIMEOUT from an environment that cannot be
 * reproduced locally (the hosted Sandbox) names its cause. Never throws.
 */
export async function describePendingFonts(page: Page, issues?: Pick<BrowserIssueLog, "pendingFonts">): Promise<string> {
  const parts: string[] = [];
  const frame = page.frames().find((candidate) => candidate !== page.mainFrame() && candidate.url().includes("/__sws/frame/"));
  const state = frame
    ? await Promise.race([
        frame
          .evaluate(() => (window as unknown as {__SE_WIDGET_STUDIO__?: {fontState?: () => unknown}}).__SE_WIDGET_STUDIO__?.fontState?.())
          .catch(() => undefined),
        new Promise<undefined>((resolvePromise) => setTimeout(() => resolvePromise(undefined), 1_000))
      ]) as FrameFontState | undefined
    : undefined;
  if (state) {
    parts.push(`Settle phase: ${state.phase}.`);
    if (state.pendingStylesheets.length) parts.push(`Stylesheets without load or error: ${state.pendingStylesheets.join(", ")}.`);
    parts.push(`document.fonts.status: ${state.fontsStatus}.`);
    if (state.loadingFaces.length) parts.push(`Faces still loading: ${state.loadingFaces.join("; ")}.`);
  } else {
    parts.push("The frame did not report its font state.");
  }
  if (issues?.pendingFonts.size) parts.push(`Google Fonts requests without a response: ${Array.from(issues.pendingFonts).slice(0, 10).join(", ")}.`);
  return parts.join(" ");
}

/**
 * Runs `task` against a real-time deadline kept in Node: the page's own timers stop while the
 * capture clock is paused, so they cannot bound it.
 */
async function withRealDeadline<T>(task: Promise<T>, deadlineMs: number, onTimeout: () => Promise<Error>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"expired">((resolvePromise) => {
    timer = setTimeout(() => resolvePromise("expired"), deadlineMs);
  });
  try {
    const result = await Promise.race([task, expired]);
    if (result === "expired") {
      task.catch(() => undefined);
      throw await onTimeout();
    }
    return result as T;
  } finally {
    clearTimeout(timer);
  }
}

async function commandTimeout(page: Page, label: string, deadlineMs: number): Promise<Error> {
  const events = await frameEvents(page).catch(() => []);
  if (settlingStarted(events)) return settleTimeout(deadlineMs, await describePendingFonts(page));
  return new StudioError("CAPTURE_COMMAND_TIMEOUT", `Widget command ${label} did not finish within ${deadlineMs}ms of real time.`);
}

async function captureHostLoadWithClock(
  page: Page,
  payload: unknown,
  timeoutMs: number,
  readySelector: string | undefined,
  issues?: Pick<BrowserIssueLog, "pendingFonts">
): Promise<void> {
  let settled = false;
  let failure: unknown;
  const pending = captureHostLoad(page, payload)
    .catch((error: unknown) => {
      failure = error;
    })
    .finally(() => {
      settled = true;
    });
  const deadline = Date.now() + timeoutMs + 5_000;
  let assetsReady = false;
  while (!settled && !assetsReady) {
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    if (settled) break;
    const events = await frameEvents(page);
    if (Date.now() > deadline) {
      if (settlingStarted(events)) throw settleTimeout(timeoutMs + 5_000, await describePendingFonts(page, issues));
      throw new StudioError("CAPTURE_READY_TIMEOUT", `Widget capture host timed out after ${timeoutMs + 5_000}ms.`);
    }
    assetsReady = events.some((event) => event.type === "frame:assets-ready");
  }
  if (!settled && assetsReady && readySelector) {
    let virtualElapsed = 0;
    while (!settled && virtualElapsed < timeoutMs) {
      const widgetFrame = page.frames().find((frame) => frame !== page.mainFrame() && frame.url().includes("/__sws/frame/"));
      if (widgetFrame && (await widgetFrame.locator(readySelector).count()) > 0) break;
      const quantum = Math.min(16, timeoutMs - virtualElapsed);
      await page.clock.runFor(quantum);
      virtualElapsed += quantum;
    }
  }
  while (!settled) {
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    if (Date.now() > deadline) {
      throw new StudioError("CAPTURE_READY_TIMEOUT", `Widget capture host timed out after ${timeoutMs + 5_000}ms.`);
    }
  }
  await pending;
  if (failure) throw failure;
}

/** Dispatches an event; the frame acknowledges after the fonts it asked for settle, within a real deadline. */
export async function captureHostDispatch(
  page: Page,
  listener: string,
  event: unknown,
  deadlineMs = SETTLE_DEADLINE_MS
): Promise<FontReport | undefined> {
  const task = page.evaluate(
    ({listener: listenerName, event: eventPayload}) => {
      const captureWindow = window as unknown as {
        __SWS_CAPTURE__: {dispatch: (name: string, value: unknown) => Promise<FontReport | undefined>};
      };
      return captureWindow.__SWS_CAPTURE__.dispatch(listenerName, eventPayload);
    },
    {listener, event}
  );
  return withRealDeadline(task, deadlineMs, () => commandTimeout(page, "host:emit", deadlineMs));
}

export async function captureHostUpdateFields(
  page: Page,
  fieldData: Record<string, unknown>,
  deadlineMs = SETTLE_DEADLINE_MS
): Promise<FontReport | undefined> {
  const task = page.evaluate((values) => {
    const captureWindow = window as unknown as {
      __SWS_CAPTURE__: {updateFields: (fieldValues: Record<string, unknown>) => Promise<FontReport | undefined>};
    };
    return captureWindow.__SWS_CAPTURE__.updateFields(values);
  }, fieldData);
  return withRealDeadline(task, deadlineMs, () => commandTimeout(page, "host:update-fields", deadlineMs));
}

/**
 * Runs settle() in the widget frame: stylesheets, layout, `document.fonts.ready` and, unless
 * `light`, `fonts.load` for every family in use. Fails with FONT_SETTLE_TIMEOUT after
 * `realDeadlineMs` of real time.
 */
export async function captureHostSettle(page: Page, realDeadlineMs = SETTLE_DEADLINE_MS, light = false): Promise<FontReport> {
  const task = page.evaluate((lightSettle) => {
    const captureWindow = window as unknown as {__SWS_CAPTURE__: {settle: (value: boolean) => Promise<FontReport>}};
    return captureWindow.__SWS_CAPTURE__.settle(lightSettle);
  }, light);
  return withRealDeadline(task, realDeadlineMs, async () => settleTimeout(realDeadlineMs, await describePendingFonts(page)));
}

/** Settles, then turns Google Fonts failures seen so far into FONT_UNAVAILABLE or FONT_UNSUPPORTED; returns warnings. */
export async function settleAndCheckFonts(
  opened: Pick<OpenSceneResult, "page" | "issues" | "fonts">,
  options: {light?: boolean; deadlineMs?: number} = {}
): Promise<{report: FontReport; warnings: string[]}> {
  const report = await captureHostSettle(opened.page, options.deadlineMs ?? SETTLE_DEADLINE_MS, options.light ?? false);
  return {report, warnings: checkOpenedFonts(opened, report).warnings};
}

/**
 * checkFonts for an opened scene. URLs outside the job's font package are not failures here: the
 * discovery pass collects them and ends with FONTS_MISSING instead.
 */
export function checkOpenedFonts(opened: Pick<OpenSceneResult, "issues" | "fonts">, report: FontReport | undefined): {warnings: string[]} {
  const fonts = opened.fonts;
  return checkFonts(opened.issues.fonts, report, fonts ? {ignore: (url) => fonts.isMissing(url)} : {});
}

export async function frameEvents(page: Page): Promise<{type: string; payload?: unknown}[]> {
  return page.evaluate(() => {
    const captureWindow = window as unknown as {
      __SWS_CAPTURE__: {getEvents: () => {type: string; payload?: unknown}[]};
    };
    return captureWindow.__SWS_CAPTURE__.getEvents();
  });
}

export async function sampleFrameAnimations(page: Page, timelineMs: number): Promise<void> {
  await Promise.all(
    page.frames().map((frame) =>
      frame.evaluate((sampleTime) => {
        const frameWindow = window as typeof window & {__SWS_ANIMATION_STARTS__?: WeakMap<Animation, number>};
        const starts = frameWindow.__SWS_ANIMATION_STARTS__ ?? new WeakMap<Animation, number>();
        frameWindow.__SWS_ANIMATION_STARTS__ = starts;
        for (const animation of document.getAnimations()) {
          const startedAt = starts.get(animation) ?? sampleTime;
          starts.set(animation, startedAt);
          animation.pause();
          animation.currentTime = Math.max(0, sampleTime - startedAt);
        }
      }, timelineMs)
    )
  );
}

export interface OpenSceneOptions {
  /** Capture host page; the tutorial host frames the widget inside the editor replica. */
  host?: "capture" | "tutorial";
  camera?: ResolvedSceneState["camera"];
  background?: ResolvedSceneState["background"];
  /** Answers Google Fonts requests with `route.fulfill`; without it they stay blocked. */
  fontRoute?: FontRoute;
  /** The job's font package: answers Google Fonts requests like `fontRoute` and records misses. It wins over `fontRoute`. */
  fonts?: FontResolver;
}

export async function openScene(
  project: ResolvedProject,
  server: StudioServer,
  browser: Browser,
  scene: SceneDefinition,
  options: OpenSceneOptions = {}
): Promise<OpenSceneResult> {
  const resolved = resolveSceneState(project, scene);
  if (options.camera) resolved.camera = options.camera;
  if (options.background) resolved.background = options.background;
  // The frame document, CSS and JS are served with this scene's {{field}} values substituted.
  const docKey = await server.registerFrameDocument(resolved.runtimeState.fieldData);
  const context = await createIsolatedContext({
    browser,
    allowedOrigins: [server.origin, server.frameOrigin],
    viewport: {width: resolved.output.width, height: resolved.output.height},
    deviceScaleFactor: resolved.viewport.deviceScaleFactor ?? 1,
    ...(options.fonts ? {fontRoute: options.fonts.route} : options.fontRoute ? {fontRoute: options.fontRoute} : {})
  });
  const page = await context.newPage();
  const issues = observePage(page);
  const captureTime = new Date(resolved.runtimeState.fixedTime);
  const readyTimeoutMs = project.config.widget.ready?.timeoutMs ?? 10_000;
  await page.clock.install({time: captureTime});
  await page.goto(`${server.origin}/__sws/${options.host ?? "capture"}`, {waitUntil: "domcontentloaded"});
  // Pause before the widget iframe is created. The large control-host-only jump avoids
  // racing the naturally advancing clock without consuming any widget timers.
  await page.clock.pauseAt(new Date(captureTime.getTime() + 86_400_000));
  await page.clock.setSystemTime(captureTime);
  await captureHostLoadWithClock(page, {
    state: resolved.runtimeState,
    viewport: resolved.viewport,
    output: resolved.output,
    camera: resolved.camera,
    background: await backgroundForBrowser(resolved.background, server),
    readyTimeoutMs,
    docKey
  }, readyTimeoutMs, project.config.widget.ready?.selector, issues);
  await page.clock.setSystemTime(captureTime);
  await sampleFrameAnimations(page, 0);
  const getFrame = () => {
    const frame = page.frames().find((candidate) => candidate.url().startsWith(`${server.frameOrigin}/__sws/frame/`));
    if (!frame) throw new StudioError("FRAME_NOT_FOUND", "Widget frame did not attach to the capture host.");
    return frame;
  };
  return {context, page, issues, resolved, frame: getFrame, ...(options.fonts ? {fonts: options.fonts} : {})};
}

export async function replayFixture(page: Page, fixture: FixtureDefinition | undefined): Promise<number> {
  let currentTime = 0;
  if (!fixture) return currentTime;
  for (const timelineEvent of [...fixture.events].sort((left, right) => left.atMs - right.atMs)) {
    const delta = timelineEvent.atMs - currentTime;
    if (delta > 0) await page.clock.fastForward(delta);
    await sampleFrameAnimations(page, timelineEvent.atMs);
    await captureHostDispatch(page, timelineEvent.listener, timelineEvent.event);
    await sampleFrameAnimations(page, timelineEvent.atMs);
    await page.clock.fastForward(1);
    currentTime = timelineEvent.atMs + 1;
  }
  return currentTime;
}

async function assertStep(frame: Frame, step: Extract<ScenarioStep, {action: "assert"}>): Promise<void> {
  const locator = frame.locator(step.selector);
  const count = await locator.count();
  if (step.exists !== undefined && (count > 0) !== step.exists) {
    throw new Error(`Expected selector "${step.selector}" existence to be ${step.exists}, received count ${count}.`);
  }
  if (step.count !== undefined && count !== step.count) {
    throw new Error(`Expected selector "${step.selector}" count ${step.count}, received ${count}.`);
  }
  if (step.visible !== undefined) {
    const visible = count > 0 && (await locator.first().isVisible());
    if (visible !== step.visible) {
      throw new Error(`Expected selector "${step.selector}" visibility to be ${step.visible}.`);
    }
  }
  if (step.text !== undefined) {
    const text = (await locator.first().textContent()) ?? "";
    if (!text.includes(step.text)) {
      throw new Error(`Expected selector "${step.selector}" to contain "${step.text}", received "${text}".`);
    }
  }
  if (step.attribute) {
    const value = await locator.first().getAttribute(step.attribute.name);
    if (step.attribute.value !== undefined && value !== step.attribute.value) {
      throw new Error(
        `Expected selector "${step.selector}" attribute ${step.attribute.name}="${step.attribute.value}", received "${value}".`
      );
    }
    if (step.attribute.value === undefined && value === null) {
      throw new Error(`Expected selector "${step.selector}" to have attribute ${step.attribute.name}.`);
    }
  }
}

function scenarioScene(project: ResolvedProject, scenario: ScenarioDefinition): SceneDefinition {
  const base = scenario.scene
    ? project.scenes.find((item) => item.id === scenario.scene)?.value
    : project.scenes[0]?.value ?? createDefaultScene(project);
  if (!base) throw new StudioError("SCENE_NOT_FOUND", `Scenario "${scenario.id}" does not resolve to a scene.`);
  return {
    ...base,
    ...(scenario.theme ? {theme: scenario.theme} : {}),
    ...(scenario.fixture ? {fixture: scenario.fixture} : {})
  };
}

/**
 * Runs one scenario and reports failures in its result. The one error it does not swallow is
 * FONTS_MISSING: once any Google Fonts URL was outside the job's package, results are discarded
 * and the workflow refills the package for another pass.
 */
async function runOneScenario(
  project: ResolvedProject,
  server: StudioServer,
  browser: Browser,
  scenario: ScenarioDefinition,
  fonts?: FontResolver
): Promise<ScenarioResult> {
  const startedAt = Date.now();
  const errors: string[] = [];
  const fontWarnings = new Set<string>();
  let opened: OpenSceneResult | undefined;
  try {
    opened = await openScene(project, server, browser, scenarioScene(project, scenario), fonts ? {fonts} : {});
    const scene = opened;
    const settleFonts = async () => {
      for (const warning of (await settleAndCheckFonts(scene)).warnings) fontWarnings.add(warning);
    };
    await settleFonts();
    await replayFixture(opened.page, opened.resolved.fixture);
    for (const step of scenario.steps) {
      switch (step.action) {
        case "dispatch":
          await captureHostDispatch(opened.page, step.listener, step.event);
          await opened.page.clock.fastForward(1);
          break;
        case "updateFields":
          await captureHostUpdateFields(opened.page, step.fieldData);
          await opened.page.clock.fastForward(1);
          break;
        case "wait":
          await opened.page.clock.fastForward(step.ms);
          break;
        case "assert":
          await settleFonts();
          await assertStep(opened.frame(), step);
          break;
      }
    }
    await settleFonts();
    const runtimeErrors = (await frameEvents(opened.page))
      .filter((event) => event.type === "frame:error" || event.type === "frame:unhandled-rejection")
      .map((event) => JSON.stringify(event.payload));
    errors.push(...runtimeErrors, ...opened.issues.errors);
  } catch (error) {
    const code = error instanceof StudioError && error.code.startsWith("FONT_") ? `${error.code}: ` : "";
    errors.push(`${code}${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await opened?.context.close();
  }
  if (fonts?.hasMissing()) throw new FontsMissingError(fonts.missing());
  return {
    id: scenario.id,
    name: scenario.name,
    status: errors.length === 0 ? "passed" : "failed",
    durationMs: Date.now() - startedAt,
    errors,
    warnings: [...(opened?.issues.warnings ?? []), ...fontWarnings]
  };
}

export async function runScenarios(
  project: ResolvedProject,
  options: {scenarioIds?: string[]; browserPath?: string; headed?: boolean; fonts?: FontResolver} = {}
): Promise<{results: ScenarioResult[]; browserPath: string}> {
  assertPublicSafeProject(project);
  const selected = options.scenarioIds?.length
    ? options.scenarioIds.map((id) => {
        const scenario = project.scenarios.find((item) => item.id === id)?.value;
        if (!scenario) throw new StudioError("SCENARIO_NOT_FOUND", `Scenario not found: ${id}`);
        return scenario;
      })
    : project.scenarios.map((item) => item.value);
  if (selected.length === 0) throw new StudioError("NO_SCENARIOS", "No scenarios are configured for this widget.");

  const server = await startStudioServer(project, {port: 0, watch: false});
  let browser: Browser | undefined;
  try {
    const launched = await launchStudioBrowser({
      ...(options.browserPath ? {browserPath: options.browserPath} : {}),
      ...(options.headed !== undefined ? {headed: options.headed} : {})
    });
    browser = launched.browser;
    const results: ScenarioResult[] = [];
    for (const scenario of selected) {
      try {
        results.push(await runOneScenario(project, server, browser, scenario, options.fonts));
      } catch (error) {
        // Keep running the other scenarios, so one discovery pass collects every missing URL.
        if (!isFontsMissing(error)) throw error;
      }
    }
    if (options.fonts?.hasMissing()) throw new FontsMissingError(options.fonts.missing());
    return {results, browserPath: launched.detection.executablePath ?? "unknown"};
  } finally {
    await browser?.close();
    await server.close();
  }
}

export async function runBrowserSmoke(
  project: ResolvedProject,
  options: {browserPath?: string; headed?: boolean; fonts?: FontResolver} = {}
): Promise<ScenarioResult> {
  const smoke: ScenarioDefinition = {
    schemaVersion: 1,
    id: "browser-smoke",
    name: "Browser smoke",
    ...(project.scenes[0]?.id ? {scene: project.scenes[0].id} : {}),
    steps: []
  };
  const server = await startStudioServer(project, {port: 0, watch: false});
  let browser: Browser | undefined;
  try {
    ({browser} = await launchStudioBrowser({
      ...(options.browserPath ? {browserPath: options.browserPath} : {}),
      ...(options.headed !== undefined ? {headed: options.headed} : {})
    }));
    return await runOneScenario(project, server, browser, smoke, options.fonts);
  } finally {
    await browser?.close();
    await server.close();
  }
}

export const productionFileKeys: (keyof ResolvedWidgetFiles)[] = ["html", "css", "js", "fields"];
