import assert from "node:assert/strict";
import {mkdtemp, mkdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {loadRecipes, loadScenes} from "../../dist/config/catalog.js";
import {recipeSchema, sceneSchema, themeSchema} from "../../dist/config/schemas.js";

// A catalog whose ids the capture job refuses (assertSafeId on the variant id) fails when it is read,
// with the job's rule in the message, instead of hours later in the job (se-dev-kit#6: "f-fontName").
const RULE = "Use lowercase letters, numbers, and single hyphens.";
const scene = (id, extra = {}) => ({schemaVersion: 1, id, name: "Font name", ...extra});
const issues = (result) => result.error.issues.map((issue) => issue.message).join("; ");

async function catalogFolder(t, files) {
  const root = await mkdtemp(join(tmpdir(), "sws-catalog-ids-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(join(root, "studio"), {recursive: true});
  for (const [name, value] of Object.entries(files)) await writeFile(join(root, "studio", name), JSON.stringify(value));
  return root;
}

test("a scene id in camelCase is refused with the job's rule, and its lowercase form passes", () => {
  const refused = sceneSchema.safeParse(scene("f-fontName"));
  assert.equal(refused.success, false);
  assert.equal(issues(refused), `Invalid scene id "f-fontName". ${RULE}`);
  for (const id of ["F-font", "f_font", "f--font", "f-font-", "../f"]) {
    assert.equal(sceneSchema.safeParse(scene(id)).success, false, id);
  }
  assert.equal(sceneSchema.safeParse(scene("f-font-name")).success, true);
});

test("every other part of a variant id is held to the same rule", () => {
  const background = sceneSchema.safeParse(scene("f-font-name", {background: {id: "Plants"}}));
  assert.equal(issues(background), `Invalid background id "Plants". ${RULE}`);
  const camera = sceneSchema.safeParse(scene("f-font-name", {camera: {id: "zoom_in", scale: 2, x: 0, y: 0}}));
  assert.equal(issues(camera), `Invalid camera id "zoom_in". ${RULE}`);
  const theme = themeSchema.safeParse({schemaVersion: 1, id: "Neon", name: "Neon", fieldData: {}});
  assert.equal(issues(theme), `Invalid theme id "Neon". ${RULE}`);
  const recipe = (matrix) => recipeSchema.safeParse({schemaVersion: 1, id: "fields", name: "Fields", scenes: ["f-font-name"], matrix});
  assert.equal(issues(recipe({viewports: [{id: "Wide", width: 640, height: 360}]})), `Invalid viewport id "Wide". ${RULE}`);
  assert.equal(issues(recipe({backgrounds: [{id: "Dark"}]})), `Invalid background id "Dark". ${RULE}`);
  assert.equal(issues(recipe({cameras: [{id: "Close", scale: 2, x: 0, y: 0}]})), `Invalid camera id "Close". ${RULE}`);
  const valid = recipe({viewports: [{id: "wide", width: 640, height: 360}], backgrounds: [{id: "dark"}], cameras: [{id: "close", scale: 2, x: 0, y: 0}]});
  assert.equal(valid.success, true);
});

test("validate reads the scene files and refuses the camelCase id before any job", async (t) => {
  const root = await catalogFolder(t, {"f-font-name.json": scene("f-fontName")});
  await assert.rejects(loadScenes(root, "studio/*.json"), (error) => {
    assert.equal(error.code, "INVALID_CATALOG_ITEM");
    assert.match(error.message, /Invalid scene id "f-fontName"\. Use lowercase letters, numbers, and single hyphens\./);
    return true;
  });
  const valid = await catalogFolder(t, {"f-font-name.json": scene("f-font-name", {background: {id: "plants"}})});
  assert.deepEqual((await loadScenes(valid, "studio/*.json")).map((item) => item.id), ["f-font-name"]);
});

test("validate refuses a recipe matrix id the job would refuse", async (t) => {
  const root = await catalogFolder(t, {
    "fields.json": {schemaVersion: 1, id: "fields", name: "Fields", scenes: ["f-font-name"], matrix: {cameras: [{id: "Close", scale: 2, x: 0, y: 0}]}}
  });
  await assert.rejects(loadRecipes(root, "studio/*.json"), /Invalid camera id "Close"\. Use lowercase letters, numbers, and single hyphens\./);
});
