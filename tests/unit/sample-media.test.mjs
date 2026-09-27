import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, relative, sep} from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";

import {
  SAMPLE_REFERENCE_PATTERN,
  applySampleChoice,
  backgroundSelectValue,
  browserAssetUrl,
  collectSampleMediaReferences,
  fillEmptyImageFields,
  isSampleMediaReference,
  parseBackgroundSelectValue,
  parseMediaArrayText,
  sampleMediaDisplayText
} from "../../dist/studio-ui/sample-media.js";
import {FRAME_SAMPLE_REFERENCE_PATTERN, mapRuntimeAssets} from "../../dist/runtime/frame.js";
import {
  assertSampleMediaPins,
  loadSampleMediaCatalog,
  sampleMediaHashes
} from "../../dist/config/sample-media.js";
import {loadMarketplacePreset, marketplaceRecipeIssues} from "../../dist/config/presets.js";
import {loadProject} from "../../dist/config/load.js";
import {createDefaultScene, resolveSceneState} from "../../dist/scenarios/state.js";
import {validateProject} from "../../dist/validation/project.js";
import {compileTutorial} from "../../dist/tutorial/timeline.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const mediaRoot = join(repositoryRoot, "sample-media");
const manifest = JSON.parse(await readFile(join(mediaRoot, "manifest.json"), "utf8"));
const lock = JSON.parse(await readFile(new URL("./sample-media.lock.json", import.meta.url), "utf8"));

/** Reads the frame size from any baseline, extended, or progressive JPEG start-of-frame marker. */
function jpegDimensions(bytes) {
  assert.equal(bytes.readUInt16BE(0), 0xffd8, "JPEG must start with SOI");
  let offset = 2;
  while (offset < bytes.length) {
    assert.equal(bytes[offset], 0xff, "JPEG marker expected");
    const marker = bytes[offset + 1];
    const length = bytes.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xc2) {
      return {height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7)};
    }
    offset += 2 + length;
  }
  throw new Error("JPEG has no SOF0-SOF2 marker");
}

async function filesUnder(directory) {
  const found = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    if (entry.name.startsWith(".")) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await filesUnder(path)));
    else found.push(relative(mediaRoot, path).split(sep).join("/"));
  }
  return found;
}

test("the sample media manifest matches its files, dimensions, and provenance", async () => {
  const items = manifest.items;
  assert.equal(items.length, 14);
  assert.equal(items.filter((item) => item.kind === "gallery").length, 8);
  assert.equal(items.filter((item) => item.kind === "backdrop").length, 6);
  assert.equal(new Set(items.map((item) => item.id)).size, items.length);
  for (const item of items) {
    const bytes = await readFile(join(mediaRoot, item.file));
    assert.equal(item.reference, `sws-sample:${item.file}`);
    assert.ok(isSampleMediaReference(item.reference), item.reference);
    assert.equal(bytes.byteLength, item.bytes, item.file);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), item.sha256, item.file);
    assert.deepEqual(jpegDimensions(bytes), {width: item.width, height: item.height}, item.file);
    assert.ok(item.alt.trim().length > 20, `${item.file} needs alt text`);
    assert.ok(item.origin.trim().length > 0, `${item.file} needs an origin`);
    assert.match(item.color, /^#[0-9a-f]{6}$/);
    if (item.kind === "backdrop") assert.ok(["dark", "medium", "light"].includes(item.tone));
  }
  const listed = new Set([...items.map((item) => item.file), "manifest.json", "README.md"]);
  assert.deepEqual((await filesUnder(mediaRoot)).filter((file) => !listed.has(file)), []);
});

test("published sample references are append-only against the frozen lock", () => {
  const current = new Map(manifest.items.map((item) => [item.reference, item.sha256]));
  for (const [reference, sha256] of Object.entries(lock)) {
    assert.equal(current.get(reference), sha256, `${reference} was removed or changed bytes; add a new file instead`);
  }
  for (const reference of current.keys()) assert.ok(reference in lock, `${reference} must be added to sample-media.lock.json`);
});

test("the reference grammar accepts only whole, normalized sample file references", () => {
  assert.equal(isSampleMediaReference("sws-sample:gallery/synthwave-sunset.jpg"), true);
  assert.equal(isSampleMediaReference("sws-sample:backdrops/aurora-mesh.jpg"), true);
  for (const value of [
    "sws-sample:../package.json",
    "sws-sample:gallery/../../package.json",
    "sws-sample:%2e%2e/gallery/x.jpg",
    "sws-sample:Gallery/X.jpg",
    "sws-sample:gallery\\x.jpg",
    "sws-sample:gallery/x.jpg\u0000.png",
    "sws-sample:gallery/extra/x.jpg",
    "sws-sample:gallery/x.jpg?x",
    "sws-sample:gallery/x.jpg#x",
    "swssample:gallery/x.jpg",
    "sws-sample:gallery/x y.jpg",
    "see sws-sample:gallery/x.jpg",
    "sws-sample:gallery/x.svg",
    "sws-sample:gallery/.hidden.jpg"
  ]) {
    assert.equal(isSampleMediaReference(value), false, value);
  }
  assert.equal(FRAME_SAMPLE_REFERENCE_PATTERN.source, SAMPLE_REFERENCE_PATTERN.source, "the frame runtime copy must stay identical");
});

test("the skill documents every published sample reference", async () => {
  const reference = await readFile(join(repositoryRoot, "skills/se-widget-studio/references/catalog-authoring.md"), "utf8");
  for (const item of manifest.items) assert.ok(reference.includes(item.reference), `${item.reference} missing from catalog-authoring.md`);
});

test("sample references are collected from strings, arrays, and nested objects without duplicates", () => {
  const value = {
    image: "sws-sample:gallery/neon-city.jpg",
    gallery: ["sws-sample:gallery/ocean-moon.jpg", "sws-sample:gallery/neon-city.jpg", "assets/local.png"],
    nested: {events: [{data: {avatar: "sws-sample:gallery/pixel-forest.jpg", text: "mentions sws-sample:gallery/x.jpg"}}]},
    date: new Date(0)
  };
  assert.deepEqual(collectSampleMediaReferences(value), [
    "sws-sample:gallery/neon-city.jpg",
    "sws-sample:gallery/ocean-moon.jpg",
    "sws-sample:gallery/pixel-forest.jpg"
  ]);
});

test("filling empty image fields is explicit, deterministic, and returns only the patch", () => {
  const gallery = manifest.items.filter((item) => item.kind === "gallery").map((item) => item.reference);
  const fields = [
    {id: "missing", type: "image-input", definition: {}},
    {id: "empty", type: "image-input", definition: {}},
    {id: "set", type: "image-input", definition: {}},
    {id: "list", type: "image-input", definition: {multiple: true}},
    {id: "blankList", type: "image-input", definition: {multiple: true}},
    {id: "video", type: "video-input", definition: {}},
    {id: "sound", type: "sound-input", definition: {}},
    {id: "title", type: "text", definition: {}}
  ];
  const values = {empty: "", set: "assets/logo.png", list: [], blankList: [""], video: "", sound: null, title: ""};
  const patch = fillEmptyImageFields(fields, values, gallery);
  assert.deepEqual(Object.keys(patch), ["missing", "empty", "list", "blankList"]);
  assert.equal(patch.missing, gallery[0]);
  assert.equal(patch.empty, gallery[1]);
  assert.deepEqual(patch.list, gallery.slice(2, 6));
  assert.deepEqual(patch.blankList, gallery.slice(3, 7));
  assert.deepEqual(fillEmptyImageFields(fields, values, gallery), patch);
  assert.deepEqual(fillEmptyImageFields(fields, values, []), {});
});

test("media controls keep arrays and resolve sample URLs only through the served catalog", () => {
  assert.deepEqual(parseMediaArrayText('["a.png", "sws-sample:gallery/neon-city.jpg"]'), ["a.png", "sws-sample:gallery/neon-city.jpg"]);
  assert.deepEqual(parseMediaArrayText(""), []);
  assert.equal(parseMediaArrayText('"a.png"'), undefined);
  assert.equal(parseMediaArrayText("[broken"), undefined);
  assert.deepEqual(applySampleChoice(["a.png"], "sws-sample:gallery/neon-city.jpg", true), ["a.png", "sws-sample:gallery/neon-city.jpg"]);
  assert.deepEqual(applySampleChoice(["sws-sample:gallery/neon-city.jpg"], "sws-sample:gallery/neon-city.jpg", true), ["sws-sample:gallery/neon-city.jpg"]);
  assert.deepEqual(applySampleChoice("", "sws-sample:gallery/neon-city.jpg", true), ["sws-sample:gallery/neon-city.jpg"]);
  assert.equal(applySampleChoice(["x"], "sws-sample:gallery/neon-city.jpg", false), "sws-sample:gallery/neon-city.jpg");

  const samples = [{reference: "sws-sample:backdrops/aurora-mesh.jpg", kind: "backdrop", label: "Aurora", alt: "", width: 2000, height: 2000, url: "http://127.0.0.1:9/__sws/sample/backdrops/aurora-mesh.jpg"}];
  assert.equal(browserAssetUrl("sws-sample:backdrops/aurora-mesh.jpg", "http://127.0.0.1:9", samples), samples[0].url);
  assert.equal(browserAssetUrl("sws-sample:backdrops/unknown.jpg", "http://127.0.0.1:9", samples), "");
  assert.equal(browserAssetUrl("media/a b.png", "http://127.0.0.1:9", samples), "http://127.0.0.1:9/__sws/widget/media/a%20b.png");
  assert.equal(browserAssetUrl("data:image/png;base64,AA==", "http://127.0.0.1:9", samples), "data:image/png;base64,AA==");
  assert.equal(backgroundSelectValue("image", "sws-sample:backdrops/aurora-mesh.jpg", samples), "sample:sws-sample:backdrops/aurora-mesh.jpg");
  assert.equal(backgroundSelectValue("image", "media/bg.png", samples), "image");
  assert.deepEqual(parseBackgroundSelectValue("sample:sws-sample:backdrops/aurora-mesh.jpg", samples), {mode: "image", image: "sws-sample:backdrops/aurora-mesh.jpg"});
  assert.equal(parseBackgroundSelectValue("sample:sws-sample:backdrops/unknown.jpg", samples), undefined);
  assert.deepEqual(parseBackgroundSelectValue("white", samples), {mode: "white"});
  assert.equal(sampleMediaDisplayText("sws-sample:gallery/neon-city.jpg"), "neon-city.jpg");
  assert.equal(sampleMediaDisplayText('["sws-sample:gallery/neon-city.jpg","a.png"]'), "neon-city.jpg, a.png");
  assert.equal(sampleMediaDisplayText("assets/logo.png"), "assets/logo.png");
});

test("frame asset mapping rewrites only plain data and never prototype keys", () => {
  const base = "http://127.0.0.1:9/__sws/sample/";
  const date = new Date(0);
  const map = new Map([["a", 1]]);
  const input = {
    image: "sws-sample:gallery/neon-city.jpg",
    list: ["sws-sample:gallery/ocean-moon.jpg", "keep"],
    date,
    map,
    text: "constructor",
    other: "toString",
    untouched: {a: ["plain"]}
  };
  const output = mapRuntimeAssets(input, {"assets/a.png": "data:image/png;base64,AA=="}, base);
  assert.equal(output.image, `${base}gallery/neon-city.jpg`);
  assert.deepEqual(output.list, [`${base}gallery/ocean-moon.jpg`, "keep"]);
  assert.equal(output.date, date);
  assert.equal(output.map, map);
  assert.equal(output.text, "constructor");
  assert.equal(output.other, "toString");
  assert.equal(output.untouched, input.untouched);
  assert.equal(mapRuntimeAssets(input.untouched, undefined, base), input.untouched);
  assert.equal(mapRuntimeAssets("constructor", {}), "constructor");
  assert.equal(mapRuntimeAssets("sws-sample:gallery/neon-city.jpg", undefined, undefined), "sws-sample:gallery/neon-city.jpg");
  assert.equal(mapRuntimeAssets("sws-sample:gallery/neon-city.jpg", {"sws-sample:gallery/neon-city.jpg": "data:x"}, base), "data:x");
});

test("the catalog loader verifies bytes, rejects tampering, and checks revision pins", async (t) => {
  const catalog = await loadSampleMediaCatalog(mediaRoot);
  assert.equal(catalog.items.length, 14);
  assert.equal(catalog.body("sws-sample:gallery/pixel-forest.jpg").byteLength, 14_932);
  assert.deepEqual(await sampleMediaHashes({a: ["sws-sample:gallery/pixel-forest.jpg"]}, mediaRoot), {
    "sws-sample:gallery/pixel-forest.jpg": lock["sws-sample:gallery/pixel-forest.jpg"]
  });
  await assertSampleMediaPins({"sws-sample:gallery/pixel-forest.jpg": lock["sws-sample:gallery/pixel-forest.jpg"]}, mediaRoot);
  await assert.rejects(assertSampleMediaPins({"sws-sample:gallery/pixel-forest.jpg": "0".repeat(64)}, mediaRoot), {code: "SAMPLE_MEDIA_CHANGED"});
  await assert.rejects(assertSampleMediaPins({"sws-sample:gallery/unknown.jpg": "0".repeat(64)}, mediaRoot), {code: "SAMPLE_MEDIA_NOT_FOUND"});
  await assert.rejects(sampleMediaHashes({a: "sws-sample:gallery/unknown.jpg"}, mediaRoot), {code: "SAMPLE_MEDIA_NOT_FOUND"});

  const root = await mkdtemp(join(tmpdir(), "sws-sample-tamper-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const item = manifest.items.find((entry) => entry.id === "pixel-forest");
  await mkdir(join(root, "gallery"));
  await copyFile(join(mediaRoot, item.file), join(root, item.file));
  await writeFile(join(root, "manifest.json"), JSON.stringify({schemaVersion: 1, items: [item]}));
  assert.equal((await loadSampleMediaCatalog(root)).items.length, 1);
  const tampered = join(root, "tampered");
  await mkdir(join(tampered, "gallery"), {recursive: true});
  await writeFile(join(tampered, item.file), "not the pinned bytes");
  await writeFile(join(tampered, "manifest.json"), JSON.stringify({schemaVersion: 1, items: [item]}));
  await assert.rejects(loadSampleMediaCatalog(tampered), {code: "SAMPLE_MEDIA_CATALOG_INVALID"});
  await assert.rejects(loadSampleMediaCatalog(join(root, "missing")), {code: "SAMPLE_MEDIA_CATALOG_INVALID"});
  const escaping = join(root, "escaping");
  await mkdir(escaping);
  await writeFile(join(escaping, "manifest.json"), JSON.stringify({schemaVersion: 1, items: [{...item, file: "../gallery/pixel-forest.jpg"}]}));
  await assert.rejects(loadSampleMediaCatalog(escaping), {code: "SAMPLE_MEDIA_CATALOG_INVALID"});
});

async function mediaWidget(t, scene) {
  const root = await mkdtemp(join(tmpdir(), "sws-sample-widget-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  await Promise.all([
    writeFile(join(root, "widget.html"), '<main id="widget"></main>\n'),
    writeFile(join(root, "widget.css"), "body{margin:0}\n"),
    writeFile(join(root, "widget.js"), "window.addEventListener('onWidgetLoad', () => {});\n"),
    writeFile(join(root, "widget.json"), JSON.stringify({image: {type: "image-input", label: "Image", value: ""}, gallery: {type: "image-input", label: "Gallery", multiple: true, value: []}}))
  ]);
  const project = await loadProject({inputDirectory: root});
  if (scene) project.scenes.push({id: scene.id, filePath: "", value: scene});
  return project;
}

test("empty image fields stay empty by default, matching StreamElements", async (t) => {
  const project = await mediaWidget(t);
  const scene = createDefaultScene(project);
  assert.equal(scene.fieldData, undefined);
  const state = resolveSceneState(project, scene);
  assert.equal(state.runtimeState.fieldData.image, "");
  assert.deepEqual(state.runtimeState.fieldData.gallery, []);
});

test("validate reports unknown sample references and accepts known ones", async (t) => {
  const known = await mediaWidget(t, {
    schemaVersion: 1,
    id: "sample",
    name: "Sample",
    fieldData: {image: "sws-sample:gallery/neon-city.jpg", gallery: ["sws-sample:gallery/ocean-moon.jpg"]},
    background: {id: "aurora", image: "sws-sample:backdrops/aurora-mesh.jpg"}
  });
  const knownDiagnostics = await validateProject(known);
  assert.equal(knownDiagnostics.some((item) => item.code === "SAMPLE_MEDIA_UNKNOWN"), false);
  assert.ok(knownDiagnostics.some((item) => item.code === "SAMPLE_MEDIA" && item.status === "ok"));

  const unknown = await mediaWidget(t, {schemaVersion: 1, id: "sample", name: "Sample", fieldData: {gallery: ["sws-sample:gallery/missing.jpg"]}});
  const failure = (await validateProject(unknown)).find((item) => item.code === "SAMPLE_MEDIA_UNKNOWN");
  assert.equal(failure?.status, "error");
  assert.match(failure.detail, /scene "sample" uses sws-sample:gallery\/missing\.jpg/);
  assert.match(failure.hint, /manifest\.json/);
});

test("a JPEG sample backdrop satisfies marketplace opacity without a paired color", async (t) => {
  const project = await mediaWidget(t);
  const preset = await loadMarketplacePreset("etsy-listing-2026-08");
  const recipe = {schemaVersion: 1, id: "listing", name: "Listing", scenes: ["default"], marketplacePreset: preset.id, outputs: {screenshots: true}};
  const variant = (background) => ({
    id: "v",
    scene: createDefaultScene(project),
    theme: null,
    fixture: null,
    background,
    viewport: {width: 2000, height: 2000},
    output: {width: 2000, height: 2000, format: "jpeg"},
    camera: {id: "default", scale: 1, x: 0, y: 0}
  });
  const opacityIssue = (background) => marketplaceRecipeIssues(recipe, preset, [variant(background)]).some((issue) => issue.includes("opaque"));
  assert.equal(opacityIssue({id: "prism", image: "sws-sample:backdrops/prism-sky.jpg"}), false);
  assert.equal(opacityIssue({id: "clear", color: "transparent"}), true);
});

test("the tutorial editor replica shows sample file names, never the internal scheme", () => {
  const fields = [{id: "image", label: "Image", type: "image-input", value: "", group: "Media", options: [], definition: {}, editable: true}];
  const timeline = compileTutorial({
    tutorial: {steps: [{action: "setField", field: "image", value: "sws-sample:gallery/neon-city.jpg"}]},
    fields,
    fieldData: {image: "sws-sample:gallery/ocean-moon.jpg"},
    channel: "synthetic"
  });
  assert.equal(timeline.initialValues.image, "ocean-moon.jpg");
  const shown = JSON.stringify(timeline.patches);
  assert.equal(shown.includes("sws-sample:"), false);
  assert.ok(shown.includes("neon-city.jpg"));
  assert.ok(timeline.widget.some((action) => action.fieldData?.image === "sws-sample:gallery/neon-city.jpg"));
});

test("render provenance hashes the sample bytes used by catalogs and leaves sample-free digests alone", async (t) => {
  const {captureInputSnapshot} = await import("../../dist/capture/renderer.js");
  const recipe = {schemaVersion: 1, id: "listing", name: "Listing", scenes: ["sample"], outputs: {screenshots: true}};
  const withSample = await mediaWidget(t, {schemaVersion: 1, id: "sample", name: "Sample", background: {id: "aurora", image: "sws-sample:backdrops/aurora-mesh.jpg"}});
  const first = await captureInputSnapshot(withSample, recipe);
  assert.deepEqual(first.sampleMediaHashes, {"sws-sample:backdrops/aurora-mesh.jpg": lock["sws-sample:backdrops/aurora-mesh.jpg"]});
  withSample.scenes[0].value.background.image = "sws-sample:backdrops/noir-warm.jpg";
  const second = await captureInputSnapshot(withSample, recipe);
  assert.notEqual(second.digest, first.digest);
  assert.deepEqual(Object.keys(second.sampleMediaHashes), ["sws-sample:backdrops/noir-warm.jpg"]);

  const matrixRecipe = {...recipe, matrix: {backgrounds: [{id: "prism", image: "sws-sample:backdrops/prism-sky.jpg"}]}};
  assert.ok("sws-sample:backdrops/prism-sky.jpg" in (await captureInputSnapshot(withSample, matrixRecipe)).sampleMediaHashes);

  const plain = await mediaWidget(t, {schemaVersion: 1, id: "sample", name: "Sample"});
  const {hashJson} = await import("../../dist/capture/hash.js");
  const snapshot = await captureInputSnapshot(plain, recipe);
  assert.deepEqual(snapshot.sampleMediaHashes, {});
  assert.equal(snapshot.digest, hashJson({inputHashes: snapshot.inputHashes, sourceHashes: snapshot.sourceHashes, assetHashes: snapshot.assetHashes}));
});
