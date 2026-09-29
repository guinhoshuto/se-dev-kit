import assert from "node:assert/strict";
import {mkdir, mkdtemp, readFile, realpath, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import test from "node:test";

import {SAMPLE_MEDIA_ORIGINALS, hostedCatalogFromConfig} from "../../dist/config/hosted-catalog.js";

const SAMPLES = new URL("../../sample-media/", import.meta.url);
const sampleBytes = (file) => readFile(new URL(file, SAMPLES));

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAEElEQVR4nGM4YVMBQQxwFgBbBAjpVFBn5QAAAABJRU5ErkJggg==", "base64");

const CONFIG = `export default {
  schemaVersion: 1,
  widget: {
    root: ".",
    files: {html: "index.html", css: "style.css", js: "script.js", fields: "fields.json"},
    assets: ["studio/media/**/*"],
    viewport: {width: 640, height: 360},
    ready: {selector: "#stage", timeoutMs: 4000}
  },
  channel: {username: "studio_channel"},
  themes: {glob: "{themes,studio/themes}/*.json"},
  scenes: {glob: "studio/scenes/*.json"},
  scenarios: {glob: "studio/scenarios/*.json"},
  recipes: {glob: "studio/recipes/*.json"},
  output: {root: "thumb-assets"}
};
`;

/** A small widget shaped like se-windows: its Studio catalog and media live under studio/. */
async function widget(t, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), "sws-hosted-catalog-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const files = {
    "index.html": '<main id="stage"></main>\n',
    "style.css": "body{margin:0}\n",
    "script.js": "window.ready = true;\n",
    "fields.json": JSON.stringify({gallery: {type: "image-input", multiple: true, value: []}, image: {type: "image-input", value: ""}}),
    "se-widget-studio.config.mjs": CONFIG,
    // A production theme preset: plain field data, wrapped with an id from its file name.
    "themes/01-signal.json": JSON.stringify({accent: "#ff3366"}),
    "studio/themes/aurora.json": JSON.stringify({schemaVersion: 1, id: "aurora", name: "Aurora", fieldData: {accent: "#66ffcc"}}),
    "studio/scenes/gallery.json": JSON.stringify({
      schemaVersion: 1, id: "gallery", name: "Gallery", theme: "01-signal",
      fieldData: {gallery: ["/__sws/widget/studio/media/a.png", "studio/media/b%20c.png", "sws-sample:gallery/neon-city.jpg"], image: "/__sws/widget/studio/media/b%20c.png"},
      background: {id: "backdrop", image: "/__sws/widget/studio/media/a.png"}
    }),
    "studio/scenes/empty.json": JSON.stringify({schemaVersion: 1, id: "empty", name: "Empty", theme: "aurora", fieldData: {gallery: []}}),
    "studio/recipes/stills.json": JSON.stringify({schemaVersion: 1, id: "stills", name: "Stills", scenes: ["gallery"], outputs: {screenshots: true}}),
    "studio/recipes/clip.json": JSON.stringify({schemaVersion: 1, id: "clip", name: "Clip", scenes: ["empty"], matrix: {themes: ["*"]}, outputs: {screenshots: false, video: {enabled: true, durationMs: 1000, fps: 10, keepFrames: true}}}),
    "studio/scenarios/smoke.json": JSON.stringify({schemaVersion: 1, id: "smoke", name: "Smoke", steps: [{action: "wait", ms: 10}]}),
    "studio/media/a.png": PNG,
    "studio/media/b c.png": PNG,
    ...extra
  };
  for (const [path, body] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), {recursive: true});
    await writeFile(join(root, path), body);
  }
  return join(root, "se-widget-studio.config.mjs");
}

const ids = (items) => items.map((item) => item.id).sort();

test("a local config flattens into the catalog a hosted import takes, with widget files as uploads under their widget path", async (t) => {
  const config = await widget(t);
  const {widgetRoot, files, catalog} = await hostedCatalogFromConfig(config);
  assert.equal(widgetRoot, await realpath(dirname(config)));
  assert.deepEqual(files, {html: "index.html", css: "style.css", js: "script.js", fields: "fields.json"});
  assert.deepEqual(catalog.widget, {viewport: {width: 640, height: 360}, ready: {selector: "#stage", timeoutMs: 4000}});
  assert.deepEqual(catalog.channel, {username: "studio_channel"});
  assert.deepEqual(ids(catalog.themes), ["01-signal", "aurora"]);
  assert.deepEqual(catalog.themes.find((theme) => theme.id === "01-signal"), {schemaVersion: 1, id: "01-signal", name: "01 Signal", fieldData: {accent: "#ff3366"}});
  assert.deepEqual(ids(catalog.scenarios), ["smoke"]);
  assert.deepEqual(ids(catalog.recipes), ["clip", "stills"]);

  const gallery = catalog.scenes.find((scene) => scene.id === "gallery");
  assert.deepEqual(gallery.fieldData, {gallery: ["studio/media/a.png", "studio/media/b%20c.png", "sws-sample:gallery/neon-city.jpg"], image: "studio/media/b c.png"}, "only whole /__sws/widget/ values change, and they are decoded");
  assert.equal(gallery.background.image, "studio/media/a.png");
  const clip = catalog.recipes.find((recipe) => recipe.id === "clip");
  assert.deepEqual(clip.outputs.video, {enabled: true, durationMs: 1000, fps: 10}, "keepFrames is dropped");
  assert.deepEqual(clip.matrix.themes, catalog.themes.map((theme) => theme.id), "the local \"*\" becomes every theme ID, in catalog order");

  // The production sources and the config are not uploads; the files the local Studio serves are.
  assert.deepEqual(catalog.assets, [
    {path: "studio/media/a.png", file: "studio/media/a.png", contentType: "image/png"},
    {path: "studio/media/b c.png", file: "studio/media/b c.png", contentType: "image/png"}
  ]);
});

test("widget.fieldUpdate reaches the catalog, and a value other than reload or event is refused", async (t) => {
  const withMode = (mode) => ({"se-widget-studio.config.mjs": CONFIG.replace('timeoutMs: 4000}', `timeoutMs: 4000},\n    fieldUpdate: "${mode}"`)});
  const {catalog} = await hostedCatalogFromConfig(await widget(t, withMode("event")));
  assert.deepEqual(catalog.widget, {viewport: {width: 640, height: 360}, ready: {selector: "#stage", timeoutMs: 4000}, fieldUpdate: "event"});
  await assert.rejects(hostedCatalogFromConfig(await widget(t, withMode("sometimes"))), (error) => {
    assert.equal(error.code, "INVALID_CONFIG");
    assert.match(error.message, /widget\.fieldUpdate: Invalid enum value\. Expected 'reload' \| 'event', received 'sometimes'/);
    return true;
  });
});

test("--recipes keeps those recipes with the scenes, themes, and fixtures they use, and leaves scenarios out", async (t) => {
  const config = await widget(t);
  const {catalog} = await hostedCatalogFromConfig(config, {recipes: ["stills"]});
  assert.deepEqual(ids(catalog.recipes), ["stills"]);
  assert.deepEqual(ids(catalog.scenes), ["gallery"]);
  assert.deepEqual(ids(catalog.themes), ["01-signal"]);
  assert.deepEqual(catalog.fixtures, []);
  assert.deepEqual(catalog.scenarios, []);
  assert.equal(catalog.assets.length, 2, "every widget file stays: later recipe groups reuse the uploads");
  const clip = await hostedCatalogFromConfig(config, {recipes: ["clip"]});
  assert.deepEqual(ids(clip.catalog.scenes), ["empty"]);
  assert.deepEqual(ids(clip.catalog.themes), ["01-signal", "aurora"], "a \"*\" matrix keeps every theme");
  await assert.rejects(hostedCatalogFromConfig(config, {recipes: ["stills", "missing"]}), {code: "RECIPE_NOT_FOUND", message: "Recipe not found: missing"});
});

test("what a hosted revision cannot hold fails before anything is uploaded", async (t) => {
  const withHtml = await widget(t, {"studio/media/preview.html": "<p>dev page</p>"});
  await assert.rejects(hostedCatalogFromConfig(withHtml), {code: "HOSTED_ASSET_UNSUPPORTED", message: /cannot hold HTML files, and the local Studio serves studio\/media\/preview\.html/});

  const adapter = await widget(t, {"adapter.mjs": "export default {};\n"});
  await writeFile(adapter, CONFIG.replace('ready: {selector: "#stage", timeoutMs: 4000}', 'ready: {selector: "#stage", timeoutMs: 4000},\n    adapter: "adapter.mjs"'));
  await assert.rejects(hostedCatalogFromConfig(adapter), {code: "HOSTED_ADAPTER_UNSUPPORTED"});

  const custom = await widget(t, {"src/widget.html": "<main></main>\n"});
  await writeFile(custom, CONFIG.replace('html: "index.html"', 'html: "src/widget.html"'));
  await assert.rejects(hostedCatalogFromConfig(custom), {code: "HOSTED_LAYOUT_UNSUPPORTED", message: /this widget uses src\/widget\.html, style\.css, script\.js, fields\.json/});
});

test("a widget image that copies a built-in sample becomes its sws-sample: reference instead of an upload", async (t) => {
  const config = await widget(t, {
    // A copy that the widget's own HTML loads must stay an upload at its path.
    "index.html": '<main id="stage"><img src="studio/media/logo.jpg"></main>\n',
    "studio/media/logo.jpg": await sampleBytes("gallery/ocean-moon.jpg"),
    "studio/media/gallery/06-pixel-forest.jpg": await sampleBytes("gallery/pixel-forest.jpg"),
    "studio/media/backdrops/bd-sunset-mesh.jpg": await sampleBytes("backdrops/sunset-mesh.jpg"),
    "studio/scenes/samples.json": JSON.stringify({
      schemaVersion: 1, id: "samples", name: "Samples", theme: "aurora",
      fieldData: {gallery: ["studio/media/gallery/06-pixel-forest.jpg", "/__sws/widget/studio/media/gallery/06-pixel-forest.jpg", "studio/media/a.png"], image: "studio/media/logo.jpg"},
      background: {id: "sunset", image: "studio/media/backdrops/bd-sunset-mesh.jpg"}
    }),
    "studio/recipes/backdrops.json": JSON.stringify({
      schemaVersion: 1, id: "backdrops", name: "Backdrops", scenes: ["samples"],
      matrix: {backgrounds: [{id: "sunset", image: "/__sws/widget/studio/media/backdrops/bd-sunset-mesh.jpg"}]}, outputs: {screenshots: true}
    })
  });
  const {catalog, samples} = await hostedCatalogFromConfig(config);
  assert.deepEqual(samples, [
    {path: "studio/media/backdrops/bd-sunset-mesh.jpg", reference: "sws-sample:backdrops/sunset-mesh.jpg", identical: true},
    {path: "studio/media/gallery/06-pixel-forest.jpg", reference: "sws-sample:gallery/pixel-forest.jpg", identical: true}
  ]);
  const scene = catalog.scenes.find((item) => item.id === "samples");
  assert.deepEqual(scene.fieldData, {
    gallery: ["sws-sample:gallery/pixel-forest.jpg", "sws-sample:gallery/pixel-forest.jpg", "studio/media/a.png"],
    image: "studio/media/logo.jpg"
  }, "every whole value naming a copy names the sample, in either path form");
  assert.equal(scene.background.image, "sws-sample:backdrops/sunset-mesh.jpg");
  assert.equal(catalog.recipes.find((item) => item.id === "backdrops").matrix.backgrounds[0].image, "sws-sample:backdrops/sunset-mesh.jpg");
  assert.deepEqual(catalog.assets.map((asset) => asset.path), ["studio/media/a.png", "studio/media/b c.png", "studio/media/logo.jpg"], "no sample copy is uploaded, except the one the widget source loads");
});

test("the originals that sample-media/ was recompressed from stand for every sample whose bytes changed", async () => {
  const manifest = JSON.parse(await readFile(new URL("manifest.json", SAMPLES), "utf8"));
  const originals = Object.entries(SAMPLE_MEDIA_ORIGINALS);
  // 14 samples, and gallery/pixel-forest.jpg kept its original bytes (sample-media/README.md).
  assert.equal(originals.length, 13);
  const recompressed = manifest.items.map((item) => item.reference).filter((reference) => reference !== "sws-sample:gallery/pixel-forest.jpg").sort();
  assert.deepEqual(originals.map(([, reference]) => reference).sort(), recompressed, "one original per recompressed sample");
  for (const [sha256, reference] of originals) {
    assert.match(sha256, /^[a-f0-9]{64}$/);
    assert.ok(!manifest.items.some((item) => item.sha256 === sha256), `${reference}: an original is not the sample's own bytes`);
  }
});
