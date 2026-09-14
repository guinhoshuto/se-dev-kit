import type {
  CameraDefinition,
  CaptureVariant,
  RecipeDefinition,
  ResolvedProject,
  SceneDefinition,
  StageBackground,
  WidgetViewport
} from "../types.js";
import {StudioError} from "../shared/errors.js";
import {assertSafeId} from "../shared/ids.js";
import {resolveSceneState} from "../scenarios/state.js";

interface NamedViewport extends WidgetViewport {
  id: string;
  label?: string;
}

export const DEFAULT_MATRIX_LIMIT = 48;

function dimensionCardinality(values: unknown[] | undefined): bigint {
  return BigInt(values && values.length > 0 ? values.length : 1);
}

export function recipeMatrixCardinality(project: ResolvedProject, recipe: RecipeDefinition): bigint {
  const configuredThemes = recipe.matrix?.themes;
  const themeCount = configuredThemes?.includes("*")
    ? BigInt(Math.max(1, project.themes.length))
    : dimensionCardinality(configuredThemes);
  return BigInt(recipe.scenes.length)
    * themeCount
    * dimensionCardinality(recipe.matrix?.backgrounds)
    * dimensionCardinality(recipe.matrix?.viewports)
    * dimensionCardinality(recipe.matrix?.cameras);
}

export function assertRecipeMatrixCardinality(
  project: ResolvedProject,
  recipe: RecipeDefinition,
  options: {limit?: number; allowLargeMatrix?: boolean}
): bigint {
  const limit = options.limit ?? recipe.limit ?? DEFAULT_MATRIX_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new StudioError("MATRIX_LIMIT_INVALID", `Matrix limit must be a positive safe integer; received ${String(limit)}.`);
  }
  const cardinality = recipeMatrixCardinality(project, recipe);
  const maximumSafeCardinality = BigInt(Number.MAX_SAFE_INTEGER);
  if (cardinality > maximumSafeCardinality) {
    throw new StudioError(
      "MATRIX_LIMIT_EXCEEDED",
      `Recipe "${recipe.id}" expands to ${cardinality.toString()} variants, which cannot be represented safely.`,
      "Reduce the matrix dimensions. --allow-large-matrix cannot bypass the safe-integer boundary."
    );
  }
  if (cardinality > BigInt(limit) && !options.allowLargeMatrix) {
    throw new StudioError(
      "MATRIX_LIMIT_EXCEEDED",
      `Recipe "${recipe.id}" expands to ${cardinality.toString()} variants, above the limit of ${limit}.`,
      "Reduce the matrix or pass --allow-large-matrix after reviewing --dry-run output."
    );
  }
  return cardinality;
}

function listOrDefault<T>(values: T[] | undefined, fallback: T): T[] {
  return values && values.length > 0 ? values : [fallback];
}

export function expandRecipe(
  project: ResolvedProject,
  recipe: RecipeDefinition,
  options: {limit?: number; allowLargeMatrix?: boolean} = {}
): CaptureVariant[] {
  assertRecipeMatrixCardinality(project, recipe, options);
  const variants: CaptureVariant[] = [];
  const requestedThemes = recipe.matrix?.themes?.includes("*")
    ? project.themes.map((item) => item.id)
    : recipe.matrix?.themes;

  for (const sceneId of recipe.scenes) {
    const sourceScene = project.scenes.find((item) => item.id === sceneId)?.value;
    if (!sourceScene) throw new StudioError("SCENE_NOT_FOUND", `Recipe "${recipe.id}" references missing scene "${sceneId}".`);
    const base = resolveSceneState(project, sourceScene);
    const themeIds = requestedThemes && requestedThemes.length > 0 ? requestedThemes : [sourceScene.theme];
    const backgrounds = listOrDefault<StageBackground>(recipe.matrix?.backgrounds, base.background);
    const viewports = listOrDefault<NamedViewport>(
      recipe.matrix?.viewports,
      {...base.viewport, id: "widget-default"}
    );
    const cameras = listOrDefault<CameraDefinition>(recipe.matrix?.cameras, base.camera);

    for (const themeId of themeIds) {
      for (const background of backgrounds) {
        for (const viewport of viewports) {
          for (const camera of cameras) {
            assertSafeId(background.id, "background id");
            assertSafeId(viewport.id, "viewport id");
            assertSafeId(camera.id, "camera id");
            const scene: SceneDefinition = {
              ...sourceScene,
              ...(themeId ? {theme: themeId} : {}),
              background,
              viewport,
              camera
            };
            const resolved = resolveSceneState(project, scene);
            const crop = scene.crop;
            if (crop && (crop.x + crop.width > resolved.output.width || crop.y + crop.height > resolved.output.height)) {
              throw new StudioError(
                "SCENE_CROP_BOUNDS",
                `Variant "${scene.id}" crop exceeds its resolved ${resolved.output.width}x${resolved.output.height} output.`
              );
            }
            const id = [
              scene.id,
              resolved.theme?.id ?? "default",
              background.id,
              viewport.id,
              camera.id
            ].join("-");
            assertSafeId(id, "variant id");
            variants.push({
              id,
              scene,
              background,
              viewport,
              output: resolved.output,
              camera,
              ...(resolved.theme ? {theme: resolved.theme} : {}),
              ...(resolved.fixture ? {fixture: resolved.fixture} : {})
            });
          }
        }
      }
    }
  }

  const ids = new Set<string>();
  for (const variant of variants) {
    if (ids.has(variant.id)) throw new StudioError("VARIANT_COLLISION", `Duplicate capture variant id: ${variant.id}`);
    ids.add(variant.id);
  }
  return variants;
}
