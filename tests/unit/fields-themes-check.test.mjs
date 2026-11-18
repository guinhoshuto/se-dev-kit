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
    ["ok", "2 shipped themes set every FIELDS key outside themes.keepDefault and no other, each to a value its field takes, in plain ASCII."]
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

const statusAndDetail = (diagnostics, code) => withCode(diagnostics, code).map((item) => [item.status, item.detail]);

/** One field of each type a theme can set, plus a button, which it cannot. */
const ALL_TYPES = {
  size: {type: "slider", label: "Size", value: 1, min: 1, max: 9, step: 2},
  fade: {type: "slider", label: "Fade", value: 0, min: 0, max: 1, step: 0.1},
  count: {type: "number", label: "Count", value: 0, min: 0, max: 10, step: 5},
  free: {type: "number", label: "Free", value: 0},
  align: {type: "dropdown", label: "Align", value: "left", options: {left: "Left", center: "Center"}},
  accent: {type: "colorpicker", label: "Accent", value: "#ffffff"},
  shade: {type: "colorpicker", label: "Shade", value: "#000000"},
  extra: {type: "checkbox", label: "Extra", value: false},
  font: {type: "googleFont", label: "Font", value: "Roboto"},
  title: {type: "text", label: "Title", value: "Wheel"},
  logo: {type: "image-input", label: "Logo", value: ""},
  gallery: {type: "image-input", label: "Gallery", value: [], multiple: true},
  intro: {type: "video-input", label: "Intro", value: ""},
  chime: {type: "sound-input", label: "Chime", value: ""},
  state: {type: "hidden", label: "State", value: {}},
  spin: button("Spin now")
};

const VALID_THEME = {
  size: 5,
  fade: 0.5,
  count: 5,
  free: 2.5,
  align: "left",
  accent: "#ff7518",
  shade: "#000000",
  extra: true,
  font: "Roboto",
  title: "Wheel",
  logo: "",
  gallery: [],
  intro: "",
  chime: "",
  state: {}
};

const THEME_CODES = [
  "SHIPPED_THEME_INVALID",
  "THEME_NOT_ASCII",
  "THEME_FIELDS_MISSING",
  "THEME_FIELDS_EXTRA",
  "THEME_VALUE_NOT_NUMBER",
  "THEME_VALUE_OUT_OF_RANGE",
  "THEME_VALUE_OFF_STEP",
  "THEME_VALUE_NOT_OPTION",
  "THEME_VALUE_NOT_COLOR",
  "THEME_VALUE_NOT_BOOLEAN",
  "THEME_VALUE_NO_FONT",
  "THEME_VALUE_NOT_STRING",
  "THEME_VALUE_UNCHECKED"
];

test("shipped themes with a valid value for every field type, at their limits, report no theme error", async (t) => {
  const root = await temporaryDirectory(t, "sws-theme-values-ok-");
  await writeWidget(root, ALL_TYPES, {
    "themes/low.json": {
      ...VALID_THEME,
      size: 1,
      fade: 0,
      count: 0,
      free: -1000,
      accent: "#FF7518",
      shade: "rgba(0, 0, 0, 0.5)",
      gallery: [],
      state: {mode: "spin", slices: [1, 2]}
    },
    "themes/high.json": {
      ...VALID_THEME,
      size: 9,
      fade: 1,
      count: 10,
      free: 1e6,
      align: "center",
      accent: "#fff",
      shade: "#0000",
      extra: false,
      font: "Open Sans",
      title: "",
      gallery: ["", "gallery-1.png"],
      state: "kept"
    },
    // Floating point: 0.3 / 0.1 and 0.7 / 0.1 are a hair off a whole number of steps.
    "themes/mid.json": {...VALID_THEME, size: 3, fade: 0.3, count: 3, accent: "#ff7518aa", shade: "rgb(255, 255, 255)"},
    "themes/late.json": {...VALID_THEME, size: 7, fade: 0.7, state: null}
  });

  const diagnostics = await diagnosticsFor(root);

  assert.deepEqual(THEME_CODES.flatMap((code) => statusAndDetail(diagnostics, code)), []);
  assert.deepEqual(statusAndDetail(diagnostics, "SHIPPED_THEMES"), [
    ["ok", "4 shipped themes set every FIELDS key and no other, each to a value its field takes, in plain ASCII."]
  ]);
  assert.equal(hasValidationErrors(diagnostics), false, JSON.stringify(diagnostics.filter((item) => item.status === "error")));
});

test("a shipped theme key that no FIELDS value has, or a button's, is an error; a themes.keepDefault key is not", async (t) => {
  const root = await temporaryDirectory(t, "sws-theme-extra-");
  await writeWidget(root, FIELDS, {
    [CONFIG_FILE_NAME]: `export default {schemaVersion: 1, widget: {root: "."}, themes: {glob: "themes/*.json", keepDefault: ["extra"]}};\n`,
    "themes/moved.json": {accent: "#ff7518", title: "Moved", centerX: 0.5},
    "themes/pressed.json": {accent: "#ff7518", title: "Pressed", spin: "press", glow: 2},
    "themes/kept.json": {accent: "#ff7518", title: "Kept", extra: true}
  });

  const diagnostics = await diagnosticsFor(root);

  assert.deepEqual(statusAndDetail(diagnostics, "THEME_FIELDS_EXTRA"), [
    ["error", "Shipped theme themes/moved.json sets 1 key that no FIELDS value has: centerX."],
    ["error", "Shipped theme themes/pressed.json sets 2 keys that no FIELDS value has: spin, glow."]
  ]);
  assert.deepEqual(withCode(diagnostics, "THEME_FIELDS_EXTRA").map((item) => item.hint), [
    "Remove each one, or rename it to the FIELDS key that replaced it; a button field takes no value.",
    "Remove each one, or rename it to the FIELDS key that replaced it; a button field takes no value."
  ]);
  assert.deepEqual(statusAndDetail(diagnostics, "THEME_VALUE_UNCHECKED"), [], "a button's key is extra, not a value to check");
  assert.deepEqual(statusAndDetail(diagnostics, "THEME_FIELDS_MISSING"), []);
});

test("a slider or number value that is not a JSON number is an error", async (t) => {
  const root = await temporaryDirectory(t, "sws-theme-not-number-");
  await writeWidget(root, ALL_TYPES, {"themes/a.json": {...VALID_THEME, size: "5", free: null, count: true}});

  const diagnostics = await diagnosticsFor(root);

  assert.deepEqual(statusAndDetail(diagnostics, "THEME_VALUE_NOT_NUMBER"), [
    ["error", 'Shipped theme themes/a.json sets 3 values that are not a number: size = "5", count = true, free = null.']
  ]);
  assert.deepEqual(withCode(diagnostics, "THEME_VALUE_NOT_NUMBER").map((item) => item.hint), [
    "Give each slider and number field a JSON number, without quotes."
  ]);
});

test("a value outside its field's min or max is an error, and only that, also when it is off the step", async (t) => {
  const root = await temporaryDirectory(t, "sws-theme-range-");
  await writeWidget(root, ALL_TYPES, {
    // -1 is a whole number of steps below the slider's min of 1.
    "themes/low.json": {...VALID_THEME, size: -1, count: -1},
    // 10 is past the max and off the step; 1.5 is ten steps past the max of 1.
    "themes/high.json": {...VALID_THEME, size: 10, fade: 1.5, count: 11}
  });

  const diagnostics = await diagnosticsFor(root);

  assert.deepEqual(statusAndDetail(diagnostics, "THEME_VALUE_OUT_OF_RANGE"), [
    ["error", "Shipped theme themes/high.json sets 3 values that are outside its field's min and max: size = 10 (max 9), fade = 1.5 (max 1), count = 11 (max 10)."],
    ["error", "Shipped theme themes/low.json sets 2 values that are outside its field's min and max: size = -1 (min 1), count = -1 (min 0)."]
  ]);
  assert.deepEqual(statusAndDetail(diagnostics, "THEME_VALUE_OFF_STEP"), [], "a value reports one problem, the first");
});

test("a slider value off its step, counted from its min, is an error", async (t) => {
  const root = await temporaryDirectory(t, "sws-theme-step-");
  await writeWidget(root, ALL_TYPES, {"themes/a.json": {...VALID_THEME, size: 4, fade: 0.25}});

  const diagnostics = await diagnosticsFor(root);

  assert.deepEqual(statusAndDetail(diagnostics, "THEME_VALUE_OFF_STEP"), [
    ["error", "Shipped theme themes/a.json sets 2 values that are off its slider's step: size = 4 (step 2 from 1), fade = 0.25 (step 0.1 from 0)."]
  ]);
  assert.deepEqual(withCode(diagnostics, "THEME_VALUE_OFF_STEP").map((item) => item.hint), [
    "Give each slider a value its handle can reach: its min plus a whole number of steps."
  ]);
});

test("a dropdown value that is an option's label, not its key, is an error", async (t) => {
  const root = await temporaryDirectory(t, "sws-theme-option-");
  await writeWidget(root, ALL_TYPES, {"themes/a.json": {...VALID_THEME, align: "Center"}});

  const diagnostics = await diagnosticsFor(root);

  assert.deepEqual(statusAndDetail(diagnostics, "THEME_VALUE_NOT_OPTION"), [
    ["error", 'Shipped theme themes/a.json sets 1 value that is not among its dropdown\'s options: align = "Center".']
  ]);
});

test("a color the colorpicker does not take, such as a color name, is an error", async (t) => {
  const root = await temporaryDirectory(t, "sws-theme-color-");
  await writeWidget(root, ALL_TYPES, {
    "themes/a.json": {...VALID_THEME, accent: "red", shade: "#ff751"},
    "themes/b.json": {...VALID_THEME, accent: "rgba(300, 0, 0, 1)", shade: 16777215}
  });

  const diagnostics = await diagnosticsFor(root);

  assert.deepEqual(statusAndDetail(diagnostics, "THEME_VALUE_NOT_COLOR"), [
    ["error", 'Shipped theme themes/a.json sets 2 values that are not a color the colorpicker takes: accent = "red", shade = "#ff751".'],
    ["error", 'Shipped theme themes/b.json sets 2 values that are not a color the colorpicker takes: accent = "rgba(300, 0, 0, 1)", shade = 16777215.']
  ]);
});

test("a checkbox value that is not true or false, such as a quoted one, is an error", async (t) => {
  const root = await temporaryDirectory(t, "sws-theme-boolean-");
  await writeWidget(root, ALL_TYPES, {"themes/a.json": {...VALID_THEME, extra: "true"}});

  const diagnostics = await diagnosticsFor(root);

  assert.deepEqual(statusAndDetail(diagnostics, "THEME_VALUE_NOT_BOOLEAN"), [
    ["error", 'Shipped theme themes/a.json sets 1 value that is neither true nor false: extra = "true".']
  ]);
});

test("a font value that is blank or not a string is an error", async (t) => {
  const root = await temporaryDirectory(t, "sws-theme-font-");
  await writeWidget(root, ALL_TYPES, {
    "themes/blank.json": {...VALID_THEME, font: "  "},
    "themes/none.json": {...VALID_THEME, font: null}
  });

  const diagnostics = await diagnosticsFor(root);

  assert.deepEqual(statusAndDetail(diagnostics, "THEME_VALUE_NO_FONT"), [
    ["error", 'Shipped theme themes/blank.json sets 1 value that is not a font name: font = "  ".'],
    ["error", "Shipped theme themes/none.json sets 1 value that is not a font name: font = null."]
  ]);
});

test("a text or media value that is not a string is an error; a multiple media field takes a list of strings", async (t) => {
  const root = await temporaryDirectory(t, "sws-theme-string-");
  await writeWidget(root, ALL_TYPES, {
    "themes/a.json": {...VALID_THEME, title: 7, logo: null, gallery: ["", 1]},
    "themes/b.json": {...VALID_THEME, gallery: "", intro: 3}
  });

  const diagnostics = await diagnosticsFor(root);

  assert.deepEqual(statusAndDetail(diagnostics, "THEME_VALUE_NOT_STRING"), [
    ["error", 'Shipped theme themes/a.json sets 3 values that are not a string: title = 7, logo = null, gallery = ["",1] (multiple: a list of strings).'],
    ["error", 'Shipped theme themes/b.json sets 2 values that are not a string: gallery = "" (multiple: a list of strings), intro = 3.']
  ]);
});

test("a value for a field type without a rule is an error that names the type; a hidden field takes any value", async (t) => {
  const root = await temporaryDirectory(t, "sws-theme-unchecked-");
  await writeWidget(root, {
    mode: {type: "toggle", label: "Mode", value: false},
    state: {type: "hidden", label: "State", value: {}}
  }, {"themes/a.json": {mode: true, state: [1, {slice: "a"}]}});

  const diagnostics = await diagnosticsFor(root);

  assert.deepEqual(statusAndDetail(diagnostics, "THEME_VALUE_UNCHECKED"), [
    ["error", "Shipped theme themes/a.json sets 1 value that is unchecked, as validate has no rule for its field type: mode = true (type toggle)."]
  ]);
});

test("a shipped theme with a character outside ASCII is an error that counts characters and shows the first one's escape", async (t) => {
  const root = await temporaryDirectory(t, "sws-theme-ascii-");
  await writeWidget(root, FIELDS, {
    "themes/gift.json": '{\n  "accent": "#ff7518",\n  "title": "Gift 🎁 café",\n  "extra": true\n}\n',
    "themes/cafe.json": {accent: "#ff7518", title: "Café", extra: false},
    "themes/escaped.json": '{"accent": "#ff7518", "title": "Gift \\ud83c\\udf81 caf\\u00e9", "extra": true}\n'
  });

  const diagnostics = await diagnosticsFor(root);

  assert.deepEqual(withCode(diagnostics, "THEME_NOT_ASCII").map((item) => [item.status, item.detail, item.hint]), [
    [
      "error",
      "Shipped theme themes/cafe.json has 1 character outside ASCII, the first on line 3: é.",
      "Write each one as a JSON escape (this one as \\u00e9), so that no text editor can change it on the way to the DATA tab."
    ],
    [
      "error",
      "Shipped theme themes/gift.json has 2 characters outside ASCII, the first on line 3: 🎁.",
      "Write each one as a JSON escape (this one as \\ud83c\\udf81), so that no text editor can change it on the way to the DATA tab."
    ]
  ]);
  assert.deepEqual(statusAndDetail(diagnostics, "THEME_FIELDS_MISSING"), []);
});

test("validate exits 1 on a theme with a key FIELDS renamed and a theme with a slider off its step", {timeout: 60_000}, async (t) => {
  const root = await temporaryDirectory(t, "sws-issue-41-");
  const fields = {
    accent: {type: "colorpicker", label: "Accent", value: "#ffffff"},
    centerOffsetX: {type: "slider", label: "Center offset", value: 0, min: -50, max: 50, step: 5}
  };
  await writeWidget(root, fields, {
    "themes/renamed.json": {accent: "#ff7518", centerOffsetX: 0, centerX: 10},
    "themes/stepped.json": {accent: "#ff7518", centerOffsetX: 12}
  });
  const cliPath = fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url));

  const result = await execFileAsync(process.execPath, [cliPath, "validate", root, "--json"]).then(
    () => ({code: 0}),
    (error) => ({code: error.code, stdout: error.stdout})
  );

  assert.equal(result.code, 1);
  const {diagnostics} = JSON.parse(result.stdout);
  assert.deepEqual(statusAndDetail(diagnostics, "THEME_FIELDS_EXTRA"), [
    ["error", "Shipped theme themes/renamed.json sets 1 key that no FIELDS value has: centerX."]
  ]);
  assert.deepEqual(statusAndDetail(diagnostics, "THEME_VALUE_OFF_STEP"), [
    ["error", "Shipped theme themes/stepped.json sets 1 value that is off its slider's step: centerOffsetX = 12 (step 5 from -50)."]
  ]);
  assert.deepEqual(statusAndDetail(diagnostics, "THEME_FIELDS_MISSING"), []);
});
