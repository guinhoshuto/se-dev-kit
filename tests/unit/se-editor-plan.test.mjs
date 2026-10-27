import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";

import {changedLabels, plan, template} from "../../skills/se-widget-studio/scripts/se-editor-plan.mjs";

const SCRIPTS = fileURLToPath(new URL("../../skills/se-widget-studio/scripts/", import.meta.url));
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");

const OLD = {
  "index.html": "<div id=\"wrap\"></div>\n",
  "style.css": "#wrap { color: red; }\n",
  "script.js": "window.addEventListener('onWidgetLoad', () => {});\n",
  "fields.json": JSON.stringify({speed: {type: "slider", label: "Speed", value: 1}, title: {type: "text", label: "Title", value: "Hi"}}, null, 2) + "\n"
};
const NEW = {
  ...OLD,
  "style.css": "#wrap { color: blue; }\n",
  "script.js": "window.addEventListener('onWidgetLoad', () => { start(); });\n",
  "fields.json": JSON.stringify({
    speed: {type: "slider", label: "Speed", value: 1},
    title: {type: "text", label: "Title shown above", value: "Hi"},
    results: {type: "text", label: "Results command (empty = off)", value: ""}
  }, null, 2) + "\n"
};

/** A widget repository with OLD then NEW committed; returns its folder and the two commits. */
async function widgetRepo(root, first = OLD, second = NEW) {
  const repo = join(root, "widget");
  await mkdir(repo);
  const git = (...args) => execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args]).toString().trim();
  git("init", "-q");
  const commit = async (files) => {
    for (const [name, content] of Object.entries(files)) await writeFile(join(repo, name), content);
    git("add", "-A");
    git("commit", "-q", "-m", "widget");
    return git("rev-parse", "HEAD");
  };
  return {repo, from: await commit(first), to: await commit(second), git};
}

test("plan writes the new commit's files to a new folder and expects each tab by its old and new SHA-256", async () => {
  const root = await mkdtemp(join(tmpdir(), "sws-se-editor-plan-"));
  try {
    const {repo, from, to} = await widgetRepo(root);
    const out = join(root, "upload");
    const result = plan({repo, from, out});
    assert.equal(result.version, 1);
    assert.equal(result.from, from);
    assert.equal(result.to, to, "--to defaults to HEAD");
    assert.deepEqual(Object.keys(result.tabs), ["html", "css", "js", "fields"]);
    for (const [tab, file] of [["html", "index.html"], ["css", "style.css"], ["js", "script.js"]]) {
      assert.deepEqual(result.tabs[tab], {file, old: sha(OLD[file]), new: sha(NEW[file])});
    }
    // FIELDS are expected as parsed JSON: the editor reformats them when it saves.
    const normalized = (text) => sha(JSON.stringify(JSON.parse(text)));
    assert.deepEqual(result.tabs.fields, {file: "fields.json", old: normalized(OLD["fields.json"]), new: normalized(NEW["fields.json"])});
    assert.deepEqual(result.labels, ["Title shown above", "Results command (empty = off)"]);
    assert.deepEqual(result.upload, ["index.html", "style.css", "script.js", "fields.json"].map((name) => join(out, name)));
    for (const name of Object.keys(NEW)) assert.equal(await readFile(join(out, name), "utf8"), NEW[name]);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("the plan reads committed files, never the working tree, and accepts the widget.* layout", async () => {
  const root = await mkdtemp(join(tmpdir(), "sws-se-editor-plan-"));
  try {
    const rename = (files) => Object.fromEntries(Object.entries(files).map(([name, content]) => [
      {"index.html": "widget.html", "style.css": "widget.css", "script.js": "widget.js", "fields.json": "widget.json"}[name], content
    ]));
    const {repo, from, to} = await widgetRepo(root, rename(OLD), rename(NEW));
    await writeFile(join(repo, "widget.js"), "uncommitted();\n");
    const result = plan({repo, from, to, out: join(root, "upload")});
    assert.equal(result.tabs.js.file, "widget.js");
    assert.equal(result.tabs.js.new, sha(NEW["script.js"]));
    assert.equal(await readFile(join(root, "upload", "widget.js"), "utf8"), NEW["script.js"]);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("plan refuses an existing folder, an unknown or repeated commit, a commit that changes no tab, and a BOM", async () => {
  const root = await mkdtemp(join(tmpdir(), "sws-se-editor-plan-"));
  try {
    const {repo, from, to, git} = await widgetRepo(root);
    const existing = join(root, "existing");
    await mkdir(existing);
    await writeFile(join(existing, "keep.txt"), "mine");
    assert.throws(() => plan({repo, from, out: existing}), /EEXIST/);
    assert.deepEqual(await readdir(existing), ["keep.txt"], "an existing folder is left as it was");

    assert.throws(() => plan({repo, from: "nope", out: join(root, "a")}), /nope is not a commit/);
    assert.throws(() => plan({repo, from: to, out: join(root, "b")}), /the same commit/);

    await writeFile(join(repo, "README.md"), "docs only\n");
    git("add", "-A");
    git("commit", "-q", "-m", "docs");
    assert.throws(() => plan({repo, from: to, out: join(root, "c")}), /No code tab changes/);

    await writeFile(join(repo, "style.css"), String.fromCodePoint(0xfeff) + "#wrap {}\n");
    git("add", "-A");
    git("commit", "-q", "-m", "bom");
    assert.throws(() => plan({repo, from, out: join(root, "d")}), /style\.css at [0-9a-f]{7} starts with a byte order mark/);
    for (const name of ["a", "b", "c", "d"]) assert.ok(!(await readdir(root)).includes(name), `no ${name} folder after a refusal`);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("a JS or CSS tab with {{field}} placeholders at either commit carries that commit's template, HTML and FIELDS never", async () => {
  const root = await mkdtemp(join(tmpdir(), "sws-se-editor-plan-"));
  try {
    const long = "; }\n#wrap .name { font-weight: 700; letter-spacing: 1px; font-size: ";
    const fontColor = {type: "colorpicker", label: "Font color", value: "#fff"};
    const first = {...OLD, "index.html": "<div>{{title}}</div>\n", "style.css": "#wrap { color: {{color}}; }\n",
      "fields.json": JSON.stringify({...JSON.parse(OLD["fields.json"]), fontColor})};
    const second = {...NEW, "index.html": first["index.html"], "style.css": `#wrap { color: {{ color }}${long}{{size}}px; }\n`,
      "script.js": "start({{speed}}, `${fontColor}`, {other});\n"};
    const {repo, from} = await widgetRepo(root, first, second);
    const result = plan({repo, from, out: join(root, "upload")});
    const piece = (text) => ({head: text.slice(0, 32), length: text.length, sha256: sha(text)});
    assert.deepEqual(result.tabs.css.templates, {old: ["#wrap { color: ", "; }\n"].map(piece), new: ["#wrap { color: ", long, "px; }\n"].map(piece)});
    assert.equal(result.tabs.css.templates.new[1].head, long.slice(0, 32));
    // A FIELDS key of either commit in single braces is a placeholder too; another name is code.
    assert.deepEqual(result.tabs.js.templates, {new: ["start(", ", `$", "`, {other});\n"].map(piece)}, "only the commit whose code has placeholders");
    assert.deepEqual(result.tabs.html, {file: "index.html", old: sha(first["index.html"]), new: sha(first["index.html"])});
    assert.equal(Object.hasOwn(result.tabs.fields, "templates"), false);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("a template splits at each {{…}} with no brace inside and each {key} of the keys given, and code without one has none", () => {
  assert.equal(template("#wrap { color: red; }\n"), undefined);
  assert.equal(template("a {{ b } c"), undefined);
  assert.equal(template("const {speed} = data;", ["size"]), undefined);
  assert.deepEqual(template("x{ a.b }y{aXb}", ["a.b", "size"]).map(({head}) => head), ["x", "y{aXb}"]);
  assert.deepEqual(template("{{a}}{{b-c.d}}x{{ e }}").map(({head, length}) => [head, length]), [["", 0], ["", 0], ["x", 1], ["", 0]]);
  assert.deepEqual(template("a{{{b}}}c").map(({head}) => head), ["a{", "}c"]);
});

test("changedLabels lists the labels a FIELDS change adds or rewords, once each", () => {
  const before = {a: {label: "Speed"}, b: {label: "Title"}};
  const after = {a: {label: "Speed"}, b: {label: "Title shown"}, c: {label: "New"}, d: {label: "New"}, e: {type: "hidden"}};
  assert.deepEqual(changedLabels(before, after), ["Title shown", "New"]);
});

test("the CLI prints the plan as JSON, and its usage without arguments", async () => {
  const root = await mkdtemp(join(tmpdir(), "sws-se-editor-plan-"));
  try {
    const {repo, from, to} = await widgetRepo(root);
    const script = join(SCRIPTS, "se-editor-plan.mjs");
    const printed = JSON.parse(execFileSync(process.execPath, [script, "--repo", repo, "--from", from, "--to", to, "--out", join(root, "upload")]).toString());
    assert.equal(printed.to, to);
    assert.equal(printed.tabs.css.new, sha(NEW["style.css"]));
    assert.throws(() => execFileSync(process.execPath, [script], {stdio: "pipe"}), (error) => error.status === 2 && /^Usage: se-editor-plan\.mjs/.test(error.stdout.toString()));
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("the read-only page script never writes, clicks, or reads inputs, so it can run before the owner approves", async () => {
  const source = await readFile(join(SCRIPTS, "se-editor-read.js"), "utf8");
  for (const pattern of [/\.(?:setValue|executeEdits|pushEditOperations|applyEdits)\s*\(/, /\.value\s*=(?!=)/, /\.click\s*\(/, /dispatchEvent\s*\(/,
    /\.focus\s*\(/, /querySelectorAll\(\s*['"`][^'"`]*\b(?:input|textarea)\b/]) {
    assert.doesNotMatch(source, pattern);
  }
  // The writing half is the only one that does.
  assert.match(await readFile(join(SCRIPTS, "se-editor-update.js"), "utf8"), /\.setValue\(/);
});
