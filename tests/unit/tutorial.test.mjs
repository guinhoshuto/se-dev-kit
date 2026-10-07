import assert from "node:assert/strict";
import {fileURLToPath} from "node:url";
import test from "node:test";

import {normalizeFields} from "../../dist/config/fields.js";
import {recipeSchema} from "../../dist/config/schemas.js";
import {compileTutorial} from "../../dist/tutorial/timeline.js";
import {stillFrameIndex, tutorialStillNames} from "../../dist/tutorial/variant.js";
import {planRecipe} from "../../dist/capture/renderer.js";
import {loadProject} from "../../dist/config/load.js";

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

test("a still step takes no time and records where the timeline is", () => {
  const steps = [{action: "wait", ms: 400}, {action: "selectLayer"}, {action: "openGroup", group: "Colors"}];
  const plain = compile(steps);
  const withStills = compile([{action: "still", name: "start"}, steps[0], {action: "still", name: "before-layer"}, steps[1], steps[2], {action: "still", name: "colors", camera: "full"}]);
  assert.equal(withStills.endMs, plain.endMs);
  assert.deepEqual(withStills.patches, plain.patches);
  assert.deepEqual(withStills.moves, plain.moves);
  assert.deepEqual(withStills.stills, [
    {name: "start", atMs: 0, camera: "video"},
    {name: "before-layer", atMs: 400, camera: "video"},
    {name: "colors", atMs: plain.endMs, camera: "full"}
  ]);
  assert.deepEqual(plain.stills, []);
});

test("still names are safe, unique file-name ids, and only a tutorial video has them", () => {
  const video = (steps, extra = {}) => ({enabled: true, mode: "tutorial", durationMs: 5000, fps: 30, tutorial: {steps}, ...extra});
  assert.deepEqual(tutorialStillNames(video([{action: "still", name: "panel"}, {action: "wait", ms: 1}, {action: "still", name: "colors-open"}])), ["panel", "colors-open"]);
  assert.throws(() => tutorialStillNames(video([{action: "still", name: "Panel"}])), (error) => error.code === "INVALID_ID");
  assert.throws(() => tutorialStillNames(video([{action: "still", name: "../x"}])), (error) => error.code === "INVALID_ID");
  assert.throws(
    () => tutorialStillNames(video([{action: "still", name: "a"}, {action: "still", name: "a"}])),
    (error) => error.code === "TUTORIAL_STILL_DUPLICATE"
  );
  assert.deepEqual(tutorialStillNames(video([{action: "still", name: "a"}], {enabled: false})), []);
  assert.deepEqual(tutorialStillNames(undefined), []);
  const recipe = {schemaVersion: 1, id: "r", name: "R", scenes: ["s"], outputs: {screenshots: false, video: video([{action: "still", name: "a"}])}};
  assert.equal(recipeSchema.safeParse(recipe).success, true);
  recipe.outputs.video.tutorial.steps = [{action: "still", name: "a", camera: "full"}];
  assert.equal(recipeSchema.safeParse(recipe).success, true);
  for (const steps of [[{action: "still"}], [{action: "still", name: "Colors Open"}], [{action: "still", name: "a--b"}], [{action: "still", name: "a", camera: "zoom"}]]) {
    recipe.outputs.video.tutorial.steps = steps;
    assert.equal(recipeSchema.safeParse(recipe).success, false, JSON.stringify(steps));
  }
});

test("a still is the first frame at or after its step, or the last frame", () => {
  // At 30 fps, frame 12 is at 400 ms and frame 13 at 433 ms.
  assert.equal(stillFrameIndex(0, 30, 450), 0);
  assert.equal(stillFrameIndex(400, 30, 450), 12);
  assert.equal(stillFrameIndex(401, 30, 450), 13);
  assert.equal(stillFrameIndex(433, 30, 450), 13);
  assert.equal(stillFrameIndex(434, 30, 450), 14);
  assert.equal(stillFrameIndex(1250, 2, 30), 3);
  assert.equal(stillFrameIndex(15000, 30, 450), 449);
});

test("the plan lists one PNG per still next to the video and counts its bytes", async () => {
  const project = await loadProject({inputDirectory: fileURLToPath(new URL("../../examples/basic-chat/", import.meta.url))});
  const recipe = structuredClone(project.recipes.find((item) => item.id === "listing-tutorial").value);
  const {plan: before} = await planRecipe(project, recipe, {ffmpegPath: "/usr/bin/true", ffprobePath: "/usr/bin/true"});
  recipe.outputs.video.tutorial.steps.splice(4, 0, {action: "still", name: "content-open"});
  recipe.outputs.video.tutorial.steps.push({action: "still", name: "chat"});
  const {plan} = await planRecipe(project, recipe, {ffmpegPath: "/usr/bin/true", ffprobePath: "/usr/bin/true"});
  const stills = plan.targets.filter((target) => /-still-/.test(target));
  // In step order: the added one with Content open, the example's own with Colors open, the added last one.
  assert.deepEqual(stills.map((target) => target.split("/").slice(-2).join("/")), [
    `listing-tutorial/${plan.variants[0].id}-still-content-open.png`,
    `listing-tutorial/${plan.variants[0].id}-still-colors-open.png`,
    `listing-tutorial/${plan.variants[0].id}-still-chat.png`
  ]);
  assert.equal(plan.totalTargets, before.totalTargets + 2);
  // Each still is a full-HD tutorial frame at the frame rate, kept after the frames are discarded.
  const still = Math.ceil((1920 * 1080 * plan.estimate.bytesPerPixel.frame * 1000) / 1000);
  assert.equal(plan.estimate.variants[0].persistentBytes, before.estimate.variants[0].persistentBytes + 2 * still);
  assert.equal(plan.estimate.finalBytes, before.estimate.finalBytes + 2 * still);
});

// SDK-23: button fields and media fields as the StreamElements editor has them.
const { widgetButtonEvent, widgetButtonValue } = await import("../../dist/studio-ui/widget-button.js");
const { tutorialSchema } = await import("../../dist/config/schemas.js");

const buttonFields = [
  {id: "spin", label: "Spin the wheel", type: "button", group: "Actions", value: "go", options: [], definition: {type: "button", value: "go"}, editable: true},
  {id: "docs", label: "Docs", type: "button", group: "Actions", value: "", options: [], definition: {type: "button", openUrl: "https://example.test/docs"}, editable: true},
  {id: "note", label: "Note", type: "text", group: "Actions", value: "x", options: [], definition: {}, editable: true}
];

function compileButtons(steps, data = {}) {
  return compileTutorial({tutorial: {steps}, fields: buttonFields, fieldData: data, channel: "streamer"});
}

test("the button event has the StreamElements editor's shape: event:test carrying field, value, and widget-button", () => {
  // Captured on a test overlay on 2026-10-05: the widget's onEventReceived detail.
  assert.deepEqual(widgetButtonEvent("probe", "probe-value"), {
    listener: "event:test",
    event: {field: "probe", value: "probe-value", listener: "widget-button"}
  });
  assert.equal(widgetButtonValue({spin: ""}, {id: "spin", value: "go"}), "", "a saved value wins, even when empty");
  assert.equal(widgetButtonValue({spin: false}, {id: "spin", value: "go"}), false);
  assert.equal(widgetButtonValue({}, {id: "spin", value: "go"}), "go", "without a saved value, the FIELDS value");
  assert.equal(widgetButtonValue({}, {id: "spin", value: undefined}), null);
});

test("pressButton opens the group, presses the button, and sends the button event at the press", () => {
  const timeline = compileButtons([{action: "pressButton", field: "spin"}], {spin: "saved"});
  assert.ok(timeline.patches.some(({patch}) => patch.openGroup === "Actions"), "the Actions group opens first");
  const move = timeline.moves.at(-1);
  assert.equal(move.to, "field:spin");
  const press = timeline.presses.at(-1);
  assert.equal(press.downMs, move.endMs);
  assert.ok(timeline.patches.some(({atMs, patch}) => atMs === press.downMs && patch.pressed === "field:spin"));
  assert.deepEqual(timeline.widget, [{
    atMs: press.downMs,
    kind: "dispatch",
    listener: "event:test",
    event: {field: "spin", value: "saved", listener: "widget-button"}
  }]);
  assert.deepEqual(timeline.cues.at(-1), {kind: "reveal", site: "field:spin", atMs: press.downMs});
  assert.equal(compileButtons([{action: "pressButton", field: "spin"}]).widget[0].event.value, "go");
});

test("pressButton refuses a non-button field and an openUrl button, and setField on a button points to pressButton", () => {
  assert.throws(() => compileButtons([{action: "pressButton", field: "note"}]), (error) => error.code === "TUTORIAL_FIELD_NOT_BUTTON");
  assert.throws(() => compileButtons([{action: "pressButton", field: "docs"}]), (error) => error.code === "TUTORIAL_BUTTON_OPENS_URL" && error.message.includes("https://example.test/docs"));
  assert.throws(() => compileButtons([{action: "pressButton", field: "missing"}]), (error) => error.code === "TUTORIAL_FIELD_NOT_FOUND");
  assert.throws(
    () => compileButtons([{action: "setField", field: "spin", value: "x"}]),
    (error) => error.code === "TUTORIAL_FIELD_UNSUPPORTED" && /pressButton/.test(error.hint ?? "")
  );
  assert.equal(tutorialSchema.safeParse({steps: [{action: "pressButton", field: "spin"}]}).success, true);
  assert.equal(tutorialSchema.safeParse({steps: [{action: "pressButton", field: "spin", value: 1}]}).success, false);
});

const mediaFields = [
  {id: "avatar", label: "Avatar", type: "image-input", group: "Media", value: "", options: [], definition: {type: "image-input"}, editable: true},
  {id: "clip", label: "Clip", type: "video-input", group: "Media", value: "", options: [], definition: {type: "video-input"}, editable: true},
  {id: "gallery", label: "Gallery", type: "image-input", group: "Media", value: [], options: [], definition: {type: "image-input", multiple: true}, editable: true}
];
const samples = [
  {reference: "sws-sample:gallery/streamer-1.jpg", kind: "gallery"},
  {reference: "sws-sample:avatars/pixel-1.png", kind: "avatar"},
  {reference: "sws-sample:avatars/pixel-2.png", kind: "avatar"},
  {reference: "sws-sample:clips/neon-road.webm", kind: "clip"}
];

function compileMedia(steps, data = {avatar: "sws-sample:avatars/pixel-1.png", clip: "", gallery: []}) {
  return compileTutorial({tutorial: {steps}, fields: mediaFields, fieldData: data, channel: "streamer", samples});
}

test("setField on a media field sets it from the asset manager: Change, hover the asset, Submit, then the value", () => {
  const value = "sws-sample:avatars/pixel-2.png";
  const timeline = compileMedia([{action: "setField", field: "avatar", value}]);
  const targets = timeline.moves.map((move) => move.to);
  assert.deepEqual(targets.slice(-3), ["media-set:avatar", "asset-tile:0", "asset-submit:0"]);
  assert.equal(targets.includes("field:avatar"), false, "a media value is never typed");
  assert.equal(timeline.patches.some(({patch}) => patch.focusField === "avatar"), false);
  assert.equal(timeline.cues.some((cue) => cue.kind === "typing"), false);

  const setPress = timeline.presses.at(-2);
  const submitPress = timeline.presses.at(-1);
  const dialogs = timeline.patches.filter(({patch}) => "assetDialog" in patch);
  const opened = dialogs[0];
  // The dialog opens from the click and closes in $mdDialog's 400ms; the value commits when it is gone.
  assert.equal(opened.patch.assetDialog.openedAtMs, setPress.downMs + 90);
  assert.equal(opened.patch.assetDialog.mode, "images");
  assert.equal(opened.patch.assetDialog.tiles[0], value, "the asset being set leads the grid");
  assert.deepEqual(
    [...opened.patch.assetDialog.tiles].sort(),
    ["sws-sample:avatars/pixel-1.png", "sws-sample:avatars/pixel-2.png", "sws-sample:gallery/streamer-1.jpg"],
    "an image field lists the image samples, never the clips"
  );
  const hovered = dialogs.find(({patch}) => patch.assetDialog?.hover === 0);
  assert.ok(hovered && hovered.atMs < submitPress.downMs, "the tile is hovered before Submit is pressed");
  const submitted = dialogs.find(({patch}) => patch.assetDialog?.submitAtMs !== null && patch.assetDialog?.submitAtMs !== undefined);
  assert.equal(submitted.patch.assetDialog.submitAtMs, submitPress.downMs);
  const closing = dialogs.find(({patch}) => patch.assetDialog?.closedAtMs !== null && patch.assetDialog?.closedAtMs !== undefined);
  const closed = dialogs.at(-1);
  assert.equal(closed.patch.assetDialog, null);
  assert.equal(closed.atMs, closing.patch.assetDialog.closedAtMs + 400);
  assert.deepEqual(closed.patch.fieldValue, {id: "avatar", value});
  assert.deepEqual(timeline.widget, [{atMs: closed.atMs, kind: "fields", fieldData: {avatar: value}}]);
  assert.ok(timeline.cues.some((cue) => cue.kind === "assets" && cue.field === "avatar" && cue.startMs === opened.atMs && cue.endMs === closed.atMs));
  assert.deepEqual(timeline.media[value], {name: "pixel-2.png", sample: "avatars/pixel-2.png"});
});

test("a video field lists the clips, a value of the widget's own joins the grid, and an empty value presses Clear", () => {
  const clip = compileMedia([{action: "setField", field: "clip", value: "sws-sample:clips/neon-road.webm"}]);
  const clipDialog = clip.patches.find(({patch}) => patch.assetDialog).patch.assetDialog;
  assert.equal(clipDialog.mode, "videos");
  assert.deepEqual(clipDialog.tiles, ["sws-sample:clips/neon-road.webm"]);

  const own = compileMedia([{action: "setField", field: "avatar", value: "assets/me.png"}]);
  const ownDialog = own.patches.find(({patch}) => patch.assetDialog).patch.assetDialog;
  assert.equal(ownDialog.tiles[0], "assets/me.png");
  assert.equal(ownDialog.tiles.length, 4);
  assert.deepEqual(own.media["assets/me.png"], {name: "me.png", sample: null});

  const cleared = compileMedia([{action: "setField", field: "avatar", value: ""}]);
  assert.equal(cleared.moves.at(-1).to, "media-clear:avatar");
  assert.equal(cleared.patches.some(({patch}) => "assetDialog" in patch), false);
  assert.deepEqual(cleared.widget.at(-1).fieldData, {avatar: ""});
});

test("setField refuses a media field that holds a list", () => {
  assert.throws(
    () => compileMedia([{action: "setField", field: "gallery", value: "sws-sample:avatars/pixel-1.png"}]),
    (error) => error.code === "TUTORIAL_FIELD_UNSUPPORTED" && /multiple/.test(error.message)
  );
});
