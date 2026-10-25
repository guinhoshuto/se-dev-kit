import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import test from "node:test";

import {CONFIG_FILE_NAME, loadProject} from "../../dist/config/load.js";
import {hasValidationErrors, validateProject} from "../../dist/validation/project.js";

const execFileAsync = promisify(execFile);

async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, {recursive: true, force: true}));
  return directory;
}

/** Writes an index-layout widget with these FIELDS, then each extra file (a JSON value or a source string). */
async function writeWidget(root, fields, files = {}) {
  const contents = {
    "index.html": '<main id="widget">Widget</main>\n',
    "style.css": "#widget { color: white; }\n",
    "script.js": "window.__widgetLoaded = true;\n",
    "fields.json": fields,
    ...files
  };
  for (const [name, value] of Object.entries(contents)) {
    await mkdir(dirname(join(root, name)), {recursive: true});
    await writeFile(join(root, name), typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
  }
}

async function diagnosticsFor(root) {
  return validateProject(await loadProject({inputDirectory: root}));
}

const withCode = (diagnostics, code) => diagnostics.filter((item) => item.code === code);

const button = (label) => ({type: "button", label, value: "press"});

test("a button label over 24 characters is a validation error, counted as a reader counts characters", async (t) => {
  const root = await temporaryDirectory(t, "sws-button-label-");
  await writeWidget(root, {
    exact: button("x".repeat(24)),
    // 24 characters: the wheel is one character and two UTF-16 units.
    wheel: button(`🎡${"x".repeat(23)}`),
    // 24 characters: the family is one character of five code points.
    family: button(`👨‍👩‍👧${"x".repeat(23)}`),
    // 21 characters, as in the custom wheel; the recycle sign carries a variation selector.
    reset: button("♻️ Reset merged slices"),
    over: button("x".repeat(25)),
    note: {type: "text", label: "A text label past 24 characters", value: ""}
  });

  const diagnostics = await diagnosticsFor(root);
  const long = withCode(diagnostics, "FIELD_BUTTON_LABEL_LONG");

  assert.equal(long.length, 1, JSON.stringify(long));
  assert.equal(long[0].status, "error");
  assert.match(long[0].detail, /^Button field "over" has a 25-character label;/);
  assert.equal(hasValidationErrors(diagnostics), true);
  assert.deepEqual(withCode(diagnostics, "SHIPPED_THEMES"), [], "a widget without themes reports none");
});

test("a number or text label over 36 characters warns that the editor cuts it; other types never do", async (t) => {
  const root = await temporaryDirectory(t, "sws-line-label-");
  await writeWidget(root, {
    fits: {type: "number", label: "x".repeat(36), value: 1},
    count: {type: "number", label: "x".repeat(40), value: 1},
    // 36 characters: the wheel is one character and two UTF-16 units.
    caption: {type: "text", label: `🎡${"x".repeat(35)}`, value: ""},
    title: {type: "text", label: "x".repeat(37), value: ""},
    accent: {type: "colorpicker", label: "x".repeat(40), value: "#ffffff"}
  });

  const diagnostics = await diagnosticsFor(root);

  assert.deepEqual(
    withCode(diagnostics, "FIELD_LABEL_TRUNCATED").map((item) => [item.status, item.detail.split(";")[0]]),
    [
      ["warning", 'The number field "count" has a 40-character label'],
      ["warning", 'The text field "title" has a 37-character label']
    ]
  );
  assert.equal(hasValidationErrors(diagnostics), false);
});

const FIELDS = {
  accent: {type: "colorpicker", label: "Accent", value: "#ffffff"},
  title: {type: "text", label: "Title", value: "Wheel"},
  extra: {type: "checkbox", label: "Extra", value: false},
  spin: button("Spin now")
};

test("a shipped theme without a FIELDS key fails validation; buttons never count", async (t) => {
  const root = await temporaryDirectory(t, "sws-shipped-themes-");
  await writeWidget(root, FIELDS, {
    "themes/full.json": {accent: "#ff7518", title: "Doom", extra: true},
    "themes/old.json": {accent: "#ff7518", title: "Doom"},
    "themes/whole.json": {schemaVersion: 1, id: "whole", name: "Whole", fieldData: {accent: "#000000", title: "Whole"}},
    "themes/nested/deep.json": {accent: "#000000"},
    "data.json": {accent: "#ffffff", extra: false}
  });

  const missing = withCode(await diagnosticsFor(root), "THEME_FIELDS_MISSING");

  assert.deepEqual(
    missing.map((item) => [item.status, item.detail]),
    [
      ["error", "Shipped theme data.json does not set 1 FIELDS key: title."],
      ["error", "Shipped theme themes/nested/deep.json does not set 2 FIELDS keys: title, extra."],
      ["error", "Shipped theme themes/old.json does not set 1 FIELDS key: extra."],
      ["error", "Shipped theme themes/whole.json does not set 1 FIELDS key: extra."]
    ]
  );
});

test("the theme glob does not decide what ships: a widget without a configuration is checked too", async (t) => {
  const root = await temporaryDirectory(t, "sws-shipped-no-config-");
  await writeWidget(root, FIELDS, {"themes/old.json": {accent: "#ff7518", title: "Doom"}});

  const diagnostics = await diagnosticsFor(root);

  assert.deepEqual(withCode(diagnostics, "THEME_FIELDS_MISSING").map((item) => item.detail), [
    "Shipped theme themes/old.json does not set 1 FIELDS key: extra."
  ]);
});

test("a .data.json payload ships in place of the Studio theme beside it, and must set every key", async (t) => {
  const root = await temporaryDirectory(t, "sws-shipped-pair-");
  await writeWidget(root, FIELDS, {
    "themes/pair.json": {accent: "#ff7518"},
    "themes/pair.data.json": {accent: "#ff7518", title: "Doom", extra: true},
    "themes/short.json": {accent: "#ff7518"},
    "themes/short.data.json": {accent: "#ff7518", title: "Doom"}
  });

  const missing = withCode(await diagnosticsFor(root), "THEME_FIELDS_MISSING");

  assert.deepEqual(missing.map((item) => item.detail), ["Shipped theme themes/short.data.json does not set 1 FIELDS key: extra."]);
});

test("themes.keepDefault lets listed keys stay out, and a Studio-only theme outside themes/ stays partial", async (t) => {
  const root = await temporaryDirectory(t, "sws-shipped-keep-default-");
  await writeWidget(root, FIELDS, {
    [CONFIG_FILE_NAME]: `export default {schemaVersion: 1, widget: {root: "."}, themes: {glob: "{themes,studio/themes}/*.json", keepDefault: ["extra"]}};\n`,
    "themes/old.json": {accent: "#ff7518", title: "Doom"},
    "themes/older.json": {accent: "#ff7518"},
    "studio/themes/marketing.json": {title: "Listing"}
  });

  const project = await loadProject({inputDirectory: root});
  const diagnostics = await validateProject(project);

  assert.deepEqual(project.themes.map((item) => item.id).sort(), ["marketing", "old", "older"]);
  assert.deepEqual(withCode(diagnostics, "THEME_FIELDS_MISSING").map((item) => item.detail), [
    "Shipped theme themes/older.json does not set 1 FIELDS key: title."
  ]);
});

test("shipped themes that set every key report it, and a shipped theme that is not an object is an error", async (t) => {
  const complete = await temporaryDirectory(t, "sws-shipped-ok-");
  await writeWidget(complete, FIELDS, {
    [CONFIG_FILE_NAME]: `export default {schemaVersion: 1, widget: {root: "."}, themes: {glob: "themes/*.json", keepDefault: ["extra"]}};\n`,
    "themes/a.json": {accent: "#ff7518", title: "A"},
    "themes/b.json": {accent: "#ff7518", title: "B", extra: true}
  });
  const ok = await diagnosticsFor(complete);
  assert.deepEqual(withCode(ok, "SHIPPED_THEMES").map((item) => [item.status, item.detail]), [
    ["ok", "2 shipped themes set every FIELDS key outside themes.keepDefault."]
  ]);
  assert.equal(hasValidationErrors(ok), false, JSON.stringify(ok.filter((item) => item.status === "error")));

  const broken = await temporaryDirectory(t, "sws-shipped-array-");
  await writeWidget(broken, FIELDS, {"themes/list.json": ["#ff7518"]});
  const invalid = withCode(await diagnosticsFor(broken), "SHIPPED_THEME_INVALID");
  assert.deepEqual(invalid.map((item) => [item.status, item.detail]), [["error", "Shipped theme themes/list.json is not a JSON object."]]);
});

test("validate exits 1 on the custom wheel's mistakes: a 79-character button and six themes without the new keys", {timeout: 60_000}, async (t) => {
  const root = await temporaryDirectory(t, "sws-wid-10-");
  const fields = {
    accent: {type: "colorpicker", label: "Accent", value: "#ffffff"},
    mergeMatches: {type: "checkbox", label: "Merge matching slices", value: true},
    resetMerges: button("♻️ Reset the merged slices so each prize is drawn alone again from the next spin")
  };
  const themes = Object.fromEntries(
    ["christmas", "classic-casino", "cute-pastel", "halloween", "minimal-dark", "neon-cyber"].map((id) => [`themes/${id}.json`, {accent: "#ff7518"}])
  );
  await writeWidget(root, fields, themes);
  const cliPath = fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url));

  const result = await execFileAsync(process.execPath, [cliPath, "validate", root, "--json"]).then(
    () => ({code: 0}),
    (error) => ({code: error.code, stdout: error.stdout})
  );

  assert.equal(result.code, 1);
  const {diagnostics} = JSON.parse(result.stdout);
  assert.deepEqual(withCode(diagnostics, "FIELD_BUTTON_LABEL_LONG").map((item) => item.detail.split(";")[0]), [
    'Button field "resetMerges" has a 79-character label'
  ]);
  assert.equal(withCode(diagnostics, "THEME_FIELDS_MISSING").length, 6);
});
