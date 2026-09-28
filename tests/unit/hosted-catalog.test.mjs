import assert from "node:assert/strict";
import {mkdir, mkdtemp, realpath, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import test from "node:test";

import {hostedCatalogFromConfig} from "../../dist/config/hosted-catalog.js";

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
