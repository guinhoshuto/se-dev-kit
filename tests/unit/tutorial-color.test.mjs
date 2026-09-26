import assert from "node:assert/strict";
import test from "node:test";

import {formatColor, hsvToRgb, needsDarkText, parseColor, rgbToHsv} from "../../dist/tutorial/color.js";
import {compileTutorial} from "../../dist/tutorial/timeline.js";

const fields = [
  {id: "title", label: "Title", type: "text", group: "Content", value: "Hello", options: [], definition: {}, editable: true},
  {id: "accent", label: "Accent", type: "colorpicker", group: "Colors", value: "#72f1b8", options: [], definition: {}, editable: true}
];

function compile(steps, accent = "#72f1b8") {
  return compileTutorial({tutorial: {steps}, fields, fieldData: {title: "Hello", accent}, channel: "streamer"});
}

function pickerStates(timeline) {
  return timeline.patches.filter((entry) => entry.patch.colorPicker).map((entry) => ({atMs: entry.atMs, ...entry.patch.colorPicker}));
}

function hex({r, g, b}) {
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

const SAMPLES = [
  "#000000", "#ffffff", "#808080", "#7f7f7f", "#010101", "#fefefe", "#0d1222",
  "#ff0000", "#00ff00", "#0000ff", "#ffff00", "#00ffff", "#ff00ff",
  "#ff7ad9", "#72f1b8", "#5787dc", "#cfc7ff", "#5c4fb0", "#b5f6d2", "#fcfaff", "#800000", "#008080"
];

test("hex to HSV and back is exact for grays, saturated, and arbitrary colors", () => {
  for (const value of SAMPLES) assert.equal(hex(hsvToRgb(rgbToHsv(parseColor(value)))), value, value);
  const channels = [...Array.from({length: 37}, (_, index) => index * 7), 255];
  for (const r of channels) {
    for (const g of channels) {
      for (const b of channels) {
        const back = hsvToRgb(rgbToHsv({r, g, b}));
        assert.ok(back.r === r && back.g === g && back.b === b, `rgb(${r}, ${g}, ${b}) -> ${JSON.stringify(back)}`);
      }
    }
  }
});

test("HSV follows md-color-picker's spectrum and hue strip conventions", () => {
  assert.deepEqual(rgbToHsv(parseColor("#000000")), {h: 0, s: 0, v: 0});
  assert.deepEqual(rgbToHsv(parseColor("#ffffff")), {h: 0, s: 0, v: 1});
  assert.equal(rgbToHsv(parseColor("#808080")).s, 0);
  assert.equal(rgbToHsv(parseColor("#ff0000")).h, 0);
  assert.equal(rgbToHsv(parseColor("#ff00ff")).h, 300);
  // The hue strip runs from h = 360 at the top to 0 at the bottom; magenta sits on the 16.7% stop.
  assert.ok(Math.abs(255 * (1 - 300 / 360) - 0.167 * 255) < 0.2);
  assert.deepEqual(hsvToRgb({h: 360, s: 1, v: 1}), {r: 255, g: 0, b: 0});
  assert.equal(needsDarkText(parseColor("#72f1b8")), true);
  assert.equal(needsDarkText(parseColor("#0d1222")), false);
  assert.equal(needsDarkText(parseColor("rgba(0, 0, 0, 0.3)")), true);
});

test("color parsing accepts hex and rgb()/rgba() and formats in the requested notation", () => {
  assert.deepEqual(parseColor("#abc"), {r: 170, g: 187, b: 204, a: 1});
  assert.deepEqual(parseColor("#aabbcc80"), {r: 170, g: 187, b: 204, a: 128 / 255});
  assert.deepEqual(parseColor("rgba(1, 2, 3, 0.5)"), {r: 1, g: 2, b: 3, a: 0.5});
  assert.deepEqual(parseColor("rgb(255,122,217)"), {r: 255, g: 122, b: 217, a: 1});
  for (const invalid of ["banana", "#12345", "rgb(256, 0, 0)", "rgba(1, 2, 3)", "rgb(1, 2, 3, 0.5)", "rgba(1, 2, 3, 2)", "", "red"]) {
    assert.equal(parseColor(invalid), undefined, invalid);
  }
  const color = {r: 255, g: 122, b: 217, a: 1};
  assert.equal(formatColor(color, "#00aa00"), "#ff7ad9");
  assert.equal(formatColor(color, "#00AA00"), "#FF7AD9");
  assert.equal(formatColor({...color, a: 0.5}, "#00aa0080"), "#ff7ad980");
  assert.equal(formatColor(color, "rgb(0, 0, 0)"), "rgb(255, 122, 217)");
  assert.equal(formatColor({...color, a: 0.5}, "rgb(0, 0, 0)"), "rgba(255, 122, 217, 0.5)");
});

test("a colorpicker step clicks the swatch, drags hue then spectrum, and confirms with Select", () => {
  const timeline = compile([{action: "setField", field: "accent", value: "#ff00aa"}], "#000000");
  assert.deepEqual(timeline.moves.map((move) => move.to), [
    "layer",
    "section:settings",
    "group:Colors",
    "swatch:accent",
    "picker:hue",
    "picker:grab",
    "picker:spectrum",
    "picker:select"
  ]);
  const values = timeline.patches.filter((entry) => entry.patch.fieldValue?.id === "accent");
  assert.equal(values.length, 1, "the field changes once, when Select commits it; nothing is typed");
  assert.equal(values[0].patch.fieldValue.value, "#ff00aa");
  assert.equal(values[0].patch.colorPicker, null, "the dialog is gone when the value lands");
  assert.equal(timeline.patches.some((entry) => entry.patch.focusField === "accent" || entry.patch.selectAll === "accent"), false);
  const commit = timeline.widget.find((action) => action.kind === "fields");
  assert.deepEqual(commit.fieldData, {accent: "#ff00aa"});
  assert.equal(commit.atMs, values[0].atMs);
  const states = pickerStates(timeline);
  const selectMove = timeline.moves.find((move) => move.to === "picker:select");
  const selectPress = timeline.clicks.find((clickMs) => clickMs >= selectMove.endMs);
  assert.ok(states[0].openedAtMs > timeline.moves.find((move) => move.to === "swatch:accent").endMs);
  assert.ok(states.every((state) => state.openedAtMs === states[0].openedAtMs));
  assert.ok(states[0].openedAtMs < selectPress && selectPress < states.at(-1).closedAtMs);
  const hueMove = timeline.moves.find((move) => move.to === "picker:hue");
  assert.ok(hueMove.startMs - (states[0].openedAtMs + 400) >= 450, "the cursor rests on the open dialog before dragging");
  assert.equal(states.at(-1).hoverAtMs, selectMove.endMs, "Select turns hovered when the cursor arrives on it");
  assert.ok(states.every((state) => state.hoverAtMs === null || state.atMs >= selectMove.endMs));
  assert.ok(selectPress - selectMove.endMs >= 150, "the cursor rests on the hovered Select before pressing");
  assert.equal(commit.atMs, states.at(-1).closedAtMs + 400, "md-color-picker writes the model when the 400ms close ends");
  assert.ok(states.every((state) => state.atMs < commit.atMs));
});

for (const value of ["#ff7ad9", "#FF7AD9"]) {
  test(`the picker settles exactly on the requested ${value} and commits it unchanged`, () => {
    const timeline = compile([{action: "setField", field: "accent", value}]);
    const states = pickerStates(timeline);
    for (const state of states) {
      assert.ok(state.h >= 0 && state.h <= 360, `hue ${state.h}`);
      for (const key of ["s", "v", "a"]) assert.ok(state[key] >= 0 && state[key] <= 1, `${key} ${state[key]}`);
      assert.match(state.text, value === value.toLowerCase() ? /^#[0-9a-f]{6}$/ : /^#[0-9A-F]{6}$/);
    }
    const hue = states.filter((state) => state.drag === "hue").map((state) => state.h);
    assert.ok(hue.length > 5);
    assert.ok(hue.every((h, index) => index === 0 || h >= hue[index - 1]), "the hue marker moves one way");
    assert.equal(hue.at(-1), rgbToHsv(parseColor(value)).h);
    const spectrum = states.filter((state) => state.drag === "spectrum");
    assert.ok(spectrum.length > 3);
    for (const key of ["s", "v"]) {
      const series = spectrum.map((state) => state[key]);
      const rising = series.at(-1) >= series[0];
      assert.ok(series.every((item, index) => index === 0 || (rising ? item >= series[index - 1] : item <= series[index - 1])), key);
    }
    const final = states.at(-1);
    assert.equal(final.text, value);
    assert.deepEqual(final.rgb, {r: 255, g: 122, b: 217});
    assert.ok(final.closedAtMs !== null);
    const review = states.find((state) => state.text === value);
    assert.ok(review && review.atMs < final.selectAtMs, "the header shows the exact value before Select is pressed");
    assert.equal(timeline.widget.find((action) => action.kind === "fields").fieldData.accent, value);
    assert.equal(timeline.patches.findLast((entry) => entry.patch.fieldValue?.id === "accent").patch.fieldValue.value, value);
  });
}

for (const [value, accent] of [
  ["#abc", "#72f1b8"],
  ["#000", "#72f1b8"],
  ["rgb(255,0,170)", "#72f1b8"],
  ["rgba(10, 20, 30, .333)", "#72f1b8"],
  ["#ABCDEF80", "rgb(1, 2, 3)"]
]) {
  test(`the header shows the exact ${value} before Select, whatever notation the drags used`, () => {
    const timeline = compile([{action: "setField", field: "accent", value}], accent);
    const states = pickerStates(timeline);
    const selectAtMs = states.at(-1).selectAtMs;
    assert.ok(states.some((state) => state.text === value && state.atMs < selectAtMs), `no header state reads ${value} before Select`);
    assert.ok(states.filter((state) => state.atMs >= selectAtMs).every((state) => state.text === value));
    assert.equal(timeline.widget.find((action) => action.kind === "fields").fieldData.accent, value);
  });
}

test("the picker skips the strips a color does not need and drags alpha only when opacity changes", () => {
  const targetsFor = (value, accent) =>
    compile([{action: "setField", field: "accent", value}], accent).moves.map((move) => move.to).filter((to) => /^(swatch|picker):/.test(to));
  assert.deepEqual(targetsFor("#808080", "#72f1b8"), ["swatch:accent", "picker:grab", "picker:spectrum", "picker:select"]);
  assert.deepEqual(targetsFor("#72f1b8", "#72f1b8"), ["swatch:accent", "picker:select"]);
  assert.deepEqual(targetsFor("#72F1B8", "#72f1b8"), ["swatch:accent", "picker:select"]);
  assert.deepEqual(targetsFor("#72f1b880", "#72f1b8"), ["swatch:accent", "picker:alpha", "picker:select"]);
  assert.deepEqual(targetsFor("rgba(114, 241, 184, 0.25)", "#72f1b8"), ["swatch:accent", "picker:alpha", "picker:select"]);
  const alpha = compile([{action: "setField", field: "accent", value: "#ff00aa80"}]);
  const final = pickerStates(alpha).at(-1);
  assert.equal(final.text, "#ff00aa80");
  assert.ok(Math.abs(final.a - 128 / 255) < 1e-9);
  const rgba = pickerStates(compile([{action: "setField", field: "accent", value: "rgba(255, 0, 170, 0.5)"}]));
  assert.equal(rgba[0].tab, "rgb");
  assert.equal(rgba.at(-1).text, "rgba(255, 0, 170, 0.5)");
});

test("red is reached through the nearer end of the hue strip", () => {
  const states = pickerStates(compile([{action: "setField", field: "accent", value: "#ff0000"}], "#ff0033"));
  const hue = states.filter((state) => state.drag === "hue").map((state) => state.h);
  assert.ok(hue.length > 0 && hue.every((h) => h > 340), "the marker goes up to the top red, not down across the strip");
  assert.equal(states.at(-1).h, 360);
  assert.deepEqual(states.at(-1).rgb, {r: 255, g: 0, b: 0});
});

test("a colorpicker edit takes a person's pace and compiles deterministically", () => {
  const steps = [{action: "selectLayer"}, {action: "setField", field: "accent", value: "#ff7ad9"}];
  const timeline = compile(steps);
  assert.deepEqual(compile(steps), timeline);
  const start = timeline.moves.find((move) => move.to === "swatch:accent").startMs;
  const commit = timeline.widget.find((action) => action.kind === "fields").atMs;
  assert.ok(commit - start >= 3500 && commit - start <= 6000, `color edit took ${commit - start}ms`);
  assert.throws(() => compile([{action: "setField", field: "accent", value: 42}]), /expects a color/);
});
