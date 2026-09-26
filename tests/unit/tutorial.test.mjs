import assert from "node:assert/strict";
import test from "node:test";

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
    ["title", "opacity", "style", "stamps", "message", "tip-latest"]
  );
  const times = first.widget.map((action) => action.atMs);
  assert.deepEqual([...times].sort((left, right) => left - right), times);
  assert.ok(first.endMs >= times.at(-1));
  assert.equal(first.chrome.chat.enabled, true);
});

test("setField opens the layer, the Settings section, and the field group before editing", () => {
  const timeline = compile([{action: "setField", field: "accent", value: "#ff00aa"}]);
  const targets = timeline.moves.map((move) => move.to);
  assert.deepEqual(targets, ["layer", "section:settings", "group:Colors", "field:accent"]);
  const typed = timeline.patches.filter((entry) => entry.patch.fieldValue?.id === "accent").map((entry) => entry.patch.fieldValue.value);
  assert.equal(typed.at(-1), "#ff00aa");
  assert.ok(typed.includes("#ff"), "the hex value is typed character by character");
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
  assert.throws(
    () => compile([{action: "chat", user: "A", text: "b"}], {chat: {enabled: false}}),
    /chat\.enabled is false/
  );
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
