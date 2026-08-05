import assert from "node:assert/strict";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {normalizeFields} from "../../dist/config/fields.js";
import {loadProject} from "../../dist/config/load.js";
import {mergeJsonObjects} from "../../dist/shared/json.js";
import {validateProject} from "../../dist/validation/project.js";
import {assertPublicSafeProject} from "../../dist/validation/privacy.js";

const layouts = [
  {
    name: "widget layout",
    files: {html: "widget.html", css: "widget.css", js: "widget.js", fields: "widget.json"}
  },
  {
    name: "index layout",
    files: {html: "index.html", css: "style.css", js: "script.js", fields: "fields.json"}
  }
];

async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, {recursive: true, force: true}));
  return directory;
}

async function writeLayout(root, files, fields = {title: {type: "text", value: "Hello"}}) {
  await Promise.all([
    writeFile(join(root, files.html), '<main id="widget">Widget</main>\n'),
    writeFile(join(root, files.css), "#widget { color: white; }\n"),
    writeFile(join(root, files.js), "window.__widgetLoaded = true;\n"),
    writeFile(join(root, files.fields), `${JSON.stringify(fields, null, 2)}\n`)
  ]);
}

test("autodetects both supported production layouts", async (t) => {
  for (const layout of layouts) {
    await t.test(layout.name, async (t) => {
      const root = await temporaryDirectory(t, "sws-layout-");
      await writeLayout(root, layout.files);

      const project = await loadProject({inputDirectory: root});

      assert.deepEqual(project.relativeFiles, layout.files);
      assert.equal(project.fields[0]?.id, "title");
      assert.equal(project.fieldDefaults.title, "Hello");
    });
  }
});

test("rejects an ambiguous directory containing both supported layouts", async (t) => {
  const root = await temporaryDirectory(t, "sws-ambiguous-");
  await Promise.all(layouts.map((layout) => writeLayout(root, layout.files)));

  await assert.rejects(
    loadProject({inputDirectory: root}),
    (error) => error?.code === "AMBIGUOUS_LAYOUT" && /Both supported widget layouts/.test(error.message)
  );
});

test("normalizes object and array FIELDS schemas, including object-form options", () => {
  const objectFields = {
    title: {type: "text", label: "Title", value: "Studio"},
    style: {
      type: "dropdown",
      value: "soft",
      options: {soft: "Soft pill", square: "Compact square", enabled: "Enabled"}
    }
  };
  const normalizedObject = normalizeFields(objectFields);

  assert.deepEqual(normalizedObject.defaults, {title: "Studio", style: "soft"});
  assert.deepEqual(normalizedObject.fields[1]?.options, [
    {label: "Soft pill", value: "soft"},
    {label: "Compact square", value: "square"},
    {label: "Enabled", value: "enabled"}
  ]);

  const arrayFields = [
    {id: "title", type: "text", default: "Array title"},
    {name: "enabled", type: "checkbox", value: false}
  ];
  const normalizedArray = normalizeFields(arrayFields);
  assert.deepEqual(
    normalizedArray.fields.map(({id, type, value}) => ({id, type, value})),
    [
      {id: "title", type: "text", value: "Array title"},
      {id: "enabled", type: "checkbox", value: false}
    ]
  );
  assert.deepEqual(normalizedArray.defaults, {title: "Array title", enabled: false});

  assert.deepEqual(normalizeFields({fields: arrayFields}).defaults, normalizedArray.defaults);
});

test("JSON object merging is shallow and never shares nested output values with its inputs", () => {
  const defaults = {
    title: "Default",
    nested: {fromDefaults: true},
    list: ["default"]
  };
  const theme = {
    title: "Theme",
    nested: {fromTheme: true}
  };
  const scene = {
    title: "Scene",
    list: ["scene"]
  };
  const snapshots = structuredClone({defaults, theme, scene});

  const merged = mergeJsonObjects(defaults, theme, scene);

  assert.deepEqual(merged, {
    title: "Scene",
    nested: {fromTheme: true},
    list: ["scene"]
  });
  merged.nested.fromTheme = false;
  merged.list.push("changed");
  assert.deepEqual({defaults, theme, scene}, snapshots);
});

test("fixture validation rejects common credential keys and live StreamElements API URLs", async (t) => {
  const root = await temporaryDirectory(t, "sws-sensitive-fixture-");
  await writeLayout(root, layouts[0].files);
  const project = await loadProject({inputDirectory: root});
  project.fixtures = [{
    id: "unsafe",
    filePath: join(root, "unsafe.json"),
    value: {
      schemaVersion: 1,
      id: "unsafe",
      name: "Unsafe",
      channel: {
        apiToken: "not-a-real-token",
        endpoint: "https://api.streamelements.com/kappa/v2"
      },
      events: []
    }
  }];

  const diagnostics = await validateProject(project);
  const sensitive = diagnostics.find(({code}) => code === "SENSITIVE_TEST_DATA");
  assert.equal(sensitive?.status, "error");
  assert.match(sensitive?.detail ?? "", /apiToken/);
  assert.match(sensitive?.detail ?? "", /endpoint/);
  assert.throws(
    () => assertPublicSafeProject(project),
    (error) => error?.code === "SENSITIVE_TEST_DATA" && /synthetic public-safe/.test(error.hint ?? "")
  );
});
