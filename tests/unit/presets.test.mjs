import assert from "node:assert/strict";
import {fileURLToPath} from "node:url";
import test from "node:test";

import {expandRecipe} from "../../dist/capture/matrix.js";
import {planRecipe} from "../../dist/capture/renderer.js";
import {loadProject} from "../../dist/config/load.js";
import {loadMarketplacePreset, marketplaceRecipeIssues} from "../../dist/config/presets.js";
import {recipeSchema} from "../../dist/config/schemas.js";

const exampleRoot = fileURLToPath(new URL("../../examples/basic-chat/", import.meta.url));

test("the Etsy recipes satisfy the dated operational profile and unsafe variants fail before rendering", async () => {
  const project = await loadProject({inputDirectory: exampleRoot});
  const preset = await loadMarketplacePreset("etsy-listing-2026-08");
  for (const id of ["etsy-listing-images", "etsy-listing-video"]) {
    const recipe = project.recipes.find((item) => item.id === id)?.value;
    assert.ok(recipe);
    assert.deepEqual(marketplaceRecipeIssues(recipe, preset, expandRecipe(project, recipe)), []);
  }

  const videoRecipe = structuredClone(project.recipes.find((item) => item.id === "etsy-listing-video").value);
  videoRecipe.outputs.video.durationMs = 3000;
  assert.match(marketplaceRecipeIssues(videoRecipe, preset, expandRecipe(project, videoRecipe)).join("; "), /below 5000ms/);

  const implicitSilentVideo = structuredClone(project.recipes.find((item) => item.id === "etsy-listing-video").value);
  delete implicitSilentVideo.outputs.video.audio;
  assert.deepEqual(marketplaceRecipeIssues(implicitSilentVideo, preset, expandRecipe(project, implicitSilentVideo)), []);

  const imageRecipe = project.recipes.find((item) => item.id === "etsy-listing-images").value;
  const transparent = expandRecipe(project, imageRecipe).slice(0, 1);
  transparent[0].background = {...transparent[0].background, color: "rgb(0 0 0 / 0)"};
  assert.match(marketplaceRecipeIssues(imageRecipe, preset, transparent).join("; "), /opaque background/);
  transparent[0].background = {...transparent[0].background, color: "hsl(0 0% 0% / 100%)"};
  assert.doesNotMatch(marketplaceRecipeIssues(imageRecipe, preset, transparent).join("; "), /opaque background/);
});

test("recipe schema rejects impossible derived outputs and container-codec mismatches", () => {
  const base = {schemaVersion: 1, id: "invalid", name: "Invalid", scenes: ["hero"]};
  assert.equal(recipeSchema.safeParse({
    ...base,
    outputs: {screenshots: false, thumbnails: {width: 100, height: 100}}
  }).success, false);
  assert.equal(recipeSchema.safeParse({
    ...base,
    outputs: {video: {enabled: true, durationMs: 1000, fps: 30, format: "mp4", codec: "vp9"}}
  }).success, false);
});

test("video planning rejects odd 4:2:0 dimensions before writing frames", async () => {
  const project = await loadProject({inputDirectory: exampleRoot});
  const hero = project.scenes.find((item) => item.id === "hero");
  hero.value.output = {width: 431, height: 641, format: "png"};
  const recipe = {
    schemaVersion: 1,
    id: "odd-video",
    name: "Odd video",
    scenes: ["hero"],
    outputs: {
      screenshots: false,
      video: {enabled: true, durationMs: 1000, fps: 30, format: "mp4", codec: "h264", pixelFormat: "yuv420p", audio: "none"}
    }
  };
  await assert.rejects(
    planRecipe(project, recipe),
    (error) => error?.code === "VIDEO_DIMENSIONS_INVALID" && /431x641/.test(error.message)
  );
});

test("planning rejects an oversized frame workload before expanding variants or target paths", async () => {
  const project = await loadProject({inputDirectory: exampleRoot});
  const cameras = new Proxy(
    Array.from({length: 48}, (_, index) => ({id: `camera-${index}`, scale: 1, x: 0, y: 0})),
    {
      get(target, property, receiver) {
        if (property === Symbol.iterator) throw new Error("matrix expansion started");
        return Reflect.get(target, property, receiver);
      }
    }
  );
  const recipe = {
    schemaVersion: 1,
    id: "oversized-video",
    name: "Oversized video",
    scenes: ["hero"],
    matrix: {cameras},
    outputs: {
      screenshots: false,
      video: {enabled: true, durationMs: 600_000, fps: 120, format: "mp4", codec: "h264", pixelFormat: "yuv420p", audio: "none"}
    }
  };

  await assert.rejects(
    planRecipe(project, recipe),
    (error) => error?.code === "RENDER_LIMIT_EXCEEDED"
      && /3456000 video frames/.test(error.message)
      && /above the limit of 10000/.test(error.message)
  );
});
