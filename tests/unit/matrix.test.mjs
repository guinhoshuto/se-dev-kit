import assert from "node:assert/strict";
import test from "node:test";

import {expandRecipe} from "../../dist/capture/matrix.js";

function catalogTheme(id) {
  return {
    id,
    filePath: `/synthetic/themes/${id}.json`,
    value: {schemaVersion: 1, id, name: id, fieldData: {theme: id}}
  };
}

function projectFixture() {
  const scene = {
    schemaVersion: 1,
    id: "hero",
    name: "Hero",
    theme: "theme-one",
    fieldData: {scene: "hero"},
    background: {id: "scene-background", color: "transparent"},
    viewport: {width: 430, height: 640, deviceScaleFactor: 1},
    output: {width: 800, height: 800, format: "png"},
    camera: {id: "scene-camera", scale: 1, x: 0, y: 0}
  };
  return {
    config: {schemaVersion: 1, widget: {viewport: {width: 430, height: 640}}, channel: {username: "streamer"}},
    fieldDefaults: {title: "Default", nested: {base: true}},
    themes: [catalogTheme("theme-one"), catalogTheme("theme-two")],
    fixtures: [],
    scenes: [{id: scene.id, filePath: "/synthetic/scenes/hero.json", value: scene}],
    scenarios: [],
    recipes: []
  };
}

function recipeFixture() {
  return {
    schemaVersion: 1,
    id: "matrix-recipe",
    name: "Matrix recipe",
    scenes: ["hero"],
    matrix: {
      themes: ["theme-two", "theme-one"],
      backgrounds: [
        {id: "background-one", color: "#111111"},
        {id: "background-two", color: "#222222"}
      ],
      viewports: [
        {id: "viewport-one", width: 430, height: 640},
        {id: "viewport-two", width: 640, height: 430}
      ],
      cameras: [
        {id: "camera-one", scale: 1, x: 0, y: 0},
        {id: "camera-two", scale: 1.25, x: 10, y: -10}
      ]
    },
    limit: 16
  };
}

test("matrix expansion is deterministic, ordered, complete, and does not mutate source definitions", () => {
  const project = projectFixture();
  const recipe = recipeFixture();
  const sourceSnapshot = structuredClone({project, recipe});

  const first = expandRecipe(project, recipe);
  const second = expandRecipe(project, recipe);

  assert.deepEqual(second, first);
  assert.equal(first.length, 16);
  assert.equal(first[0]?.id, "hero-theme-two-background-one-viewport-one-camera-one");
  assert.equal(first[1]?.id, "hero-theme-two-background-one-viewport-one-camera-two");
  assert.equal(first.at(-1)?.id, "hero-theme-one-background-two-viewport-two-camera-two");
  assert.equal(new Set(first.map((variant) => variant.id)).size, first.length);
  assert.deepEqual({project, recipe}, sourceSnapshot);
});

test("matrix expansion enforces its limit unless the caller explicitly opts in", () => {
  const project = projectFixture();
  const recipe = recipeFixture();

  assert.throws(
    () => expandRecipe(project, recipe, {limit: 15}),
    (error) => error?.code === "MATRIX_LIMIT_EXCEEDED" && /16 variants/.test(error.message)
  );
  assert.equal(expandRecipe(project, recipe, {limit: 15, allowLargeMatrix: true}).length, 16);
});

test("matrix cardinality is rejected before any expansion iterator is consumed", () => {
  const project = projectFixture();
  const recipe = recipeFixture();
  recipe.matrix.cameras = new Proxy(recipe.matrix.cameras, {
    get(target, property, receiver) {
      if (property === Symbol.iterator) throw new Error("matrix expansion started");
      return Reflect.get(target, property, receiver);
    }
  });

  assert.throws(
    () => expandRecipe(project, recipe, {limit: 15}),
    (error) => error?.code === "MATRIX_LIMIT_EXCEEDED" && /16 variants/.test(error.message)
  );
});

test("matrix cardinality cannot exceed the safe-integer boundary even with an explicit opt-in", () => {
  const project = projectFixture();
  const recipe = recipeFixture();
  recipe.matrix.backgrounds = new Array(300_000);
  recipe.matrix.viewports = new Array(300_000);
  recipe.matrix.cameras = new Array(300_000);

  assert.throws(
    () => expandRecipe(project, recipe, {allowLargeMatrix: true}),
    (error) => error?.code === "MATRIX_LIMIT_EXCEEDED" && /cannot be represented safely/.test(error.message)
  );
});

test("matrix expansion rejects a crop outside the effective output before capture", () => {
  const project = projectFixture();
  delete project.scenes[0].value.output;
  project.scenes[0].value.crop = {x: 400, y: 0, width: 100, height: 100};

  assert.throws(
    () => expandRecipe(project, {...recipeFixture(), matrix: undefined, limit: 1}),
    (error) => error?.code === "SCENE_CROP_BOUNDS" && /430x640/.test(error.message)
  );
});
