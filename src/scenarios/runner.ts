import type {Browser, BrowserContext, Frame, Page} from "playwright-core";
import type {
  FixtureDefinition,
  ResolvedProject,
  ResolvedWidgetFiles,
  ScenarioDefinition,
  ScenarioStep,
  SceneDefinition
} from "../types.js";
import {StudioError} from "../shared/errors.js";
import {assetUrlPath} from "../server/assets.js";
import {startStudioServer, type StudioServer} from "../server/server.js";
import {createIsolatedContext, launchStudioBrowser, observePage, type BrowserIssueLog} from "../capture/browser.js";
import {createDefaultScene, resolveSceneState, type ResolvedSceneState} from "./state.js";
import {assertPublicSafeProject} from "../validation/privacy.js";

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
}

function backgroundForBrowser(background: ResolvedSceneState["background"], frameOrigin: string) {
  const image = background.image;
  if (!image) return background;
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

async function captureHostLoadWithClock(
  page: Page,
  payload: unknown,
  timeoutMs: number,
  readySelector: string | undefined
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
    if (Date.now() > deadline) {
      throw new StudioError("CAPTURE_READY_TIMEOUT", `Widget capture host timed out after ${timeoutMs + 5_000}ms.`);
    }
    const events = await frameEvents(page);
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

export async function captureHostDispatch(page: Page, listener: string, event: unknown): Promise<void> {
  await page.evaluate(
    ({listener: listenerName, event: eventPayload}) => {
      const captureWindow = window as unknown as {
        __SWS_CAPTURE__: {dispatch: (name: string, value: unknown) => Promise<void>};
      };
      return captureWindow.__SWS_CAPTURE__.dispatch(listenerName, eventPayload);
    },
    {listener, event}
  );
}

async function captureHostUpdateFields(page: Page, fieldData: Record<string, unknown>): Promise<void> {
  await page.evaluate((values) => {
    const captureWindow = window as unknown as {
      __SWS_CAPTURE__: {updateFields: (fieldValues: Record<string, unknown>) => Promise<void>};
    };
    return captureWindow.__SWS_CAPTURE__.updateFields(values);
  }, fieldData);
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

export async function openScene(
  project: ResolvedProject,
  server: StudioServer,
  browser: Browser,
  scene: SceneDefinition
): Promise<OpenSceneResult> {
  const resolved = resolveSceneState(project, scene);
  const context = await createIsolatedContext({
    browser,
    allowedOrigins: [server.origin, server.frameOrigin],
    viewport: {width: resolved.output.width, height: resolved.output.height},
    deviceScaleFactor: resolved.viewport.deviceScaleFactor ?? 1
  });
  const page = await context.newPage();
  const issues = observePage(page);
  const captureTime = new Date(resolved.runtimeState.fixedTime);
  const readyTimeoutMs = project.config.widget.ready?.timeoutMs ?? 10_000;
  await page.clock.install({time: captureTime});
  await page.goto(`${server.origin}/__sws/capture`, {waitUntil: "domcontentloaded"});
  // Pause before the widget iframe is created. The large control-host-only jump avoids
  // racing the naturally advancing clock without consuming any widget timers.
  await page.clock.pauseAt(new Date(captureTime.getTime() + 86_400_000));
  await page.clock.setSystemTime(captureTime);
  await captureHostLoadWithClock(page, {
    state: resolved.runtimeState,
    viewport: resolved.viewport,
    output: resolved.output,
    camera: resolved.camera,
    background: backgroundForBrowser(resolved.background, server.frameOrigin),
    readyTimeoutMs
  }, readyTimeoutMs, project.config.widget.ready?.selector);
  await page.clock.setSystemTime(captureTime);
  await sampleFrameAnimations(page, 0);
  const getFrame = () => {
    const frame = page.frames().find((candidate) => candidate.url().startsWith(`${server.frameOrigin}/__sws/frame/`));
    if (!frame) throw new StudioError("FRAME_NOT_FOUND", "Widget frame did not attach to the capture host.");
    return frame;
  };
  return {context, page, issues, resolved, frame: getFrame};
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

async function runOneScenario(
  project: ResolvedProject,
  server: StudioServer,
  browser: Browser,
  scenario: ScenarioDefinition
): Promise<ScenarioResult> {
  const startedAt = Date.now();
  const errors: string[] = [];
  let opened: OpenSceneResult | undefined;
  try {
    opened = await openScene(project, server, browser, scenarioScene(project, scenario));
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
          await assertStep(opened.frame(), step);
          break;
      }
    }
    const runtimeErrors = (await frameEvents(opened.page))
      .filter((event) => event.type === "frame:error" || event.type === "frame:unhandled-rejection")
      .map((event) => JSON.stringify(event.payload));
    errors.push(...runtimeErrors, ...opened.issues.errors);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    await opened?.context.close();
  }
  return {
    id: scenario.id,
    name: scenario.name,
    status: errors.length === 0 ? "passed" : "failed",
    durationMs: Date.now() - startedAt,
    errors,
    warnings: opened?.issues.warnings ?? []
  };
}

export async function runScenarios(
  project: ResolvedProject,
  options: {scenarioIds?: string[]; browserPath?: string; headed?: boolean} = {}
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
    for (const scenario of selected) results.push(await runOneScenario(project, server, browser, scenario));
    return {results, browserPath: launched.detection.executablePath ?? "unknown"};
  } finally {
    await browser?.close();
    await server.close();
  }
}

export async function runBrowserSmoke(
  project: ResolvedProject,
  options: {browserPath?: string; headed?: boolean} = {}
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
    ({browser} = await launchStudioBrowser(options));
    return await runOneScenario(project, server, browser, smoke);
  } finally {
    await browser?.close();
    await server.close();
  }
}

export const productionFileKeys: (keyof ResolvedWidgetFiles)[] = ["html", "css", "js", "fields"];
