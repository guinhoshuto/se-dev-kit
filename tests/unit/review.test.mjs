import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import test from "node:test";

import {contactSheetHtml} from "../../dist/capture/renderer.js";
import {reviewItems, reviewTags, writeReviewPage} from "../../dist/capture/review.js";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url));

/** A recipe folder as render writes it: the manifest, and the files it lists (except `skip`). */
async function recipeFolder(outputRoot, recipe, {artifacts, contactSheet = null, review, skip = []}) {
  await mkdir(join(outputRoot, recipe), {recursive: true});
  const manifest = {schemaVersion: 1, generatedAt: "2026-10-05T21:00:00.000Z", recipe: {id: recipe}, contactSheet, artifacts, ...(review ? {review} : {})};
  await writeFile(join(outputRoot, recipe, "manifest.json"), JSON.stringify(manifest));
  const files = artifacts.flatMap((entry) => [entry.screenshot, entry.video, entry.thumbnail, ...(entry.stills ?? []).map((still) => still.file.file)]);
  for (const file of [...files, contactSheet?.file].filter(Boolean)) {
    if (!skip.includes(file)) await writeFile(join(outputRoot, file), "");
  }
}

test("review tags are the recipe id's initials, with a digit for a repeat in the widget's recipe order", () => {
  const tags = reviewTags(["listing-tutorial", "lamp-toggle", "cover", "etsy-listing-images", "c", "listingTutorial", "capa-ação", "cover"]);
  assert.deepEqual(Object.fromEntries(tags), {
    "listing-tutorial": "LT",
    "lamp-toggle": "LT2",
    cover: "C",
    "etsy-listing-images": "ELI",
    c: "C2",
    listingTutorial: "LT3",
    "capa-ação": "CA"
  });
});

test("review codes number screenshots first, then videos, stills, thumbnails, and the contact sheet", () => {
  const entries = [
    {
      id: "a",
      screenshot: "r/a.png",
      thumbnail: "r/a-thumb.png",
      video: "r/a.mp4",
      stills: [{name: "open", file: {file: "r/a-still-open.png"}}, {name: "end", file: {file: "r/a-still-end.png"}}]
    },
    {id: "b", screenshot: "r/b.png", thumbnail: "r/b-thumb.png", video: null}
  ];
  const items = reviewItems("LT", entries, "r/contact-sheet.png");
  assert.deepEqual(items.map((item) => `${item.code} ${item.kind} ${item.file}`), [
    "LT-01 screenshot r/a.png",
    "LT-02 screenshot r/b.png",
    "LT-03 video r/a.mp4",
    "LT-04 still r/a-still-open.png",
    "LT-05 still r/a-still-end.png",
    "LT-06 thumbnail r/a-thumb.png",
    "LT-07 thumbnail r/b-thumb.png",
    "LT-08 contactSheet r/contact-sheet.png"
  ]);
  assert.deepEqual(items[3], {code: "LT-04", kind: "still", file: "r/a-still-open.png", variant: "a", name: "open"});
  assert.deepEqual(reviewItems("LT", structuredClone(entries), "r/contact-sheet.png"), items, "the same render gets the same codes");
  // Two digits up to 99 files, then as many as the count needs.
  const many = Array.from({length: 100}, (_, index) => ({id: `v${index}`, screenshot: `r/v${index}.png`}));
  assert.deepEqual(reviewItems("X", many.slice(0, 99)).map((item) => item.code).slice(-1), ["X-99"]);
  assert.deepEqual(reviewItems("X", many).map((item) => item.code).filter((_, index) => index === 0 || index === 99), ["X-001", "X-100"]);
});

test("the contact sheet captions each cell with its screenshot's review code before the variant id", () => {
  const entries = [{id: "x<y", screenshot: "r/x.png", video: "r/x.mp4"}, {id: "tutorial-editor-midnight", screenshot: "r/t.png"}];
  const html = contactSheetHtml(
    [{id: "tutorial-editor-midnight", src: "data:image/png;base64,AA==", width: 1920, height: 1080}, {id: "x<y", src: "data:image/png;base64,AA==", width: 320, height: 240}],
    reviewItems("LT", entries, "r/contact-sheet.png")
  );
  assert.match(html, /<figcaption><b>LT-02<\/b> · tutorial-editor-midnight<\/figcaption>/);
  assert.match(html, /<figcaption><b>LT-01<\/b> · x&lt;y<\/figcaption>/);
  assert.equal(html.match(/<figure>/g).length, 2);
});

test("the review page shows every file under its code, linked from the page, old manifests included", async () => {
  const root = await mkdtemp(join(tmpdir(), "sws-review-"));
  try {
    const out = join(root, "out");
    const tutorial = [{id: "a", screenshot: "listing-tutorial/a.png", video: "listing-tutorial/a.mp4", thumbnail: null, stills: [{name: "open", file: {file: "listing-tutorial/a-still-open.png"}}]}];
    await recipeFolder(join(out, "render"), "listing-tutorial", {
      artifacts: tutorial,
      review: {tag: "LT", items: reviewItems("LT", tutorial)},
      skip: ["listing-tutorial/a-still-open.png"]
    });
    // Written before review codes: the codes come from the recipe id and the artifacts.
    const images = [{id: "b", screenshot: "etsy-listing-images/b.png", video: null, thumbnail: "etsy-listing-images/b-thumb.png"}];
    await recipeFolder(join(out, "old"), "etsy-listing-images", {artifacts: images, contactSheet: {file: "etsy-listing-images/contact-sheet.png"}});

    const page = join(out, "index.html");
    const result = await writeReviewPage({page, folders: [join(out, "render"), join(out, "old", "etsy-listing-images")], title: "Round 2"});
    assert.deepEqual(result.sections.map((section) => `${section.tag} ${section.recipe} ${section.items}`), ["LT listing-tutorial 3", "ELI etsy-listing-images 3"]);
    assert.deepEqual([result.images, result.videos], [5, 1]);
    assert.deepEqual(result.missing, [join(out, "render", "listing-tutorial", "a-still-open.png")]);

    const html = await readFile(page, "utf8");
    assert.match(html, /<title>Round 2<\/title>/);
    assert.match(html, /<figure id="LT-01"><a href="render\/listing-tutorial\/a\.png"><img src="render\/listing-tutorial\/a\.png" alt="LT-01 · a · screenshot" loading="lazy"><\/a><figcaption>LT-01 · a · screenshot<\/figcaption><\/figure>/);
    assert.match(html, /<figure id="LT-02"><video src="render\/listing-tutorial\/a\.mp4" controls muted preload="metadata"><\/video><figcaption>LT-02 · a · video<\/figcaption>/);
    assert.match(html, /<figcaption>LT-03 · a · still open<\/figcaption>/);
    assert.match(html, /<figure id="ELI-01"><a href="old\/etsy-listing-images\/b\.png">/);
    assert.match(html, /<figcaption>ELI-02 · b · thumbnail<\/figcaption>/);
    assert.match(html, /<figure id="ELI-03"><a href="old\/etsy-listing-images\/contact-sheet\.png">.*<figcaption>ELI-03 · contact sheet<\/figcaption>/);
    assert.match(html, /<a href="#ELI">ELI · etsy-listing-images<\/a>/);

    await assert.rejects(writeReviewPage({page, folders: [join(out, "render")]}), (error) => error.code === "OUTPUT_EXISTS");
    const replaced = await writeReviewPage({page, folders: [join(out, "render")], force: true});
    assert.deepEqual(replaced.sections.map((section) => section.tag), ["LT"]);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("two rounds of one recipe keep their codes, and two recipes with one tag are refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "sws-review-"));
  try {
    const entry = (recipe) => [{id: "a", screenshot: `${recipe}/a.png`, video: null, thumbnail: null}];
    await recipeFolder(join(root, "render"), "listing-tutorial", {artifacts: entry("listing-tutorial")});
    await recipeFolder(join(root, "render-full"), "listing-tutorial", {artifacts: entry("listing-tutorial")});
    await recipeFolder(join(root, "other"), "lamp-toggle", {artifacts: entry("lamp-toggle")});

    const page = join(root, "rounds.html");
    await writeReviewPage({page, folders: [join(root, "render"), join(root, "render-full")]});
    const html = await readFile(page, "utf8");
    assert.match(html, /<figure id="LT-01"><a href="render\/listing-tutorial\/a\.png">/);
    assert.match(html, /<figure id="LT-01\.2"><a href="render-full\/listing-tutorial\/a\.png">/);
    assert.equal(html.match(/<figcaption>LT-01 · a · screenshot<\/figcaption>/g).length, 2, "both rounds caption the same file LT-01");

    await assert.rejects(
      writeReviewPage({page: join(root, "mixed.html"), folders: [join(root, "render"), join(root, "other")]}),
      (error) => error.code === "REVIEW_TAG_COLLISION" && /listing-tutorial/.test(error.message) && /lamp-toggle/.test(error.message)
    );
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("se-widget-studio review writes the page and needs --force to replace it", {timeout: 60_000}, async () => {
  const root = await mkdtemp(join(tmpdir(), "sws-review-"));
  try {
    await recipeFolder(root, "cover", {artifacts: [{id: "a", screenshot: "cover/a.png", video: null, thumbnail: null}]});
    const page = join(root, "index.html");
    const run = (args) => execFileAsync(process.execPath, [cliPath, "--json", "review", page, root, ...args]).then(
      ({stdout}) => ({code: 0, stdout}),
      (error) => ({code: error.code, stdout: error.stdout, stderr: error.stderr})
    );
    const first = await run([]);
    assert.equal(first.code, 0, first.stderr);
    assert.deepEqual(JSON.parse(first.stdout).sections.map((section) => section.tag), ["C"]);
    assert.match(await readFile(page, "utf8"), /<figcaption>C-01 · a · screenshot<\/figcaption>/);
    const again = await run([]);
    assert.equal(again.code, 2);
    assert.equal(JSON.parse(again.stderr).code, "OUTPUT_EXISTS");
    assert.equal((await run(["--force"])).code, 0);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
