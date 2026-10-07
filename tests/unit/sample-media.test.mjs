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
  sampleKindsForField,
  sampleMediaDisplayText
} from "../../dist/studio-ui/sample-media.js";
import {FRAME_SAMPLE_REFERENCE_PATTERN, mapRuntimeAssets} from "../../dist/runtime/frame.js";
import {
  assertSampleMediaPins,
  loadSampleMediaCatalog,
  sampleMediaHashes,
  sampleMediaReferencesByKind
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

/** Reads the size of a PNG from its IHDR chunk. */
function pngDimensions(bytes) {
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "PNG signature expected");
  assert.equal(bytes.subarray(12, 16).toString("latin1"), "IHDR");
  return {width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20)};
}

/** Reads a WebM's codec, frame size, and duration from its EBML header and Segment Info/Tracks, enough for a single-track file. */
function webmInfo(bytes) {
  assert.equal(bytes.readUInt32BE(0), 0x1a45dfa3, "EBML header expected");
  const vint = (offset, keepMarker) => {
    const first = bytes[offset];
    let length = 1;
    while (length <= 8 && !(first & (0x80 >> (length - 1)))) length += 1;
    let value = keepMarker ? first : first & (0xff >> length);
    for (let index = 1; index < length; index += 1) value = value * 256 + bytes[offset + index];
    return {value, length};
  };
  const info = {};
  let timecodeScale = 1_000_000;
  const walk = (start, end) => {
    let offset = start;
    while (offset < end) {
      const id = vint(offset, true);
      const size = vint(offset + id.length, false);
      const body = offset + id.length + size.length;
      const unknown = size.value === 2 ** (7 * size.length) - 1;
      const stop = unknown ? end : Math.min(end, body + size.value);
      // Segment, Info, Tracks, TrackEntry, Video are containers; Cluster ends the walk.
      if ([0x18538067, 0x1549a966, 0x1654ae6b, 0xae, 0xe0].includes(id.value)) walk(body, stop);
      else if (id.value === 0x1f43b675) return;
      else if (id.value === 0x2ad7b1) timecodeScale = bytes.readUIntBE(body, size.value);
      else if (id.value === 0x4489) info.durationMs = (size.value === 8 ? bytes.readDoubleBE(body) : bytes.readFloatBE(body)) * timecodeScale / 1_000_000;
      else if (id.value === 0x86) info.codec = bytes.subarray(body, stop).toString("latin1");
      else if (id.value === 0xb0) info.width = bytes.readUIntBE(body, size.value);
      else if (id.value === 0xba) info.height = bytes.readUIntBE(body, size.value);
      offset = stop;
    }
  };
  walk(0 + 4 + vint(4, false).length + vint(4, false).value, bytes.length);
  return info;
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
  assert.equal(items.length, 17);
  assert.equal(items.filter((item) => item.kind === "gallery").length, 3);
  assert.equal(items.filter((item) => item.kind === "backdrop").length, 7);
  assert.equal(items.filter((item) => item.kind === "avatar").length, 6);
  assert.equal(items.filter((item) => item.kind === "clip").length, 1);
  assert.equal(new Set(items.map((item) => item.id)).size, items.length);
  for (const item of items) {
    const bytes = await readFile(join(mediaRoot, item.file));
    assert.equal(item.reference, `sws-sample:${item.file}`);
    assert.ok(isSampleMediaReference(item.reference), item.reference);
    assert.equal(bytes.byteLength, item.bytes, item.file);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), item.sha256, item.file);
    if (item.contentType === "image/jpeg") assert.deepEqual(jpegDimensions(bytes), {width: item.width, height: item.height}, item.file);
    else if (item.contentType === "image/png") assert.deepEqual(pngDimensions(bytes), {width: item.width, height: item.height}, item.file);
    else {
      assert.equal(item.contentType, "video/webm", item.file);
      assert.deepEqual(webmInfo(bytes), {codec: "V_VP9", width: item.width, height: item.height, durationMs: item.durationMs}, item.file);
    }
    assert.equal(item.kind === "clip", item.durationMs !== undefined, `${item.file}: only clips have a duration`);
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
  const retired = new Set(manifest.retired.map((item) => item.reference));
  assert.equal(retired.size, 15);
  for (const [reference, sha256] of Object.entries(lock)) {
    if (retired.has(reference)) assert.equal(current.has(reference), false, `${reference} is retired and must never return`);
    else assert.equal(current.get(reference), sha256, `${reference} was removed or changed bytes; add a new file instead`);
  }
  for (const reference of current.keys()) assert.ok(reference in lock, `${reference} must be added to sample-media.lock.json`);
  for (const reference of retired) assert.ok(reference in lock, `${reference} was never published, so it cannot be retired`);
});

test("the reference grammar accepts only whole, normalized sample file references", () => {
  assert.equal(isSampleMediaReference("sws-sample:gallery/streamer-1-blur.jpg"), true);
  assert.equal(isSampleMediaReference("sws-sample:backdrops/cute-2.jpg"), true);
  assert.equal(isSampleMediaReference("sws-sample:avatars/pixel-1.png"), true);
  assert.equal(isSampleMediaReference("sws-sample:clips/neon-road.webm"), true);
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
    "sws-sample:clips/x.mp4",
    "sws-sample:gallery/.hidden.jpg"
  ]) {
    assert.equal(isSampleMediaReference(value), false, value);
  }
  assert.equal(FRAME_SAMPLE_REFERENCE_PATTERN.source, SAMPLE_REFERENCE_PATTERN.source, "the frame runtime copy must stay identical");
});

test("the skill documents every published sample reference and never a retired one", async () => {
  const reference = await readFile(join(repositoryRoot, "skills/se-widget-studio/references/catalog-authoring.md"), "utf8");
  for (const item of manifest.items) assert.ok(reference.includes(item.reference), `${item.reference} missing from catalog-authoring.md`);
  const skillRoot = join(repositoryRoot, "skills/se-widget-studio");
  const skillFiles = (await readdir(skillRoot, {recursive: true})).filter((file) => /\.(md|mjs)$/.test(file));
  assert.ok(skillFiles.length > 3, "the skill files were not found");
  for (const file of skillFiles) {
    const text = await readFile(join(skillRoot, file), "utf8");
    for (const {reference} of manifest.retired) assert.equal(text.includes(reference), false, `${file} still names the retired ${reference}`);
  }
});

test("sample references are collected from strings, arrays, and nested objects without duplicates", () => {
  const value = {
    image: "sws-sample:gallery/streamer-1-blur.jpg",
    gallery: ["sws-sample:gallery/streamer-2.jpg", "sws-sample:gallery/streamer-1-blur.jpg", "assets/local.png"],
    nested: {events: [{data: {avatar: "sws-sample:backdrops/cute.jpg", text: "mentions sws-sample:gallery/x.jpg"}}]},
    date: new Date(0)
  };
  assert.deepEqual(collectSampleMediaReferences(value), [
    "sws-sample:gallery/streamer-1-blur.jpg",
    "sws-sample:gallery/streamer-2.jpg",
    "sws-sample:backdrops/cute.jpg"
  ]);
});

test("filling empty image fields is explicit, deterministic, and returns only the patch", () => {
  // Eight references exercise the rotation; the shipped gallery has three (checked at the end).
  const gallery = Array.from({length: 8}, (_value, index) => `sws-sample:gallery/image-${index}.jpg`);
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

  const shipped = manifest.items.filter((item) => item.kind === "gallery").map((item) => item.reference);
  assert.deepEqual(fillEmptyImageFields(fields.slice(0, 4), {}, shipped), {missing: shipped[0], empty: shipped[1], set: shipped[2], list: [shipped[0], shipped[1], shipped[2]]});
});

test("media controls keep arrays and resolve sample URLs only through the served catalog", () => {
  assert.deepEqual(parseMediaArrayText('["a.png", "sws-sample:gallery/streamer-1-blur.jpg"]'), ["a.png", "sws-sample:gallery/streamer-1-blur.jpg"]);
  assert.deepEqual(parseMediaArrayText(""), []);
  assert.equal(parseMediaArrayText('"a.png"'), undefined);
  assert.equal(parseMediaArrayText("[broken"), undefined);
  assert.deepEqual(applySampleChoice(["a.png"], "sws-sample:gallery/streamer-1-blur.jpg", true), ["a.png", "sws-sample:gallery/streamer-1-blur.jpg"]);
  assert.deepEqual(applySampleChoice(["sws-sample:gallery/streamer-1-blur.jpg"], "sws-sample:gallery/streamer-1-blur.jpg", true), ["sws-sample:gallery/streamer-1-blur.jpg"]);
  assert.deepEqual(applySampleChoice("", "sws-sample:gallery/streamer-1-blur.jpg", true), ["sws-sample:gallery/streamer-1-blur.jpg"]);
  assert.equal(applySampleChoice(["x"], "sws-sample:gallery/streamer-1-blur.jpg", false), "sws-sample:gallery/streamer-1-blur.jpg");

  const samples = [{reference: "sws-sample:backdrops/blueprint.jpg", kind: "backdrop", label: "Blueprint", alt: "", width: 1254, height: 1254, url: "http://127.0.0.1:9/__sws/sample/backdrops/blueprint.jpg"}];
  assert.equal(browserAssetUrl("sws-sample:backdrops/blueprint.jpg", "http://127.0.0.1:9", samples), samples[0].url);
  assert.equal(browserAssetUrl("sws-sample:backdrops/unknown.jpg", "http://127.0.0.1:9", samples), "");
  assert.equal(browserAssetUrl("media/a b.png", "http://127.0.0.1:9", samples), "http://127.0.0.1:9/__sws/widget/media/a%20b.png");
  assert.equal(browserAssetUrl("data:image/png;base64,AA==", "http://127.0.0.1:9", samples), "data:image/png;base64,AA==");
  assert.equal(backgroundSelectValue("image", "sws-sample:backdrops/blueprint.jpg", samples), "sample:sws-sample:backdrops/blueprint.jpg");
  assert.equal(backgroundSelectValue("image", "media/bg.png", samples), "image");
  assert.deepEqual(parseBackgroundSelectValue("sample:sws-sample:backdrops/blueprint.jpg", samples), {mode: "image", image: "sws-sample:backdrops/blueprint.jpg"});
  assert.equal(parseBackgroundSelectValue("sample:sws-sample:backdrops/unknown.jpg", samples), undefined);
  assert.deepEqual(parseBackgroundSelectValue("white", samples), {mode: "white"});
  assert.equal(sampleMediaDisplayText("sws-sample:gallery/streamer-1-blur.jpg"), "streamer-1-blur.jpg");
  assert.equal(sampleMediaDisplayText('["sws-sample:gallery/streamer-1-blur.jpg","a.png"]'), "streamer-1-blur.jpg, a.png");
  assert.equal(sampleMediaDisplayText("assets/logo.png"), "assets/logo.png");
  assert.deepEqual(sampleKindsForField("image-input"), ["gallery", "backdrop", "avatar"]);
  assert.deepEqual(sampleKindsForField("video-input"), ["clip"]);
  assert.deepEqual(sampleKindsForField("sound-input"), []);
});

test("frame asset mapping rewrites only plain data and never prototype keys", () => {
  const base = "http://127.0.0.1:9/__sws/sample/";
  const date = new Date(0);
  const map = new Map([["a", 1]]);
  const input = {
    image: "sws-sample:gallery/streamer-1-blur.jpg",
    list: ["sws-sample:gallery/streamer-2.jpg", "keep"],
    date,
    map,
    text: "constructor",
    other: "toString",
    untouched: {a: ["plain"]}
  };
  const output = mapRuntimeAssets(input, {"assets/a.png": "data:image/png;base64,AA=="}, base);
  assert.equal(output.image, `${base}gallery/streamer-1-blur.jpg`);
  assert.deepEqual(output.list, [`${base}gallery/streamer-2.jpg`, "keep"]);
  assert.equal(output.date, date);
  assert.equal(output.map, map);
  assert.equal(output.text, "constructor");
  assert.equal(output.other, "toString");
  assert.equal(output.untouched, input.untouched);
  assert.equal(mapRuntimeAssets(input.untouched, undefined, base), input.untouched);
  assert.equal(mapRuntimeAssets("constructor", {}), "constructor");
  assert.equal(mapRuntimeAssets("sws-sample:gallery/streamer-1-blur.jpg", undefined, undefined), "sws-sample:gallery/streamer-1-blur.jpg");
  assert.equal(mapRuntimeAssets("sws-sample:gallery/streamer-1-blur.jpg", {"sws-sample:gallery/streamer-1-blur.jpg": "data:x"}, base), "data:x");
});

test("the catalog loader verifies bytes, rejects tampering, and checks revision pins", async (t) => {
  const catalog = await loadSampleMediaCatalog(mediaRoot);
  assert.equal(catalog.items.length, 17);
  assert.equal(catalog.entry("sws-sample:clips/neon-road.webm").durationMs, 4000);
  assert.deepEqual(sampleMediaReferencesByKind(catalog).clip, ["sws-sample:clips/neon-road.webm"]);
  assert.equal(sampleMediaReferencesByKind(catalog).avatar.length, 6);
  assert.equal(catalog.body("sws-sample:backdrops/cute.jpg").byteLength, 47_742);
  assert.deepEqual(await sampleMediaHashes({a: ["sws-sample:backdrops/cute.jpg"]}, mediaRoot), {
    "sws-sample:backdrops/cute.jpg": lock["sws-sample:backdrops/cute.jpg"]
  });
  await assertSampleMediaPins({"sws-sample:backdrops/cute.jpg": lock["sws-sample:backdrops/cute.jpg"]}, mediaRoot);
  await assert.rejects(assertSampleMediaPins({"sws-sample:backdrops/cute.jpg": "0".repeat(64)}, mediaRoot), {code: "SAMPLE_MEDIA_CHANGED"});
  await assert.rejects(assertSampleMediaPins({"sws-sample:gallery/unknown.jpg": "0".repeat(64)}, mediaRoot), {code: "SAMPLE_MEDIA_NOT_FOUND", message: "Unknown sample media reference: sws-sample:gallery/unknown.jpg"});
  await assert.rejects(sampleMediaHashes({a: "sws-sample:gallery/unknown.jpg"}, mediaRoot), {code: "SAMPLE_MEDIA_NOT_FOUND"});

  // A revision saved before 2026-09-29 may pin a retired sample: it fails and says when the sample left.
  const retired = "sws-sample:gallery/neon-city.jpg";
  assert.equal(catalog.retiredOn(retired), "2026-09-29");
  assert.equal(catalog.retiredOn("sws-sample:backdrops/cute.jpg"), undefined);
  assert.equal(catalog.entry(retired), undefined);
  assert.throws(() => catalog.body(retired), {code: "SAMPLE_MEDIA_NOT_FOUND", message: `Sample media reference ${retired} was retired on 2026-09-29 and no longer ships`});
  await assert.rejects(assertSampleMediaPins({[retired]: lock[retired]}, mediaRoot), {code: "SAMPLE_MEDIA_NOT_FOUND", message: `Sample media reference ${retired} was retired on 2026-09-29 and no longer ships`});
  await assert.rejects(sampleMediaHashes({a: "sws-sample:backdrops/aurora-mesh.jpg"}, mediaRoot), {code: "SAMPLE_MEDIA_NOT_FOUND", message: /aurora-mesh\.jpg was retired on 2026-09-29/});

  const root = await mkdtemp(join(tmpdir(), "sws-sample-tamper-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const item = manifest.items.find((entry) => entry.id === "cute");
  await mkdir(join(root, "backdrops"));
  await copyFile(join(mediaRoot, item.file), join(root, item.file));
  await writeFile(join(root, "manifest.json"), JSON.stringify({schemaVersion: 1, items: [item]}));
  assert.equal((await loadSampleMediaCatalog(root)).items.length, 1);
  const tampered = join(root, "tampered");
  await mkdir(join(tampered, "backdrops"), {recursive: true});
  await writeFile(join(tampered, item.file), "not the pinned bytes");
  await writeFile(join(tampered, "manifest.json"), JSON.stringify({schemaVersion: 1, items: [item]}));
  await assert.rejects(loadSampleMediaCatalog(tampered), {code: "SAMPLE_MEDIA_CATALOG_INVALID"});
  await assert.rejects(loadSampleMediaCatalog(join(root, "missing")), {code: "SAMPLE_MEDIA_CATALOG_INVALID"});
  const escaping = join(root, "escaping");
  await mkdir(escaping);
  await writeFile(join(escaping, "manifest.json"), JSON.stringify({schemaVersion: 1, items: [{...item, file: "../backdrops/cute.jpg"}]}));
  await assert.rejects(loadSampleMediaCatalog(escaping), {code: "SAMPLE_MEDIA_CATALOG_INVALID"});

  // A clip must be a video with a duration, and only a clip may be.
  const clip = manifest.items.find((entry) => entry.kind === "clip");
  const kinds = join(root, "kinds");
  await mkdir(join(kinds, "clips"), {recursive: true});
  await mkdir(join(kinds, "backdrops"));
  await copyFile(join(mediaRoot, clip.file), join(kinds, clip.file));
  await copyFile(join(mediaRoot, item.file), join(kinds, item.file));
  for (const [items, message] of [
    [[{...clip, durationMs: undefined}], /neon-road must have a durationMs only if it is a clip/],
    [[{...clip, kind: "gallery", durationMs: undefined}], /neon-road kind gallery does not match video\/webm/],
    [[{...item, durationMs: 4000}], /cute must have a durationMs only if it is a clip/],
    [[{...item, kind: "clip", tone: undefined, durationMs: 4000}], /cute kind clip does not match image\/jpeg/]
  ]) {
    await writeFile(join(kinds, "manifest.json"), JSON.stringify({schemaVersion: 1, items}));
    await assert.rejects(loadSampleMediaCatalog(kinds), {code: "SAMPLE_MEDIA_CATALOG_INVALID", message}, String(message));
  }
  await writeFile(join(kinds, "manifest.json"), JSON.stringify({schemaVersion: 1, items: [clip, item]}));
  assert.equal((await loadSampleMediaCatalog(kinds)).items.length, 2);

  const reused = join(root, "reused");
  await mkdir(join(reused, "backdrops"), {recursive: true});
  await copyFile(join(mediaRoot, item.file), join(reused, item.file));
  await writeFile(join(reused, "manifest.json"), JSON.stringify({schemaVersion: 1, items: [item], retired: [{reference: item.reference, retiredOn: "2026-09-29"}]}));
  await assert.rejects(loadSampleMediaCatalog(reused), {code: "SAMPLE_MEDIA_CATALOG_INVALID", message: /cute reuses the retired reference/});
  const twice = {reference: retired, retiredOn: "2026-09-29"};
  await writeFile(join(reused, "manifest.json"), JSON.stringify({schemaVersion: 1, items: [item], retired: [twice, twice]}));
  await assert.rejects(loadSampleMediaCatalog(reused), {code: "SAMPLE_MEDIA_CATALOG_INVALID", message: /duplicate retired reference/});
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
    fieldData: {image: "sws-sample:gallery/streamer-1-blur.jpg", gallery: ["sws-sample:gallery/streamer-2.jpg"]},
    background: {id: "blueprint", image: "sws-sample:backdrops/blueprint.jpg"}
  });
  const knownDiagnostics = await validateProject(known);
  assert.equal(knownDiagnostics.some((item) => item.code === "SAMPLE_MEDIA_UNKNOWN"), false);
  assert.ok(knownDiagnostics.some((item) => item.code === "SAMPLE_MEDIA" && item.status === "ok"));

  const unknown = await mediaWidget(t, {schemaVersion: 1, id: "sample", name: "Sample", fieldData: {gallery: ["sws-sample:gallery/missing.jpg"]}});
  const failure = (await validateProject(unknown)).find((item) => item.code === "SAMPLE_MEDIA_UNKNOWN");
  assert.equal(failure?.status, "error");
  assert.match(failure.detail, /scene "sample" uses sws-sample:gallery\/missing\.jpg\.$/);
  assert.match(failure.hint, /manifest\.json/);

  const retired = await mediaWidget(t, {schemaVersion: 1, id: "old", name: "Old", background: {id: "aurora", image: "sws-sample:backdrops/aurora-mesh.jpg"}});
  const retiredFailure = (await validateProject(retired)).find((item) => item.code === "SAMPLE_MEDIA_UNKNOWN");
  assert.equal(retiredFailure?.status, "error");
  assert.match(retiredFailure.detail, /scene "old" uses sws-sample:backdrops\/aurora-mesh\.jpg \(retired on 2026-09-29\)/);
});

test("validate rejects a clip as a background and warns about a sample of the wrong kind for its field", async (t) => {
  const project = await mediaWidget(t, {
    schemaVersion: 1,
    id: "clip",
    name: "Clip",
    fieldData: {image: "sws-sample:clips/neon-road.webm", gallery: ["sws-sample:avatars/pixel-1.png"]},
    background: {id: "road", image: "sws-sample:clips/neon-road.webm"}
  });
  project.recipes.push({id: "matrix", filePath: "", value: {schemaVersion: 1, id: "matrix", name: "Matrix", scenes: ["clip"], matrix: {backgrounds: [{id: "road", image: "sws-sample:clips/neon-road.webm"}, {id: "pixel", image: "sws-sample:avatars/pixel-2.png"}]}}});
  const kinds = (await validateProject(project)).filter((item) => item.code === "SAMPLE_MEDIA_KIND");
  assert.deepEqual(kinds.map((item) => item.status), ["error", "warning"]);
  assert.equal(kinds[0].detail, 'Video clips cannot be stage backgrounds: scene "clip" uses sws-sample:clips/neon-road.webm; recipe "matrix" uses sws-sample:clips/neon-road.webm.');
  assert.equal(kinds[1].detail, 'Sample media of the wrong kind for its field: scene "clip" sets image-input field "image" to the clip sample sws-sample:clips/neon-road.webm.');

  const fine = await mediaWidget(t, {schemaVersion: 1, id: "ok", name: "Ok", fieldData: {image: "sws-sample:avatars/pixel-3.png"}, background: {id: "a", image: "sws-sample:backdrops/aero.jpg"}});
  assert.equal((await validateProject(fine)).some((item) => item.code === "SAMPLE_MEDIA_KIND"), false);
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
  assert.equal(opacityIssue({id: "plants", image: "sws-sample:backdrops/plants.jpg"}), false);
  assert.equal(opacityIssue({id: "clear", color: "transparent"}), true);
});

test("the tutorial editor replica shows sample file names, never the internal scheme", () => {
  const fields = [{id: "image", label: "Image", type: "image-input", value: "", group: "Media", options: [], definition: {}, editable: true}];
  const timeline = compileTutorial({
    tutorial: {steps: [{action: "setField", field: "image", value: "sws-sample:gallery/streamer-1-blur.jpg"}]},
    fields,
    fieldData: {image: "sws-sample:gallery/streamer-2.jpg"},
    channel: "synthetic"
  });
  // The replica keeps the reference as the value and shows it through `media`: a file name and the sample to preview.
  const shown = [
    timeline.initialValues.image,
    ...timeline.patches.flatMap(({patch}) => [patch.fieldValue?.value, ...(patch.assetDialog?.tiles ?? [])])
  ].filter((value) => typeof value === "string" && value !== "");
  assert.ok(shown.includes("sws-sample:gallery/streamer-1-blur.jpg"));
  for (const value of shown) {
    assert.ok(timeline.media[value], `the replica knows how to show ${value}`);
    assert.equal(timeline.media[value].name.includes("sws-sample:"), false, timeline.media[value].name);
  }
  assert.deepEqual(timeline.media["sws-sample:gallery/streamer-2.jpg"], {name: "streamer-2.jpg", sample: "gallery/streamer-2.jpg"});
  assert.deepEqual(timeline.media["sws-sample:gallery/streamer-1-blur.jpg"], {name: "streamer-1-blur.jpg", sample: "gallery/streamer-1-blur.jpg"});
  assert.ok(timeline.widget.some((action) => action.fieldData?.image === "sws-sample:gallery/streamer-1-blur.jpg"));
});

test("render provenance hashes the sample bytes used by catalogs and leaves sample-free digests alone", async (t) => {
  const {captureInputSnapshot} = await import("../../dist/capture/renderer.js");
  const recipe = {schemaVersion: 1, id: "listing", name: "Listing", scenes: ["sample"], outputs: {screenshots: true}};
  const withSample = await mediaWidget(t, {schemaVersion: 1, id: "sample", name: "Sample", background: {id: "blueprint", image: "sws-sample:backdrops/blueprint.jpg"}});
  const first = await captureInputSnapshot(withSample, recipe);
  assert.deepEqual(first.sampleMediaHashes, {"sws-sample:backdrops/blueprint.jpg": lock["sws-sample:backdrops/blueprint.jpg"]});
  withSample.scenes[0].value.background.image = "sws-sample:backdrops/patterns.jpg";
  const second = await captureInputSnapshot(withSample, recipe);
  assert.notEqual(second.digest, first.digest);
  assert.deepEqual(Object.keys(second.sampleMediaHashes), ["sws-sample:backdrops/patterns.jpg"]);

  const matrixRecipe = {...recipe, matrix: {backgrounds: [{id: "plants", image: "sws-sample:backdrops/plants.jpg"}]}};
  assert.ok("sws-sample:backdrops/plants.jpg" in (await captureInputSnapshot(withSample, matrixRecipe)).sampleMediaHashes);

  const plain = await mediaWidget(t, {schemaVersion: 1, id: "sample", name: "Sample"});
  const {hashJson} = await import("../../dist/capture/hash.js");
  const snapshot = await captureInputSnapshot(plain, recipe);
  assert.deepEqual(snapshot.sampleMediaHashes, {});
  assert.equal(snapshot.digest, hashJson({inputHashes: snapshot.inputHashes, sourceHashes: snapshot.sourceHashes, assetHashes: snapshot.assetHashes}));
});
