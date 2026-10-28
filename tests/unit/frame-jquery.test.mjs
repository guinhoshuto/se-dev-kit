// StreamElements loads jQuery 3.3.1 in every custom widget frame and passes onWidgetLoad's `recents`
// as an array (src/runtime/vendor/README.md). The frame runtime ships the same jQuery file, and a
// fixture's `recents` is an array of events; `{}` from older fixtures and stored revisions reads as `[]`.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";

import {loadFixtures} from "../../dist/config/catalog.js";
import {loadProject} from "../../dist/config/load.js";
import {fixtureSchema} from "../../dist/config/schemas.js";
import {resolveSceneState} from "../../dist/scenarios/state.js";

const JQUERY_SHA256 = "160a426ff2894252cd7cebbdd6d6b7da8fcd319c65b70468f10b6690c45d02ef";
const exampleRoot = fileURLToPath(new URL("../../examples/basic-chat/", import.meta.url));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fixture = (recents) => ({schemaVersion: 1, id: "night", name: "Night", ...(recents === undefined ? {} : {recents}), events: []});
const RECENTS = [
  {type: "follower", name: "Cy", createdAt: "2025-01-15T11:58:00.000Z"},
  {type: "tip", name: "Ana", amount: 5, createdAt: "2025-01-15T11:50:00.000Z"}
];

test("the vendored jQuery is StreamElements' 3.3.1 file, in the sources, the engine build, and the hosted engine path", async () => {
  for (const path of ["../../src/runtime/vendor/jquery-3.3.1.min.js", "../../dist/runtime/vendor/jquery-3.3.1.min.js", "../../public/engine/runtime/vendor/jquery-3.3.1.min.js"]) {
    const bytes = await readFile(new URL(path, import.meta.url));
    assert.equal(bytes.byteLength, 86_927, path);
    assert.equal(sha256(bytes), JQUERY_SHA256, path);
  }
  const compiled = await readFile(new URL("../../dist/runtime/frame.js", import.meta.url), "utf8");
  assert.match(compiled, /new URL\("\.\/vendor\/jquery-3\.3\.1\.min\.js", import\.meta\.url\)/);
});

test("a fixture's recents is an array of events, and the legacy {} reads as []", () => {
  assert.deepEqual(fixtureSchema.parse(fixture({})).recents, []);
  assert.deepEqual(fixtureSchema.parse(fixture(RECENTS)).recents, RECENTS);
  assert.equal(fixtureSchema.parse(fixture(undefined)).recents, undefined);
  for (const refused of [{"follower-recent": []}, "events", [1]]) {
    const result = fixtureSchema.safeParse(fixture(refused));
    assert.equal(result.success, false, JSON.stringify(refused));
    if (!Array.isArray(refused)) assert.match(result.error.issues[0].message, /^recents is an array of events, as StreamElements passes onWidgetLoad's recents$/);
  }
});

test("the catalog loader reads a stored fixture's legacy recents {} as []", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sws-fixture-recents-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(join(root, "fixtures"));
  await writeFile(join(root, "fixtures", "legacy.json"), JSON.stringify(fixture({})));
  const [loaded] = await loadFixtures(root, "fixtures/*.json");
  assert.deepEqual(loaded.value.recents, []);
});

test("a scene's runtime state carries the fixture's recents as a clone, and [] without them", async () => {
  const project = await loadProject({inputDirectory: exampleRoot});
  project.fixtures.push({id: "night", filePath: "", value: fixture(RECENTS)});
  const viewport = {width: 200, height: 100};
  const scene = (id, fixtureId) => ({schemaVersion: 1, id, name: id, ...(fixtureId ? {fixture: fixtureId} : {}), viewport, output: {...viewport, format: "png"}});
  const {runtimeState} = resolveSceneState(project, scene("with", "night"));
  assert.deepEqual(runtimeState.recents, RECENTS);
  assert.notEqual(runtimeState.recents, project.fixtures.at(-1).value.recents, "a copy, not the catalog's array");
  assert.notEqual(runtimeState.recents[0], RECENTS[0]);
  assert.deepEqual(resolveSceneState(project, scene("without")).runtimeState.recents, []);
});
