import assert from "node:assert/strict";
import test from "node:test";

import {normalizeFields} from "../../dist/config/fields.js";
import {recipeSchema} from "../../dist/config/schemas.js";
import {compileTutorial} from "../../dist/tutorial/timeline.js";

const fields = [
  {id: "title", label: "Title", type: "text", group: "Content", value: "Hello", options: [], definition: {}, editable: true},
  {id: "accent", label: "Accent", type: "colorpicker", group: "Colors", value: "#000000", options: [], definition: {}, editable: true},
  {id: "opacity", label: "Opacity", type: "slider", group: "Colors", value: 50, min: 0, max: 100, step: 1, options: [], definition: {}, editable: true},
  {
    id: "style",
    label: "Style",
    type: "dropdown",
    group: "Layout",
    value: "a",
    options: [{label: "A", value: "a"}, {label: "B", value: "b"}],
    definition: {},
    editable: true
  },
  {id: "stamps", label: "Timestamps", type: "checkbox", value: true, options: [], definition: {}, editable: true},
  {id: "secret", label: "Secret", type: "hidden", value: "x", options: [], definition: {}, editable: false}
];

const fieldData = {title: "Hello", accent: "#000000", opacity: 50, style: "a", stamps: true, secret: "x"};

function compile(steps, extra = {}) {
  return compileTutorial({tutorial: {steps, ...extra}, fields, fieldData, channel: "streamer"});
}

test("tutorial compilation is deterministic and orders widget actions in time", () => {
  const steps = [
    {action: "setField", field: "title", value: "Hi"},
    {action: "setField", field: "accent", value: "#ff7ad9"},
    {action: "setField", field: "opacity", value: 80},
    {action: "setField", field: "style", value: "b"},
    {action: "setField", field: "stamps", value: false},
    {action: "chat", user: "Mira", text: "hello"},
    {action: "emulate", event: "tip", option: "$50", name: "Nova"}
  ];
  const first = compile(steps);
  assert.deepEqual(compile(steps), first);
  assert.deepEqual(first.groups, ["Content", "Colors", "Layout", "General"]);
  assert.equal(first.fields.some((field) => field.id === "secret"), false);
  assert.deepEqual(
    first.widget.map((action) => action.kind === "fields" ? Object.keys(action.fieldData)[0] : action.listener),
    ["title", "accent", "opacity", "style", "stamps", "message", "tip-latest"]
  );
  const times = first.widget.map((action) => action.atMs);
  assert.deepEqual([...times].sort((left, right) => left - right), times);
  assert.ok(first.endMs >= times.at(-1));
  assert.equal(first.chrome.chat.enabled, true);
});

test("setField opens the layer, the Settings section, and the field group before editing", () => {
  const timeline = compile([{action: "setField", field: "title", value: "Hey"}]);
  const targets = timeline.moves.map((move) => move.to);
  assert.deepEqual(targets, ["layer", "section:settings", "group:Content", "field:title"]);
  const typed = timeline.patches.filter((entry) => entry.patch.fieldValue?.id === "title").map((entry) => entry.patch.fieldValue.value);
  assert.equal(typed.at(-1), "Hey");
  assert.ok(typed.includes("He"), "text is typed character by character");
});

test("slider drags interpolate and finish exactly on the requested value", () => {
  const timeline = compile([{action: "setField", field: "opacity", value: 73}]);
  const values = timeline.patches.filter((entry) => entry.patch.fieldValue?.id === "opacity").map((entry) => entry.patch.fieldValue.value);
  assert.ok(values.length > 5);
  assert.equal(values.at(-1), 73);
  assert.ok(values.every((value) => value >= 50 && value <= 73));
});

test("emulate builds StreamElements-shaped payloads from the chosen submenu option", () => {
  const pick = (step) => compile([step]).widget[0];
  assert.deepEqual(pick({action: "emulate", event: "follower", name: "Nova"}), {
    atMs: pick({action: "emulate", event: "follower", name: "Nova"}).atMs,
    kind: "dispatch",
    listener: "follower-latest",
    event: {name: "Nova"}
  });
  assert.equal(pick({action: "emulate", event: "cheer", option: "5k"}).event.amount, 5000);
  assert.equal(pick({action: "emulate", event: "raid", option: "50"}).event.amount, 50);
  assert.equal(pick({action: "emulate", event: "subscriber", option: "Gift"}).event.gifted, true);
  assert.equal(pick({action: "emulate", event: "tip", amount: 7}).event.amount, 7);
  assert.equal(pick({action: "emulate", event: "tip", listener: "event", payload: {custom: true}}).listener, "event");
  assert.throws(() => compile([{action: "emulate", event: "tip", option: "Custom..."}]), /TUTORIAL_EMULATE_OPTION_INVALID|scripted option/);
});

test("chat steps dispatch message events with synthetic identities", () => {
  const timeline = compile([{action: "chat", user: "Nico", text: "gg", badges: ["moderator"], typed: true}]);
  const message = timeline.widget[0];
  assert.equal(message.listener, "message");
  assert.equal(message.event.data.displayName, "Nico");
  assert.equal(message.event.data.text, "gg");
  assert.equal(message.event.data.badges[0].type, "moderator");
  assert.match(message.event.data.badges[0].url, /^data:image\/svg\+xml;base64,/);
  assert.ok(timeline.moves.some((move) => move.to === "chat-input"));
  assert.ok(timeline.patches.some((entry) => entry.patch.chatDraft === "g"));
});

test("invalid tutorial references fail with actionable errors", () => {
  assert.throws(() => compile([{action: "setField", field: "missing", value: 1}]), /not a visible field/);
  assert.throws(() => compile([{action: "setField", field: "secret", value: "y"}]), /not a visible field/);
  assert.throws(() => compile([{action: "openGroup", group: "Nope"}]), /does not exist/);
  assert.throws(() => compile([{action: "setField", field: "style", value: "z"}]), /has no option/);
  assert.throws(() => compile([{action: "setField", field: "accent", value: "banana"}]), /expects a color/);
  assert.throws(
    () => compile([{action: "chat", user: "A", text: "b"}], {chat: {enabled: false}}),
    /chat\.enabled is false/
  );
});

test("setField types a family into a googleFont field, as FIELDS spells the type", () => {
  const {fields: fontFields, defaults} = normalizeFields({font: {type: "googleFont", label: "Font", value: "Roboto"}});
  const timeline = compileTutorial({
    tutorial: {steps: [{action: "setField", field: "font", value: "Unbounded"}]},
    fields: fontFields,
    fieldData: defaults,
    channel: "streamer"
  });
  assert.deepEqual(timeline.cues.filter((cue) => cue.kind === "typing").map((cue) => cue.region), ["field:font"]);
  assert.deepEqual(timeline.widget.filter((action) => action.kind === "fields").map((action) => action.fieldData), [{font: "Unbounded"}]);
});

test("recipe schema requires a tutorial script only in tutorial mode", () => {
  const recipe = (video) => ({
    schemaVersion: 1,
    id: "r",
    name: "R",
    scenes: ["s"],
    outputs: {screenshots: false, video: {enabled: true, durationMs: 5000, fps: 30, ...video}}
  });
  assert.equal(recipeSchema.safeParse(recipe({mode: "tutorial"})).success, false);
  assert.equal(recipeSchema.safeParse(recipe({tutorial: {steps: [{action: "wait", ms: 10}]}})).success, false);
  assert.equal(recipeSchema.safeParse(recipe({mode: "tutorial", tutorial: {steps: [{action: "wait", ms: 10}]}})).success, true);
  assert.equal(
    recipeSchema.safeParse(recipe({mode: "tutorial", tutorial: {steps: [{action: "click", target: "nowhere"}]}})).success,
    false
  );
});

test("presses record each release: clicks match presses, and slider and picker drags hold until they end", () => {
  const timeline = compile([
    {action: "setField", field: "title", value: "Hi"},
    {action: "setField", field: "accent", value: "#ff7ad9"},
    {action: "setField", field: "opacity", value: 80},
    {action: "setField", field: "style", value: "b"}
  ]);
  assert.deepEqual(timeline.clicks, timeline.presses.map((press) => press.downMs));
  const downs = timeline.presses.map((press) => press.downMs);
  assert.deepEqual([...downs].sort((left, right) => left - right), downs, "presses are sorted by downMs");
  const targetsAt = (press) => timeline.moves.filter((move) => move.endMs === press.downMs).map((move) => move.to);
  const dragOf = (target) => timeline.presses.find((press) => targetsAt(press).includes(target));
  const drags = ["field:opacity", "picker:hue", "picker:grab"];
  for (const press of timeline.presses) {
    if (drags.some((target) => targetsAt(press).includes(target))) continue;
    assert.equal(press.upMs, press.downMs, `a plain click at ${press.downMs} releases at once`);
  }
  const slider = dragOf("field:opacity");
  assert.equal(slider.upMs, slider.downMs + 900, "the slider is held for its 900 ms drag");
  const pickers = timeline.patches.filter((entry) => entry.patch.colorPicker).map((entry) => ({atMs: entry.atMs, ...entry.patch.colorPicker}));
  const hue = dragOf("picker:hue");
  const hueEnd = pickers.filter((state) => state.drag === "hue").at(-1).atMs;
  assert.ok(hueEnd > hue.downMs);
  assert.equal(hue.upMs, hueEnd, "the hue press ends with its drag");
  assert.ok(pickers.some((state) => state.atMs === hueEnd && state.drag === null), "the drag ends with a {drag: null} emit");
  const grab = dragOf("picker:grab");
  assert.equal(grab.upMs, pickers.filter((state) => state.drag === "spectrum").at(-1).atMs, "the spectrum press ends with its drag");
});

test("cues give the camera popups, typing, the toast, and widget reveals at exact times", () => {
  const timeline = compile([
    {action: "setField", field: "title", value: "Hi"},
    {action: "setField", field: "accent", value: "#ff7ad9"},
    {action: "setField", field: "style", value: "b"},
    {action: "chat", user: "Mira", text: "hello"},
    {action: "chat", user: "Me", text: "yo", typed: true},
    {action: "emulate", event: "tip", option: "$50", name: "Nova"},
    {action: "save"}
  ]);
  const patchTimes = (predicate) => timeline.patches.filter((entry) => predicate(entry.patch)).map((entry) => entry.atMs);
  const pressAfter = (target) => timeline.presses.find((press) => timeline.moves.some((move) => move.to === target && move.endMs === press.downMs)).downMs;
  const cue = (kind) => timeline.cues.filter((entry) => entry.kind === kind);
  const commit = (field) => timeline.widget.find((action) => action.kind === "fields" && field in action.fieldData).atMs;

  const [picker] = cue("picker");
  const opened = timeline.patches.find((entry) => entry.patch.colorPicker).patch.colorPicker.openedAtMs;
  assert.deepEqual(picker, {kind: "picker", field: "accent", startMs: opened, endMs: commit("accent")});
  assert.equal(patchTimes((patch) => patch.colorPicker === null).at(-1), commit("accent"));

  assert.deepEqual(cue("select"), [{
    kind: "select",
    field: "style",
    startMs: patchTimes((patch) => patch.select?.field === "style" && patch.select.hover === null)[0],
    endMs: patchTimes((patch) => patch.select === null)[0]
  }]);

  const menuOpen = patchTimes((patch) => patch.menu);
  assert.deepEqual(cue("menu"), [{kind: "menu", startMs: menuOpen[0], endMs: patchTimes((patch) => patch.menu === null)[0], probeMs: menuOpen.at(-1)}]);
  assert.ok(timeline.patches.find((entry) => entry.atMs === menuOpen.at(-1) && entry.patch.menu)?.patch.menu.hoverOption === 1, "the probe is the fullest menu: submenu open, $50 hovered");

  const toast = patchTimes((patch) => patch.toast === "Overlay saved")[0];
  assert.deepEqual(cue("toast"), [{kind: "toast", startMs: toast, endMs: toast + 2200}]);

  const dispatches = timeline.widget.filter((action) => action.kind === "dispatch");
  assert.deepEqual(cue("typing"), [
    {kind: "typing", region: "field:title", startMs: pressAfter("field:title"), endMs: patchTimes((patch) => patch.focusField === null)[0]},
    {kind: "typing", region: "chat-input", startMs: pressAfter("chat-input"), endMs: dispatches[1].atMs}
  ], "the untyped chat has no typing cue");

  assert.deepEqual(cue("reveal"), [
    {kind: "reveal", site: "field:title", atMs: commit("title")},
    {kind: "reveal", site: "field:accent", atMs: commit("accent")},
    {kind: "reveal", site: "field:style", atMs: commit("style")},
    {kind: "reveal", site: "chat-line", atMs: dispatches[0].atMs},
    {kind: "reveal", site: "chat-line", atMs: dispatches[1].atMs},
    {kind: "reveal", site: "emulate", atMs: dispatches[2].atMs}
  ]);
  const starts = timeline.cues.map((entry) => (entry.kind === "reveal" ? entry.atMs : entry.startMs));
  assert.deepEqual([...starts].sort((left, right) => left - right), starts, "cues are sorted by start time");
});

test("fixture events never create camera cues", () => {
  const fixture = {events: [{atMs: 100, listener: "message", event: {data: {displayName: "Fan", text: "hi"}}}]};
  const timeline = compileTutorial({tutorial: {steps: [{action: "wait", ms: 500}]}, fields, fieldData, channel: "streamer", fixture});
  assert.ok(timeline.patches.some((entry) => entry.patch.chatAppend?.text === "hi"));
  assert.deepEqual(timeline.cues, []);
});

test("a move works until the next move of its step, and the step's last move until the step ends", () => {
  const timeline = compile([{action: "setField", field: "title", value: "Hey"}, {action: "wait", ms: 1000}]);
  const [layer, settings, group, field] = timeline.moves;
  assert.equal(layer.workEndMs, settings.startMs);
  assert.equal(settings.workEndMs, group.startMs);
  assert.equal(group.workEndMs, field.startMs);
  assert.equal(field.workEndMs, timeline.endMs - 1000, "typing, the commit, and the pause after it belong to the field move");
  assert.ok(field.workEndMs > field.endMs);
});

test("autoZoom resolves to the close-up zoom, 1.8 by default, or null when off", () => {
  const step = [{action: "wait", ms: 10}];
  assert.deepEqual(compile(step).autoZoom, {zoom: 1.8});
  assert.deepEqual(compile(step, {autoZoom: true}).autoZoom, {zoom: 1.8});
  assert.deepEqual(compile(step, {autoZoom: {}}).autoZoom, {zoom: 1.8});
  assert.deepEqual(compile(step, {autoZoom: {zoom: 1.5}}).autoZoom, {zoom: 1.5});
  assert.equal(compile(step, {autoZoom: false}).autoZoom, null);
  assert.equal(compile(step, {autoZoom: false}).endMs, compile(step).endMs, "the camera adds no time");
});

test("the recipe schema accepts autoZoom as a switch or a zoom from 1.2 to 2.5", () => {
  const recipe = (autoZoom) => ({
    schemaVersion: 1,
    id: "r",
    name: "R",
    scenes: ["s"],
    outputs: {screenshots: false, video: {enabled: true, durationMs: 5000, fps: 30, mode: "tutorial", tutorial: {autoZoom, steps: [{action: "wait", ms: 10}]}}}
  });
  for (const value of [false, true, {}, {zoom: 1.2}, {zoom: 2.5}]) {
    assert.equal(recipeSchema.safeParse(recipe(value)).success, true, JSON.stringify(value));
  }
  for (const value of [{zoom: 1.1}, {zoom: 2.6}, {zoom: "2"}, {enabled: true}, "yes"]) {
    assert.equal(recipeSchema.safeParse(recipe(value)).success, false, JSON.stringify(value));
  }
});
