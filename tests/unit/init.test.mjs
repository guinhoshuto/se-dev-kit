import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

import {initializeWidget} from "../../dist/config/init.js";
import {CONFIG_FILE_NAME, loadProject} from "../../dist/config/load.js";

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

test("the theme glob init writes loads themes/<id>.json and leaves the DATA payloads themes/<id>.data.json out", async (t) => {
  const root = await temporaryDirectory(t, "sws-init-themes-");
  await writeLayout(root, layouts[1]);
  await initializeWidget(root);
  const glob = (await readFile(join(root, CONFIG_FILE_NAME), "utf8")).match(/themes: \{glob: ("[^"]+")\}/)?.[1];
  assert.ok(glob, "init writes a theme glob");
  await writeFile(join(root, "themes", "neon.json"), '{"title":"Neon"}\n');
  await writeFile(join(root, "themes", "neon.data.json"), '{"title":"Neon","theme":"custom"}\n');

  const project = await loadProject({inputDirectory: root});

  assert.deepEqual(project.themes.map((theme) => theme.id), ["neon"]);
  assert.deepEqual(project.themes[0].value.fieldData, {title: "Neon"});
});

test("the config init writes loads in a widget folder that does not install se-widget-studio", async (t) => {
  const root = await temporaryDirectory(t, "sws-init-no-package-");
  await writeLayout(root, layouts[1]);
  await initializeWidget(root);

  const project = await loadProject({inputDirectory: root});

  assert.equal(project.configPath, join(await realpath(root), CONFIG_FILE_NAME));
  assert.deepEqual(project.relativeFiles, layouts[1]);
  assert.equal(project.outputRoot, join(await realpath(root), ".se-widget-studio", "output"));
});

const INDEX_LAYOUT_AGENTS = `# Agent instructions

- Test, preview, capture, and render this widget with SE Widget Studio (the \`se-widget-studio\` skill or CLI), never with a sandbox, preview page, or runtime of your own.
- \`index.html\`, \`style.css\`, \`script.js\`, and \`fields.json\` are the production source, pasted as they are into the StreamElements Custom Widget tabs: never rewrite or copy them to make the Studio work.
- Themes are field values, not code: \`themes/<id>.json\` holds partial \`fieldData\`, and \`themes/<id>.data.json\` a DATA-tab payload.
- Studio output goes to \`.se-widget-studio/output/\`; it is regenerable, so keep it out of git.
`;
const GITIGNORE = ".DS_Store\n.se-widget-studio/\n.claude/settings.local.json\n";

async function assertMissing(path) {
  await assert.rejects(lstat(path), (error) => error?.code === "ENOENT", `${path} must not exist`);
}

test("init writes AGENTS.md and .gitignore only with agents, naming the detected layout", async (t) => {
  const plain = await temporaryDirectory(t, "sws-init-agents-off-");
  await writeLayout(plain, layouts[1]);
  const without = await initializeWidget(plain, {force: true});
  assert.equal(without.agents, undefined);
  await assertMissing(join(plain, "AGENTS.md"));
  await assertMissing(join(plain, ".gitignore"));

  const root = await temporaryDirectory(t, "sws-init-agents-index-");
  await writeLayout(root, layouts[1]);
  const result = await initializeWidget(root, {agents: true});
  const resolvedRoot = await realpath(root);
  assert.equal(result.config, "written");
  assert.deepEqual(result.agents, {written: [join(resolvedRoot, "AGENTS.md"), join(resolvedRoot, ".gitignore")], kept: []});
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), INDEX_LAYOUT_AGENTS);
  assert.equal(await readFile(join(root, ".gitignore"), "utf8"), GITIGNORE);

  const legacy = await temporaryDirectory(t, "sws-init-agents-widget-");
  await writeLayout(legacy, layouts[0]);
  await initializeWidget(legacy, {agents: true});
  assert.match(
    await readFile(join(legacy, "AGENTS.md"), "utf8"),
    /^- `widget\.html`, `widget\.css`, `widget\.js`, and `widget\.json` are the production source,/m
  );
});

test("init --agents never replaces an existing AGENTS.md or .gitignore, not even with force or through a symlink", async (t) => {
  for (const force of [false, true]) {
    await t.test(`force ${force}`, async (t) => {
      const root = await temporaryDirectory(t, `sws-init-agents-keep-${force}-`);
      await writeLayout(root, layouts[1]);
      await writeFile(join(root, "AGENTS.md"), "Repository rules.\n");
      await writeFile(join(root, ".gitignore"), "node_modules/\n");

      const result = await initializeWidget(root, {agents: true, force});
      const resolvedRoot = await realpath(root);

      assert.deepEqual(result.agents, {written: [], kept: [join(resolvedRoot, "AGENTS.md"), join(resolvedRoot, ".gitignore")]});
      assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), "Repository rules.\n");
      assert.equal(await readFile(join(root, ".gitignore"), "utf8"), "node_modules/\n");
    });
  }

  await t.test("symlink", async (t) => {
    const root = await temporaryDirectory(t, "sws-init-agents-symlink-");
    await writeLayout(root, layouts[1]);
    const target = join(root, "shared-rules.md");
    await writeFile(target, "sentinel\n");
    await symlink(target, join(root, "AGENTS.md"));
    const dangling = join(root, "missing-ignore");
    await symlink(dangling, join(root, ".gitignore"));

    const result = await initializeWidget(root, {agents: true, force: true});

    assert.equal(result.agents.kept.length, 2);
    assert.equal(await readFile(target, "utf8"), "sentinel\n");
    await assertMissing(dangling);
  });
});

test("init --agents keeps an existing config without force and names its widget root and output", async (t) => {
  const root = await temporaryDirectory(t, "sws-init-agents-config-");
  const widgetRoot = join(root, "widget-source");
  await mkdir(widgetRoot);
  await writeLayout(widgetRoot, layouts[1]);
  const config = `export default {schemaVersion: 1, widget: {root: "./widget-source"}, output: {root: "renders"}};\n`;
  await writeFile(join(root, CONFIG_FILE_NAME), config);

  const result = await initializeWidget(root, {agents: true});
  const agents = await readFile(join(root, "AGENTS.md"), "utf8");

  assert.equal(result.config, "kept");
  assert.deepEqual(result.directories, []);
  assert.equal(await readFile(join(root, CONFIG_FILE_NAME), "utf8"), config);
  await assertMissing(join(widgetRoot, "themes"));
  assert.match(agents, /^- `widget-source\/index\.html`, `widget-source\/style\.css`, `widget-source\/script\.js`, and `widget-source\/fields\.json` are/m);
  assert.match(agents, /`widget-source\/themes\/<id>\.json` holds partial/);
  assert.match(agents, /^- Studio output goes to `widget-source\/renders\/`;/m);

  const replaced = await initializeWidget(root, {agents: true, force: true});
  assert.equal(replaced.config, "written");
  assert.notEqual(await readFile(join(root, CONFIG_FILE_NAME), "utf8"), config);
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), agents);
});

test("init --agents fails on a file it could not write instead of reporting it as kept", async (t) => {
  const root = await temporaryDirectory(t, "sws-init-agents-readonly-");
  await writeLayout(root, layouts[1]);
  const config = `export default {schemaVersion: 1, widget: {root: "."}};\n`;
  await writeFile(join(root, CONFIG_FILE_NAME), config);
  await chmod(root, 0o555);
  try {
    await assert.rejects(initializeWidget(root, {agents: true}), (error) => error?.code === "AGENT_FILE_WRITE_FAILED");
  } finally {
    await chmod(root, 0o755);
  }
  await assertMissing(join(root, "AGENTS.md"));
});

test("the init command passes --agents through and reports the agent files", {timeout: 60_000}, async (t) => {
  const cliPath = fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url));
  const run = async (args) => {
    const {stdout} = await execFileAsync(process.execPath, [cliPath, "init", ...args, "--json"]);
    return JSON.parse(stdout);
  };

  const plain = await temporaryDirectory(t, "sws-init-cli-plain-");
  await writeLayout(plain, layouts[1]);
  const without = await run([plain]);
  assert.equal(without.configStatus, "written");
  assert.equal(without.agentFiles, undefined);
  await assertMissing(join(plain, "AGENTS.md"));

  const root = await temporaryDirectory(t, "sws-init-cli-agents-");
  await writeLayout(root, layouts[1]);
  const output = await run([root, "--agents"]);
  const resolvedRoot = await realpath(root);
  assert.deepEqual(output.agentFiles, {written: [join(resolvedRoot, "AGENTS.md"), join(resolvedRoot, ".gitignore")], kept: []});
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), INDEX_LAYOUT_AGENTS);

  const again = await run([root, "--agents"]);
  assert.equal(again.configStatus, "kept");
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
  assert.match(source, /^export default \{$/m);
  assert.doesNotMatch(source, /^import /m, "a widget repository rarely installs se-widget-studio");
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
