import type {
  CameraDefinition,
  CatalogItem,
  FixtureDefinition,
  JsonObject,
  OutputDefinition,
  ResolvedProject,
  RuntimeState,
  SceneDefinition,
  StageBackground,
  ThemeDefinition,
  WidgetViewport
} from "../types.js";
import {StudioError} from "../shared/errors.js";
import {mergeJsonObjects} from "../shared/json.js";
import {defaultViewport} from "../config/load.js";

export const DEFAULT_FIXED_TIME = "2025-01-15T12:00:00.000Z";
export const DEFAULT_SEED = 1_337;

export function findCatalogItem<T>(items: CatalogItem<T>[], id: string | undefined, kind: string): T | undefined {
  if (!id) return undefined;
  const found = items.find((item) => item.id === id);
  if (!found) throw new StudioError("CATALOG_ITEM_NOT_FOUND", `${kind} not found: ${id}`);
  return found.value;
}

export interface ResolvedSceneState {
  scene: SceneDefinition;
  theme?: ThemeDefinition;
  fixture?: FixtureDefinition;
  runtimeState: Omit<RuntimeState, "sessionId">;
  background: StageBackground;
  viewport: WidgetViewport;
  output: OutputDefinition;
  camera: CameraDefinition;
}

export function resolveSceneState(
  project: ResolvedProject,
  scene: SceneDefinition,
  overrides: {themeId?: string; fieldData?: JsonObject} = {}
): ResolvedSceneState {
  const theme = findCatalogItem(project.themes, overrides.themeId ?? scene.theme, "Theme");
  const fixture = findCatalogItem(project.fixtures, scene.fixture, "Fixture");
  const viewport = scene.viewport ?? defaultViewport(project);
  const output = scene.output ?? {width: viewport.width, height: viewport.height, format: "png"};
  const background = scene.background ?? {id: "transparent", color: "transparent"};
  const camera = scene.camera ?? {id: "default", scale: 1, x: 0, y: 0, origin: "center center"};
  const runtimeState = {
    fieldData: mergeJsonObjects(project.fieldDefaults, theme?.fieldData, fixture?.fieldData, scene.fieldData, overrides.fieldData),
    channel: mergeJsonObjects({username: "streamer"}, project.config.channel, fixture?.channel),
    recents: mergeJsonObjects(fixture?.recents),
    seed: DEFAULT_SEED,
    fixedTime: DEFAULT_FIXED_TIME
  };
  const resolved: ResolvedSceneState = {scene, runtimeState, background, viewport, output, camera};
  if (theme) resolved.theme = theme;
  if (fixture) resolved.fixture = fixture;
  return resolved;
}

export function createDefaultScene(project: ResolvedProject): SceneDefinition {
  return {
    schemaVersion: 1,
    id: "default",
    name: "Default",
    viewport: defaultViewport(project),
    output: {
      width: defaultViewport(project).width,
      height: defaultViewport(project).height,
      format: "png"
    },
    background: {id: "transparent", color: "transparent"},
    camera: {id: "default", scale: 1, x: 0, y: 0, origin: "center center"},
    captureAtMs: 0
  };
}
