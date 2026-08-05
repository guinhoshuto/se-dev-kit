import assert from "node:assert/strict";
import {lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {initializeWidget} from "../../dist/config/init.js";
import {CONFIG_FILE_NAME} from "../../dist/config/load.js";

const layouts = [
  {html: "widget.html", css: "widget.css", js: "widget.js", fields: "widget.json"},
  {html: "index.html", css: "style.css", js: "script.js", fields: "fields.json"}
];

async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, {recursive: true, force: true}));
  return directory;
}

async function writeLayout(root, files) {
  await Promise.all([
    writeFile(join(root, files.html), '<main id="widget">Widget</main>\n'),
    writeFile(join(root, files.css), "#widget { color: white; }\n"),
    writeFile(join(root, files.js), "window.__widgetLoaded = true;\n"),
    writeFile(join(root, files.fields), '{"title":{"type":"text","value":"Hello"}}\n')
  ]);
}

test("init autodetects both supported layouts and writes the config at the input root", async (t) => {
  for (const [index, files] of layouts.entries()) {
    await t.test(files.html, async (t) => {
      const root = await temporaryDirectory(t, `sws-init-layout-${index}-`);
      await writeLayout(root, files);

      const result = await initializeWidget(root);
      const source = await readFile(join(root, CONFIG_FILE_NAME), "utf8");
      const resolvedRoot = await realpath(root);

      assert.equal(result.configPath, join(resolvedRoot, CONFIG_FILE_NAME));
      assert.match(source, /root: "\."/);
      for (const file of Object.values(files)) assert.match(source, new RegExp(`"${file}"`));
    });
  }
});

test("init rejects an existing config before importing it when force is absent", async (t) => {
  const root = await temporaryDirectory(t, "sws-init-no-force-");
  await writeLayout(root, layouts[0]);
  await writeFile(join(root, CONFIG_FILE_NAME), 'throw new Error("this module must not be imported");\n');

  await assert.rejects(
    initializeWidget(root),
    (error) => error?.code === "CONFIG_EXISTS" && !/must not be imported/.test(error.message)
  );
});

test("init --force repairs an invalid config when production files are in the input root", async (t) => {
  const root = await temporaryDirectory(t, "sws-init-repair-");
  await writeLayout(root, layouts[1]);
  await writeFile(join(root, CONFIG_FILE_NAME), "export default { this is not valid JavaScript;\n");

  const result = await initializeWidget(root, {force: true});
  const source = await readFile(join(root, CONFIG_FILE_NAME), "utf8");
  const resolvedRoot = await realpath(root);

  assert.equal(result.configPath, join(resolvedRoot, CONFIG_FILE_NAME));
  assert.match(source, /root: "\."/);
  assert.match(source, /"html": "index\.html"/);
  assert.match(source, /export default defineConfig/);
});

test("init --force preserves a valid relative widget root but replaces only the input-root config", async (t) => {
  const root = await temporaryDirectory(t, "sws-init-subdir-");
  const widgetRoot = join(root, "widget-source");
  await mkdir(widgetRoot);
  await writeLayout(widgetRoot, layouts[0]);
  await writeFile(
    join(root, CONFIG_FILE_NAME),
    `export default {
  schemaVersion: 1,
  widget: {root: "./widget-source"},
  output: {root: ".se-widget-studio/output"}
};
`
  );

  const result = await initializeWidget(root, {force: true});
  const source = await readFile(join(root, CONFIG_FILE_NAME), "utf8");
  const resolvedRoot = await realpath(root);
  const resolvedWidgetRoot = join(resolvedRoot, "widget-source");

  assert.equal(result.configPath, join(resolvedRoot, CONFIG_FILE_NAME));
  assert.match(source, /root: "widget-source"/);
  await assert.rejects(lstat(join(widgetRoot, CONFIG_FILE_NAME)), (error) => error?.code === "ENOENT");
  assert.deepEqual(
    result.directories,
    ["themes", "fixtures", "scenarios", "scenes", "recipes"].map((name) => join(resolvedWidgetRoot, name))
  );
  for (const directory of result.directories) assert.equal((await lstat(directory)).isDirectory(), true);
});

test("init never replaces a symlink or non-file configuration target", async (t) => {
  await t.test("symlink", async (t) => {
    const root = await temporaryDirectory(t, "sws-init-symlink-");
    await writeLayout(root, layouts[0]);
    const symlinkTarget = join(root, "actual-config.mjs");
    await writeFile(symlinkTarget, "sentinel\n");
    await symlink(symlinkTarget, join(root, CONFIG_FILE_NAME));

    await assert.rejects(initializeWidget(root, {force: true}), (error) => error?.code === "CONFIG_TARGET_INVALID");
    assert.equal(await readFile(symlinkTarget, "utf8"), "sentinel\n");
  });

  await t.test("directory", async (t) => {
    const root = await temporaryDirectory(t, "sws-init-directory-");
    await writeLayout(root, layouts[0]);
    await mkdir(join(root, CONFIG_FILE_NAME));

    await assert.rejects(initializeWidget(root, {force: true}), (error) => error?.code === "CONFIG_TARGET_INVALID");
    assert.equal((await lstat(join(root, CONFIG_FILE_NAME))).isDirectory(), true);
  });
});
