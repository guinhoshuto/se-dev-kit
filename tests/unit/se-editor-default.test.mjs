import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {existsSync} from "node:fs";
import {mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";

import {bundleLink, bundlePath, defaultWidget, findDefaultWidget} from "../../skills/se-widget-studio/scripts/se-editor-default.mjs";

const SCRIPT = fileURLToPath(new URL("../../skills/se-widget-studio/scripts/se-editor-default.mjs", import.meta.url));
const FIXTURE = fileURLToPath(new URL("../fixtures/se-editor-default/", import.meta.url));
const FILES = ["index.html", "style.css", "script.js", "fields.json"];
const run = (...args) => JSON.parse(execFileSync(process.execPath, [SCRIPT, ...args], {stdio: "pipe"}).toString());
const show = (repo, commit, file) => execFileSync("git", ["-C", repo, "show", `${commit}:${file}`]);

// The fixture's decoys, without its default widget: an Alert-Box-like object of four literals and no onWidgetLoad,
// objects whose values are expressions, and one whose template has a real substitution.
const DECOYS = 'const Lk={html:"<div></div>",css:".a{}",js:`window.addEventListener("onEventReceived",e=>{})`,fields:`{"d":{"type":"number","value":5}}`},'
  + 'x={css:Qp.css,html:Qp.html,js:Qp.js,fields:Qp.fields},Mn={css:`.x{left:${Ab}px}`,js:"onWidgetLoad",html:"",fields:"{}"};function Gh(e){return{html:e}}';

test("finds the default widget by its content and commits its four tabs byte for byte, the same commit each time", async () => {
  const root = await mkdtemp(join(tmpdir(), "sws-se-editor-default-"));
  try {
    const printed = run("--bundle", join(FIXTURE, "bundle.js"), "--out", join(root, "first"));
    assert.equal(printed.repo, join(root, "first"));
    assert.equal(printed.object, "Qp");
    assert.equal(printed.bundle, join(FIXTURE, "bundle.js"));
    assert.deepEqual(printed.fields, ["title", "textColor", "maxItems", "speed"]);
    for (const file of FILES) {
      assert.deepEqual(show(printed.repo, printed.commit, file), await readFile(join(FIXTURE, "expected", file)), file);
    }
    assert.equal(execFileSync("git", ["-C", printed.repo, "log", "-1", "--format=%an <%ae> %aI %s"]).toString().trim(),
      "SE Widget Studio <se-widget-studio@localhost> 2000-01-01T00:00:00Z Default Custom widget from bundle.js");
    assert.equal(execFileSync("git", ["-C", printed.repo, "branch", "--show-current"]).toString().trim(), "main");
    assert.equal(run("--bundle", join(FIXTURE, "bundle.js"), "--out", join(root, "second")).commit, printed.commit);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("a bundle without the default widget fails, names what it looked for, and leaves no folder", async () => {
  const root = await mkdtemp(join(tmpdir(), "sws-se-editor-default-"));
  try {
    const bundle = join(root, "index-Decoys.js");
    await writeFile(bundle, DECOYS);
    const out = join(root, "out");
    assert.throws(() => execFileSync(process.execPath, [SCRIPT, "--bundle", bundle, "--out", out], {stdio: "pipe"}), (error) => {
      const stderr = error.stderr.toString();
      assert.equal(error.status, 1);
      assert.match(stderr, /^se-editor-default: No object literal with string literal keys css, js, html, and fields whose js has onWidgetLoad/);
      assert.ok(stderr.includes(bundle), stderr);
      assert.match(stderr, /checked 1 objects with those four keys/);
      return true;
    });
    assert.equal(existsSync(out), false);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("two different default widgets are ambiguous, the same one twice is one", () => {
  const widget = (html) => `{css:"",js:"window.addEventListener('onWidgetLoad',()=>{})",html:"${html}",fields:'{"a":{"type":"text"}}'}`;
  assert.throws(() => findDefaultWidget(`a=${widget("<p>1</p>")};b=${widget("<p>2</p>")}`, "test.js"),
    /^Error: 2 different default widgets in test\.js, at offsets 2, \d+\.$/);
  const found = findDefaultWidget(`a=${widget("<p>1</p>")};b=${widget("<p>1</p>")}`, "test.js");
  assert.equal(found.html, "<p>1</p>");
  assert.equal(found.object, "a");
  assert.equal(findDefaultWidget(`[${widget("")}]`, "test.js").object, null);
  // Duplicate keys, a fields that is not a JSON object, and a non-string value are not the widget.
  assert.throws(() => findDefaultWidget(`{css:"",css:"",js:"onWidgetLoad",fields:"{}"}`, "t"), /checked 1 objects/);
  assert.throws(() => findDefaultWidget(`{css:"",js:"onWidgetLoad",html:"",fields:"[]"}`, "t"), /checked 1 objects/);
});

test("an existing --out is refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "sws-se-editor-default-"));
  try {
    const out = join(root, "out");
    await mkdir(out);
    await writeFile(join(out, "keep.txt"), "mine");
    assert.throws(() => execFileSync(process.execPath, [SCRIPT, "--bundle", join(FIXTURE, "bundle.js"), "--out", out], {stdio: "pipe"}),
      (error) => error.status === 1 && /already exists; --out must be a new folder\./.test(error.stderr.toString()));
    assert.equal(await readFile(join(out, "keep.txt"), "utf8"), "mine");
    assert.equal(existsSync(join(out, ".git")), false);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("bundlePath reads the bundle's script from the editor page", () => {
  const page = '<!doctype html><html><head><script type="module" crossorigin src="/overlay/assets/index-Ab_9-x.js"></script>'
    + '<link rel="stylesheet" href="/overlay/assets/index-Cd.css"></head><body><div id="root"></div></body></html>';
  assert.equal(bundlePath(page), "/overlay/assets/index-Ab_9-x.js");
  assert.throws(() => bundlePath('<script src="/overlay/assets/vendor-Ab.js"></script>'), /no <script src="\/overlay\/assets\/index-<hash>\.js">/);
  const editor = "https://streamelements.com/overlay/0/editor";
  assert.equal(bundleLink("/overlay/assets/index-Ab.js", editor).href, "https://streamelements.com/overlay/assets/index-Ab.js");
  for (const src of ["https://cdn.example.com/overlay/assets/index-Ab.js", "//cdn.example.com/overlay/assets/index-Ab.js", "/overlay/assets/index-Ab.js?v=1", "/static/overlay/assets/index-Ab.js"]) {
    assert.throws(() => bundleLink(src, editor), /is not https:\/\/streamelements\.com\/overlay\/assets\/index-<hash>\.js\./, src);
  }
});

test("--page refuses a link that is not https on streamelements.com before any request", async () => {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    throw new Error("no network in this test");
  };
  try {
    for (const page of ["http://streamelements.com/overlay/0/editor", "https://example.com/overlay/0/editor", "https://streamelements.com.example.com/overlay/0/editor"]) {
      await assert.rejects(defaultWidget({page, out: join(tmpdir(), "sws-se-editor-default-never")}), /^Error: --page must be an https:\/\/streamelements\.com\/ link/);
    }
    await assert.rejects(defaultWidget({page: "https://streamelements.com/x", bundle: "b.js", out: "o"}), /exactly one of --page and --bundle/);
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = original;
  }
  assert.throws(() => execFileSync(process.execPath, [SCRIPT], {stdio: "pipe"}), (error) => error.status === 2 && /^Usage: se-editor-default\.mjs/.test(error.stdout.toString()));
  assert.match(execFileSync(process.execPath, [SCRIPT, "--help"]).toString(), /--out must not exist\.\nThen: git -C <out> fetch -q --no-tags <widget repository> <new commit>\n {6}se-editor-plan\.mjs --repo <out> --from <printed commit>/);
});
