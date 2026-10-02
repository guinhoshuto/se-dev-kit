import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

import {renderTutorialPage} from "../../dist/server/tutorial-page.js";

// The measured editor the replica copies; see docs/tutorial-reference/README.md.
const REFERENCE = new URL("../../docs/tutorial-reference/2026-09-25-recovered.json", import.meta.url);
const ref = JSON.parse(readFileSync(REFERENCE, "utf8")).probes;
const page = renderTutorialPage("http://127.0.0.1:1");

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = page.match(new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`));
  assert.ok(match, `the replica has no "${selector}" rule`);
  return Object.fromEntries(match[1].split(";").map((part) => part.trim()).filter(Boolean).map((decl) => {
    const colon = decl.indexOf(":");
    return [decl.slice(0, colon).trim(), decl.slice(colon + 1).trim()];
  }));
}

const vars = rule(".se-editor");
const resolve = (value) => value.replace(/var\((--[\w-]+)\)/g, (_, name) => vars[name]);
function rgb(value) {
  const hex = resolve(value).replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

test("the toolbar matches the measured editor", () => {
  const toolbar = rule(".se-toolbar");
  assert.equal(toolbar.height, `${ref.toolbar.rect.h}px`);
  assert.equal(rgb(toolbar.background), ref.toolbar.style.backgroundColor);
  const title = rule(".se-toolbar .title");
  assert.equal(title.width, `${ref.title.rect.w}px`);
  assert.equal(title.height, `${ref.title.rect.h}px`);
  assert.equal(title["font-size"], ref.title.style.fontSize);
  assert.equal(title["font-weight"], ref.title.style.fontWeight);
});

test("the toolbar buttons match the measured Preview and Save", () => {
  const btn = rule(".se-btn");
  const ghost = rule(".se-btn.ghost");
  const raised = rule(".se-btn.raised");
  for (const [probe, own] of [[ref.previewButton, ghost], [ref.saveButton, raised]]) {
    assert.equal(own.width, `${probe.rect.w}px`);
    assert.equal(own.height ?? btn.height, `${probe.rect.h}px`);
    assert.equal(btn["border-radius"], probe.style.borderRadius);
    assert.equal(btn["font-size"], probe.style.fontSize);
    assert.equal(btn["font-weight"], probe.style.fontWeight);
    assert.equal(btn["letter-spacing"], probe.style.letterSpacing);
    assert.equal(btn["text-transform"], probe.style.textTransform);
  }
  assert.equal(rgb(ghost.color), ref.previewButton.style.color);
  assert.equal(resolve(ghost.border).replace(/#\w+/, (hex) => rgb(hex)), ref.previewButton.style.borderTop);
  assert.equal(rgb(raised.background), ref.saveButton.style.backgroundColor);
});

test("the sidebar and canvas sit where the editor puts them", () => {
  const sidebar = rule(".se-sidebar");
  assert.equal(sidebar.width, `${ref.sidebar.rect.w}px`);
  assert.equal(sidebar.top, `${ref.sidebar.rect.y}px`);
  for (const selector of [".se-canvas", ".se-hud-canvas"]) {
    const canvas = rule(selector);
    assert.equal(canvas.top, `${ref.canvas.rect.y}px`, selector);
    assert.equal(canvas.left, `${ref.canvas.rect.x}px`, selector);
  }
});

test("the editor colors match the measured ones", () => {
  assert.equal(rgb(vars.background), ref.editorBackground.style.backgroundColor);
  assert.equal(rgb(rule(".se-canvas").background), ref.editorBackground.style.backgroundColor);
  assert.equal(rgb(vars["--se-header"]), ref.groupHeader.style.backgroundColor);
  assert.equal(rgb(vars["--se-slider"]), ref.sliderTrackFill.style.backgroundColor);
  assert.equal(rgb(vars["--se-slider"]), ref.sliderThumb.after.backgroundColor);
});

test("the color swatch checkerboard matches the editor's", () => {
  const size = ref.colorPreview.backgroundSize.split(",")[0].trim();
  const swatches = page.match(/background-size: [^;]+; background-position: 0 0,4px 4px;/g) ?? [];
  assert.ok(swatches.length > 0, "the replica draws no checkerboard");
  for (const swatch of swatches) assert.ok(swatch.startsWith(`background-size: ${size};`), swatch);
});
