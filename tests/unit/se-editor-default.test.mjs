import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {existsSync} from "node:fs";
import {chmod, mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";

import {PAGE_LIMIT, bundleLink, bundlePath, defaultWidget, findDefaultWidget} from "../../skills/se-widget-studio/scripts/se-editor-default.mjs";

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

// A fake fetch that records each request and answers from `answers` in order; the test restores the real one.
async function withFakeFetch(answers, body) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({url: String(url), options});
    const answer = answers[requests.length - 1];
    if (!answer) throw new Error(`unexpected request ${url}`);
    return answer();
  };
  try {
    await body(requests);
  } finally {
    globalThis.fetch = original;
  }
}

const EDITOR = "https://streamelements.com/overlay/0123/editor";
const PAGE = '<!doctype html><html><head><script type="module" crossorigin src="/overlay/assets/index-Qp.js"></script></head><body></body></html>';

test("--page fetches the page and then its bundle with no credentials, no redirects, a timeout, and only a user-agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "sws-se-editor-default-"));
  try {
    // Padded past the page limit: the bundle has a limit of its own.
    const bundleText = Buffer.concat([await readFile(join(FIXTURE, "bundle.js")), Buffer.alloc(PAGE_LIMIT + 1, 32)]);
    await withFakeFetch([() => new Response(PAGE), () => new Response(bundleText)], async (requests) => {
      const fetched = await defaultWidget({page: EDITOR, out: join(root, "page")});
      assert.deepEqual(requests.map((request) => request.url), [EDITOR, "https://streamelements.com/overlay/assets/index-Qp.js"]);
      for (const {options} of requests) {
        assert.equal(options.redirect, "error");
        assert.equal(options.credentials, "omit");
        assert.ok(options.signal instanceof AbortSignal, "a signal");
        assert.deepEqual(options.headers, {"user-agent": "se-widget-studio"});
      }
      // The same bundle saved as index-Qp.js gives the same commit and tabs.
      const saved = join(root, "index-Qp.js");
      await writeFile(saved, bundleText);
      const printed = run("--bundle", saved, "--out", join(root, "bundle"));
      assert.equal(fetched.commit, printed.commit);
      assert.equal(fetched.bundle, "https://streamelements.com/overlay/assets/index-Qp.js");
      assert.equal(fetched.object, "Qp");
      assert.deepEqual(fetched.fields, printed.fields);
      for (const file of FILES) assert.deepEqual(show(fetched.repo, fetched.commit, file), await readFile(join(FIXTURE, "expected", file)), file);
    });
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("--page refuses an answer that is not 2xx and a page over its limit, cancelling the stream", async () => {
  const root = await mkdtemp(join(tmpdir(), "sws-se-editor-default-"));
  try {
    await withFakeFetch([() => new Response("not found", {status: 404})], async () => {
      await assert.rejects(defaultWidget({page: EDITOR, out: join(root, "missing")}), new RegExp(`^Error: The page ${EDITOR} answered 404\\.$`));
    });
    // A page that keeps giving chunks, bounded so that a missing limit ends in a wrong error, not a hang.
    const chunk = new Uint8Array(64 * 1024).fill(32);
    let pulls = 0;
    let cancelled = false;
    const stream = () => new ReadableStream({
      pull(controller) {
        pulls += 1;
        if (pulls > 4 * PAGE_LIMIT / chunk.byteLength) controller.close();
        else controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      }
    });
    await withFakeFetch([() => new Response(stream())], async (requests) => {
      await assert.rejects(defaultWidget({page: EDITOR, out: join(root, "large")}), new RegExp(`^Error: The page ${EDITOR} is larger than ${PAGE_LIMIT} bytes\\.$`));
      assert.equal(requests.length, 1);
    });
    assert.equal(cancelled, true);
    assert.ok(pulls <= PAGE_LIMIT / chunk.byteLength + 3, `${pulls} pulls`);
    assert.equal(existsSync(join(root, "missing")) || existsSync(join(root, "large")), false);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("the commit ignores the caller's GIT_* variables and global git config", async () => {
  const root = await mkdtemp(join(tmpdir(), "sws-se-editor-default-"));
  try {
    const plain = run("--bundle", join(FIXTURE, "bundle.js"), "--out", join(root, "plain")).commit;
    // A global config that would change the commit (an encoding header) and run a hook.
    const home = join(root, "home");
    await mkdir(join(home, "hooks"), {recursive: true});
    await writeFile(join(home, "hooks", "post-commit"), `#!/bin/sh\ntouch "${join(root, "hook-ran")}"\n`);
    await chmod(join(home, "hooks", "post-commit"), 0o755);
    await writeFile(join(home, ".gitconfig"), `[i18n]\n\tcommitEncoding = ISO-8859-1\n[core]\n\thooksPath = ${join(home, "hooks")}\n`);
    const env = {...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), GIT_DIR: join(root, "elsewhere"), GIT_INDEX_FILE: join(root, "index")};
    const out = join(root, "out");
    const printed = JSON.parse(execFileSync(process.execPath, [SCRIPT, "--bundle", join(FIXTURE, "bundle.js"), "--out", out], {stdio: "pipe", env}).toString());
    assert.equal(printed.commit, plain);
    assert.equal(execFileSync("git", ["-C", out, "rev-parse", "HEAD"]).toString().trim(), plain);
    assert.equal(existsSync(join(root, "elsewhere")) || existsSync(join(root, "index")) || existsSync(join(root, "hook-ran")), false);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
