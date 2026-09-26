import assert from "node:assert/strict";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";

import {detectBrowser} from "../../dist/capture/browser.js";
import {renderRecipe} from "../../dist/capture/renderer.js";
import {loadProject} from "../../dist/config/load.js";

const exampleRoot = fileURLToPath(new URL("../../examples/basic-chat/", import.meta.url));

test("tutorial mode records the widget inside the editor replica with scripted UI state", {timeout: 180_000}, async (t) => {
  const detection = await detectBrowser();
  if (!detection.executablePath) {
    t.skip("No compatible local Chromium executable is installed; the Studio must not download one implicitly.");
    return;
  }
  const outputRoot = await mkdtemp(join(tmpdir(), "sws-tutorial-integration-"));
  t.after(() => rm(outputRoot, {recursive: true, force: true}));
  const project = await loadProject({inputDirectory: exampleRoot});
  const recipe = structuredClone(project.recipes.find((item) => item.id === "tutorial-setup").value);
  recipe.outputs.video.fps = 2;

  const result = await renderRecipe(project, recipe, {
    outputRoot,
    browserPath: detection.executablePath,
    allowIntermediate: true
  });
  assert.ok(result.status === "final" || result.status === "intermediate" || result.status === "unvalidated");
  const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
  const frames = JSON.parse(await readFile(join(outputRoot, manifest.artifacts[0].frames, "frames.json"), "utf8"));
  assert.equal(frames.frames.length, Math.round((recipe.outputs.video.durationMs * 2) / 1000));
  assert.equal(frames.width, 1920);
  assert.equal(frames.height, 1080);
  const hashes = new Set(frames.frames.map((frame) => frame.sha256));
  assert.ok(hashes.size > frames.frames.length / 2, "the scripted editor changes across the recording");
});
