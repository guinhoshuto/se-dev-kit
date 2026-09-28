import assert from "node:assert/strict";
import {chmod, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {proprietaryVideoReferences, runDoctor} from "../../dist/validation/doctor.js";

const item = (value) => ({id: value.id, filePath: `${value.id}.json`, value});
const project = (outputRoot, fieldData) => ({
  outputRoot,
  fieldDefaults: {clip: ""},
  themes: [item({schemaVersion: 1, id: "clips", name: "Clips", fieldData})],
  fixtures: [],
  scenes: [],
  scenarios: []
});
const codes = (report) => report.diagnostics.map((diagnostic) => diagnostic.code);

// An executable stub: detectBrowser only checks that the explicit path is executable.
async function fakeBrowser(t, name) {
  const dir = await mkdtemp(join(tmpdir(), "sws-doctor-"));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const path = join(dir, name);
  await writeFile(path, "#!/bin/sh\nexit 0\n");
  await chmod(path, 0o755);
  return {dir, path};
}

test("a Chromium build with MP4/MOV video in the catalog warns before the capture fails", async (t) => {
  const {dir, path} = await fakeBrowser(t, "Chromium");
  const report = await runDoctor({
    browserPath: path,
    project: project(dir, {clip: "media/clip.MP4", extra: ["media/loop.webm", "media/intro.mov?v=2"]})
  });
  const warning = report.diagnostics.find((diagnostic) => diagnostic.code === "BROWSER_NO_H264");
  assert.equal(warning?.status, "warning");
  assert.match(warning.detail, /\(media\/clip\.MP4, media\/intro\.mov\?v=2\)/);
});

test("WebM-only media or Google Chrome gives no codec warning", async (t) => {
  const chromium = await fakeBrowser(t, "Chromium");
  const webmOnly = await runDoctor({browserPath: chromium.path, project: project(chromium.dir, {clip: "media/clip.webm"})});
  assert.ok(codes(webmOnly).includes("BROWSER"));
  assert.ok(!codes(webmOnly).includes("BROWSER_NO_H264"));

  const chrome = await fakeBrowser(t, "Google Chrome");
  const withChrome = await runDoctor({browserPath: chrome.path, project: project(chrome.dir, {clip: "media/clip.mp4"})});
  assert.ok(codes(withChrome).includes("BROWSER"));
  assert.ok(!codes(withChrome).includes("BROWSER_NO_H264"));
});

test("video references come from field defaults, themes, fixtures, scenes and scenarios", () => {
  const references = proprietaryVideoReferences({
    fieldDefaults: {intro: "defaults/intro.m4v"},
    themes: [item({id: "theme", fieldData: {clip: "theme.mp4"}})],
    fixtures: [item({id: "fixture", events: [{event: {data: {video: "fixture.mov"}}}]})],
    scenes: [item({id: "scene", fieldData: {clip: "theme.mp4", poster: "poster.png"}})],
    scenarios: [item({id: "scenario", steps: [{action: "updateFields", fieldData: {clip: "step.mp4"}}]})]
  });
  assert.deepEqual(references, ["defaults/intro.m4v", "fixture.mov", "step.mp4", "theme.mp4"]);
});
