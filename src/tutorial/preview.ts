import type {CaptureVariant, JsonObject, JsonValue, ResolvedProject, VideoDefinition} from "../types.js";
import {StudioError} from "../shared/errors.js";
import {expandRecipe} from "../capture/matrix.js";
import {resolveSceneState} from "../scenarios/state.js";
import {compileVariantTutorial, EMULATE_MENU, tutorialCamera, tutorialSamples} from "./variant.js";
import type {TutorialTimeline, TutorialWidgetAction} from "./timeline.js";

/**
 * What reaches the widget during a video, in time order: the variant's fixture events, then the
 * tutorial's dispatches and field changes. A render and the dev preview replay the same list.
 */
export function videoWidgetEvents(variant: CaptureVariant, tutorial: TutorialTimeline | undefined): TutorialWidgetAction[] {
  return [
    ...(variant.fixture?.events ?? []).map((event) => ({
      atMs: event.atMs,
      kind: "dispatch" as const,
      listener: event.listener,
      event: event.event
    })),
    ...(tutorial?.widget ?? [])
  ].sort((left, right) => left.atMs - right.atMs);
}

/** The widget's recipes with a tutorial video, for the preview's recipe and variant pickers. */
export interface TutorialPreviewIndex {
  recipes: {id: string; durationMs: number; fps: number; variants: string[]}[];
}

/** One field change of the preview: the patch, and for `reload` the frame document of all values so far. */
export type TutorialPreviewEvent =
  | {atMs: number; kind: "dispatch"; listener: string; event: JsonValue}
  | {atMs: number; kind: "fields"; patch: JsonObject; fieldData: JsonObject; docKey?: string};

/** Everything `/__sws/tutorial-preview` needs to load a variant's tutorial in the browser, without Playwright. */
export interface TutorialPreviewPayload {
  recipe: string;
  variant: string;
  variants: string[];
  durationMs: number;
  fps: number;
  fieldUpdate: "reload" | "event";
  /** The scene's crop, which the render's frames are clipped to; null shows the whole stage. */
  crop: {x: number; y: number; width: number; height: number} | null;
  /** Arguments of `__SWS_CAPTURE__.load` and, for a reset, of `reload` with the scene's own values. */
  load: JsonObject;
  /** Arguments of `__SWS_TUTORIAL__.setup`, as the render passes them. */
  setup: JsonObject;
  events: TutorialPreviewEvent[];
}

function tutorialRecipes(project: ResolvedProject): {id: string; video: VideoDefinition; variants: CaptureVariant[]}[] {
  return project.recipes.flatMap((item) => {
    const video = item.value.outputs?.video;
    if (!video?.enabled || video.mode !== "tutorial") return [];
    return [{id: item.id, video, variants: expandRecipe(project, item.value)}];
  });
}

export function tutorialPreviewIndex(project: ResolvedProject): TutorialPreviewIndex {
  return {
    recipes: tutorialRecipes(project).map((recipe) => ({
      id: recipe.id,
      durationMs: recipe.video.durationMs,
      fps: recipe.video.fps,
      variants: recipe.variants.map((variant) => variant.id)
    }))
  };
}

/**
 * Compiles one variant's tutorial as a render does and registers its frame documents: the scene's
 * own values and, when fields reload the widget, one per field change with every value so far.
 */
export async function tutorialPreview(
  project: ResolvedProject,
  registerFrameDocument: (fieldData: JsonObject) => Promise<string>,
  recipeId: string,
  variantId?: string
): Promise<TutorialPreviewPayload> {
  const recipe = tutorialRecipes(project).find((item) => item.id === recipeId);
  if (!recipe) {
    throw new StudioError("TUTORIAL_PREVIEW_NOT_FOUND", `No recipe "${recipeId}" with a tutorial video.`, "Open /__sws/tutorial-preview without parameters to list the tutorial recipes.");
  }
  const variant = variantId === undefined ? recipe.variants[0] : recipe.variants.find((item) => item.id === variantId);
  if (!variant) {
    throw new StudioError("TUTORIAL_PREVIEW_NOT_FOUND", `Recipe "${recipeId}" has no variant "${variantId ?? ""}".`);
  }
  const tutorial = compileVariantTutorial(project, variant, recipe.video, await tutorialSamples(project, recipe.video));
  const resolved = resolveSceneState(project, variant.scene);
  const fieldUpdate = project.config.widget.fieldUpdate ?? "reload";
  const readyTimeoutMs = project.config.widget.ready?.timeoutMs ?? 10_000;
  let fieldData: JsonObject = structuredClone(resolved.runtimeState.fieldData);
  const docKey = await registerFrameDocument(fieldData);
  const events: TutorialPreviewEvent[] = [];
  for (const action of videoWidgetEvents(variant, tutorial)) {
    if (action.kind === "dispatch") {
      events.push(action);
      continue;
    }
    fieldData = {...fieldData, ...structuredClone(action.fieldData)};
    events.push({
      atMs: action.atMs,
      kind: "fields",
      patch: action.fieldData,
      fieldData,
      ...(fieldUpdate === "reload" ? {docKey: await registerFrameDocument(fieldData)} : {})
    });
  }
  const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as JsonObject;
  return {
    recipe: recipe.id,
    variant: variant.id,
    variants: recipe.variants.map((item) => item.id),
    durationMs: recipe.video.durationMs,
    fps: recipe.video.fps,
    fieldUpdate,
    crop: variant.scene.crop ?? null,
    load: json({
      state: resolved.runtimeState,
      viewport: resolved.viewport,
      output: resolved.output,
      camera: tutorialCamera(tutorial),
      background: {color: "transparent"},
      readyTimeoutMs,
      docKey
    }),
    setup: json({
      timeline: tutorial,
      menu: EMULATE_MENU,
      viewport: {width: resolved.viewport.width, height: resolved.viewport.height},
      output: {width: resolved.output.width, height: resolved.output.height},
      crop: variant.scene.crop ?? null
    }),
    events
  };
}
