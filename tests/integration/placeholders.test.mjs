import assert from "node:assert/strict";
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {detectBrowser, launchStudioBrowser} from "../../dist/capture/browser.js";
import {loadProject} from "../../dist/config/load.js";
import {frameEvents, openScene} from "../../dist/scenarios/runner.js";
import {startStudioServer} from "../../dist/server/server.js";

// A 1x1 PNG: the relative url() that must keep resolving next to the substituted CSS.
const DOT_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function placeholderWidget(t) {
  const root = await mkdtemp(join(tmpdir(), "sws-placeholder-integration-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(join(root, "assets"));
  const files = {
    "widget.html": [
      '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
      '<link rel="stylesheet" href="widget.css">',
      '<main id="widget"><h1 id="title">{{title}}</h1><div id="dot"></div><p id="script"></p></main>',
      ""
    ].join("\n"),
    "widget.css": 'body{margin:0}#title::after{content:"{{ title }}"}#dot{width:{{size}}px;height:{{size}}px;background-image:url(assets/dot.png)}\n',
    "widget.js": 'window.fromScript = "{{title}}";\nwindow.addEventListener("onWidgetLoad", () => { document.getElementById("script").textContent = window.fromScript; });\n',
    "widget.json": JSON.stringify({title: {type: "text", label: "Title", value: "Default title"}, size: {type: "number", label: "Size", value: 4}})
  };
  await Promise.all([...Object.entries(files).map(([name, body]) => writeFile(join(root, name), body)), writeFile(join(root, "assets/dot.png"), DOT_PNG)]);
  const project = await loadProject({inputDirectory: root});
  project.themes.push({id: "midnight", filePath: "", value: {schemaVersion: 1, id: "midnight", name: "Midnight", fieldData: {title: "Theme title", size: 12}}});
  return {root, files, project};
}

async function get(url) {
  const response = await fetch(url);
  return {status: response.status, text: await response.text()};
}

test("the frame server substitutes {{field}} per registered document at the usual paths, and refuses values that add unsafe HTML", async (t) => {
  const {root, files, project} = await placeholderWidget(t);
  const server = await startStudioServer(project, {port: 0, watch: false});
  try {
    const key = await server.registerFrameDocument({title: "Theme title", size: 12});
    assert.match(key, /^[a-f0-9]{32}$/);
    const frameUrl = (doc) => `${server.frameOrigin}/__sws/frame/${"a".repeat(24)}?nonce=${"b".repeat(32)}${doc === undefined ? "" : `&doc=${doc}`}`;
    const page = await get(frameUrl(key));
    assert.equal(page.status, 200);
    assert.match(page.text, /<h1 id="title">Theme title<\/h1>/);
    assert.doesNotMatch(page.text, /preconnect|fonts\.gstatic\.com/, "external non-stylesheet links are dropped");
    const stylesheets = [...page.text.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((match) => match[1]);
    assert.deepEqual(stylesheets, [`${server.frameOrigin}/__sws/widget/widget.css?doc=${key}`], "the widget's own link carries the key and is not injected twice");
    const bootstrap = new URL(/<script type="module" src="([^"]+)"><\/script>/.exec(page.text)[1].replaceAll("&amp;", "&"));
    assert.equal(bootstrap.searchParams.get("script"), `${server.frameOrigin}/__sws/widget/widget.js?doc=${key}`);

    assert.equal((await get(`${server.frameOrigin}/__sws/widget/widget.css?doc=${key}`)).text, 'body{margin:0}#title::after{content:"Theme title"}#dot{width:12px;height:12px;background-image:url(assets/dot.png)}\n');
    assert.match((await get(`${server.frameOrigin}/__sws/widget/widget.js?doc=${key}`)).text, /^window\.fromScript = "Theme title";/);
    // Without a key (the local dev UI) the defaults apply; an unknown key is not found.
    assert.match((await get(`${server.frameOrigin}/__sws/widget/widget.css`)).text, /content:"Default title"/);
    assert.match((await get(frameUrl())).text, /<h1 id="title">Default title<\/h1>/);
    for (const path of [`/__sws/widget/widget.css?doc=${"c".repeat(32)}`, `/__sws/widget/widget.js?doc=nope`]) assert.equal((await get(`${server.frameOrigin}${path}`)).status, 404, path);
    assert.equal((await get(frameUrl("f".repeat(32)))).status, 404);

    for (const title of ['<meta http-equiv="refresh" content="0;url=https://example.com">', '<img src="x" onerror="fetch(`https://example.com`)">', '<base href="https://example.com/">']) {
      await assert.rejects(server.registerFrameDocument({title, size: 1}), {code: "PLACEHOLDER_UNSAFE_HTML"}, title);
    }
    // Substitution happens in memory: widget files are byte-for-byte unchanged.
    for (const [name, body] of Object.entries(files)) assert.equal(await readFile(join(root, name), "utf8"), body, name);
    assert.deepEqual((await readdir(root)).sort(), ["assets", "widget.css", "widget.html", "widget.js", "widget.json"]);
  } finally {
    await server.close();
  }
});

test("a capture shows the theme value of {{title}} in HTML, CSS content and JS, and a relative url() next to a placeholder still loads", {timeout: 120_000}, async (t) => {
  const detection = await detectBrowser();
  if (!detection.executablePath) {
    t.skip("No compatible local Chromium executable is installed; the Studio must not download one implicitly.");
    return;
  }
  const {project} = await placeholderWidget(t);
  const scene = {
    schemaVersion: 1,
    id: "themed",
    name: "Themed",
    theme: "midnight",
    viewport: {width: 320, height: 240},
    output: {width: 320, height: 240, format: "png"}
  };
  const server = await startStudioServer(project, {port: 0, watch: false});
  const {browser} = await launchStudioBrowser({browserPath: detection.executablePath});
  try {
    const opened = await openScene(project, server, browser, scene);
    try {
      const frame = opened.frame();
      assert.match(frame.url(), /[?&]doc=[a-f0-9]{32}(?:&|$)/);
      const seen = await frame.evaluate(() => {
        const title = document.getElementById("title");
        const dot = document.getElementById("dot");
        return {
          html: title.textContent,
          css: getComputedStyle(title, "::after").content,
          js: document.getElementById("script").textContent,
          width: getComputedStyle(dot).width,
          background: getComputedStyle(dot).backgroundImage
        };
      });
      assert.deepEqual(seen, {
        html: "Theme title",
        css: '"Theme title"',
        js: "Theme title",
        width: "12px",
        background: `url("${server.frameOrigin}/__sws/widget/assets/dot.png")`
      });
      const runtimeErrors = (await frameEvents(opened.page)).filter(({type}) => type === "frame:error" || type === "frame:unhandled-rejection");
      assert.deepEqual(runtimeErrors, []);
      assert.deepEqual(opened.issues.errors, []);
    } finally {
      await opened.context.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
});
