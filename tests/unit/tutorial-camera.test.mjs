import assert from "node:assert/strict";
import test from "node:test";

import {
  cameraAt,
  cameraTransform,
  captionOpacity,
  captionTop,
  cursorAt,
  planCamera,
  pointerScale,
  pointerStyle,
  ripple,
  transition
} from "../../dist/studio-ui/tutorial-camera.js";

// Thresholds below come from the requirements (docs/TUTORIAL.md, "Auto zoom and click pulse"),
// written as literals on purpose: they must not follow a change of the module's constants.

const rect = (x0, y0, x1, y1) => ({x0, y0, x1, y1});
// A view fills the frame the video exports (the whole stage, or the scene crop).
const heightOf = (plan, view) => (view.w * plan.frame.height) / plan.frame.width;
const zoomOf = (plan, view) => plan.frame.width / view.w;
const viewRect = (plan, view) => rect(view.x, view.y, view.x + view.w, view.y + heightOf(plan, view));
const inside = (inner, outer, tolerance) =>
  inner.x0 >= outer.x0 - tolerance && inner.y0 >= outer.y0 - tolerance && inner.x1 <= outer.x1 + tolerance && inner.y1 <= outer.y1 + tolerance;
const full = (W) => ({x: 0, y: 0, w: W});

/** Adds the camera fields to a list of cues written as {kind, startMs, endMs, frame, obstacle}. */
const cueOf = (kind, startMs, endMs, frame, obstacle = frame) => ({
  kind,
  startMs,
  endMs,
  rects: frame.map((r) => ({rect: r, obstacle: obstacle.includes(r)}))
});

/**
 * The basic-chat tutorial-setup script at 1920×1080 (uiScale 4/3, editor 1440×810), with rects
 * measured by hand from the editor CSS and the example FIELDS. approach = where the pointer heads
 * during a move; arrive = the target right after the click's patch; leave = where it ends a drag.
 * The sidebar scrolls 125 px to show the Layout header below the open Colors group (measured in
 * the replica); once Colors closes, the browser clamps that to 13 px, which lifts the Layout targets.
 */
function exampleInput(zoom) {
  const W = 1920;
  const H = 1080;
  const U = 4 / 3;
  const pt = (x, y) => ({x: x * U, y: y * U});
  const ed = (x0, y0, x1, y1) => rect(x0 * U, y0 * U, x1 * U, y1 * U);
  const T = {
    layer: [pt(110, 166)], "section:settings": [pt(110, 210), pt(110, 116)], "group:Content": [pt(110, 218)], "field:cardTitle": [pt(128, 290)],
    "group:Colors": [pt(110, 524), pt(110, 276)], "swatch:accentColor": [pt(28, 347)], "picker:hue": [pt(838, 300)], "picker:grab": [pt(700, 350)],
    "picker:spectrum": [pt(700, 330)], "picker:select": [pt(799, 603)], "field:panelOpacity": [pt(150, 493)], "group:Layout": [pt(110, 757), pt(110, 321)],
    "field:bubbleStyle": [pt(128, 393)], "option:bubbleStyle:1": [pt(128, 441)], "field:showTimestamps": [pt(28, 605)],
    "chat-input": [pt(1220, 738)], emulate: [pt(474, 764)], "menu:tip": [pt(534, 408)], "menu-option:tip:0": [pt(716, 408)], save: [pt(1370, 26)]
  };
  const LEAVE = {"picker:hue": pt(838, 180), "picker:spectrum": pt(760, 250), "field:panelOpacity": pt(202, 493)};
  const home = {x: W * 0.62, y: H * 0.58};
  const raw = [[600, 1250, "layer", 1710], [1710, 2360, "section:settings", 2620], [2620, 3270, "group:Content", 3650], [3650, 4300, "field:cardTitle", 6080],
    [6080, 6730, "group:Colors", 7110], [7110, 7760, "swatch:accentColor", 8750], [8750, 9200, "picker:hue", 10007], [10007, 10457, "picker:grab", 10457],
    [10457, 10457, "picker:spectrum", 11257], [11257, 11707, "picker:select", 12657], [12657, 13307, "field:panelOpacity", 14467], [14467, 15117, "group:Layout", 15497],
    [15497, 16147, "field:bubbleStyle", 16407], [16407, 16907, "option:bubbleStyle:1", 17307], [17307, 17957, "field:showTimestamps", 18217],
    [20617, 21267, "chat-input", 23637], [24437, 25087, "emulate", 25347], [25347, 25847, "menu:tip", 26067], [26067, 26487, "menu-option:tip:0", 26887], [27787, 28437, "save", 28697]];
  const moves = [];
  raw.forEach(([startMs, endMs, to, workEndMs], index) => {
    const approach = T[to][0];
    const arrive = T[to][1] ?? T[to][0];
    const from = index === 0 ? home : moves[index - 1].leave;
    moves.push({startMs, endMs, workEndMs, from, approach, arrive, leave: LEAVE[to] ?? arrive});
  });
  const WIDGET = ed(566, 63, 842, 473);
  const row = (y0, y1) => ed(0, y0, 320, y1);
  const chatLine = ed(1110, 640, 1430, 690);
  const dialog = ed(546, 182, 894, 628);
  const accentRow = row(317, 363);
  const selectList = ed(2, 391, 294, 480);
  const bubbleRow = row(383, 429);
  const menu = ed(432, 341, 796, 800);
  const cues = [
    cueOf("popup", 7850, 12397, [dialog, accentRow], [dialog]),
    cueOf("popup", 16147, 17047, [selectList, bubbleRow]),
    cueOf("popup", 25087, 26627, [menu]),
    cueOf("toast", 28437, 30637, [ed(344, 666, 520, 714)])
  ];
  for (const [atMs, site] of [[5820, row(270, 316)], [12397, accentRow], [14207, row(461, 527)], [17047, bubbleRow], [17957, row(603, 633)],
    [18217, chatLine], [19517, chatLine], [23237, chatLine], [26627, ed(432, 728, 516, 800)]]) cues.push(cueOf("reveal", atMs, atMs, [WIDGET, site]));
  cues.push(cueOf("typing", 4300, 5820, [row(270, 316)]));
  cues.push(cueOf("typing", 21267, 23237, [ed(1110, 718, 1430, 758)]));
  const captionWidth = (text) => Math.min(608.4, text.length * 14 + 48);
  const captionHeight = (text) => 28 + 29.7 * Math.ceil((text.length * 14) / 560);
  const texts = [[0, "Select the widget layer"], [2620, "Open a settings group and rename the card"], [6080, "Pick an accent color and tune the opacity"],
    [14467, "Choose a bubble style"], [18217, "Messages from chat show up instantly"], [24437, "Use Emulate to test alerts before going live"],
    [27787, "Save the overlay when you are done"], [30197, null]];
  const captions = [];
  texts.forEach(([startMs, text], index) => {
    if (text) captions.push({startMs, endMs: texts[index + 1]?.[0] ?? Infinity, width: captionWidth(text), height: captionHeight(text)});
  });
  return {width: W, height: H, uiScale: U, zoom, endMs: 30997, home, moves, cues, captions, editor: {width: 1440, height: 810, captionCenterX: 710}};
}

function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random timelines on four stage sizes; like compiled timelines, popups never overlap. */
function randomInput(seed, zoom) {
  const R = rng(seed);
  const sizes = [[1920, 1080, 4 / 3], [1280, 720, 1280 / 1440], [1080, 1920, 0.75], [3840, 2160, 2.6667]];
  const [W, H, U] = sizes[Math.floor(R() * sizes.length)];
  const rp = (margin = 0) => ({x: -margin + R() * (W + 2 * margin), y: -margin + R() * (H + 2 * margin)});
  const home = {x: W * 0.62, y: H * 0.58};
  const moves = [];
  let t = Math.floor(R() * 2000);
  const n = 3 + Math.floor(R() * 30);
  for (let index = 0; index < n; index += 1) {
    const span = R() < 0.1 ? 0 : [300, 450, 500, 650, 650, 650, 900, 1400, 2500][Math.floor(R() * 9)];
    const approach = rp(R() < 0.1 ? 200 : 0);
    const arrive = R() < 0.15 ? rp() : approach;
    const leave = R() < 0.2 ? {x: arrive.x + (R() - 0.5) * 300, y: arrive.y + (R() - 0.5) * 300} : arrive;
    const from = index === 0 ? home : moves[index - 1].leave;
    const startMs = t;
    const endMs = t + span;
    const work = R() < 0.3 ? Math.floor(R() * 2500) : Math.floor(R() * 400);
    const workEndMs = endMs + work;
    t = workEndMs + (R() < 0.25 ? Math.floor(R() * 4000) : 0);
    moves.push({startMs, endMs, workEndMs, from, approach, arrive, leave});
  }
  const endMs = t + 1000;
  const rr = (maxW, maxH) => {
    const w = 20 + R() * maxW;
    const h = 20 + R() * maxH;
    const x = R() * (W - w);
    const y = R() * (H - h);
    return rect(x, y, x + w, y + h);
  };
  const cues = [];
  const widget = rr(W * 0.4, H * 0.5);
  const k = Math.floor(R() * 8);
  for (let index = 0; index < k; index += 1) {
    const at = Math.floor(R() * endMs);
    const kind = ["popup", "reveal", "reveal", "typing", "toast"][Math.floor(R() * 5)];
    if (kind === "popup") {
      const a = rr(W * 0.4, H * 0.6);
      const b = rr(W * 0.2, H * 0.1);
      const end = at + 400 + Math.floor(R() * 4000);
      if (cues.some((cue) => cue.kind === "popup" && cue.startMs - 650 < end && cue.endMs + 650 > at)) continue;
      cues.push(cueOf(kind, at, end, [a, b], [a]));
    } else if (kind === "reveal") {
      const site = rr(W * 0.2, H * 0.1);
      cues.push(cueOf(kind, at, at, [widget, site]));
    } else if (kind === "typing") {
      const site = rr(W * 0.2, H * 0.06);
      cues.push(cueOf(kind, at, at + Math.floor(R() * 2000), [site]));
    } else {
      const site = rr(W * 0.1, H * 0.05);
      cues.push(cueOf(kind, at, at + 2200, [site]));
    }
  }
  const captions = [];
  let ct = 0;
  while (ct < endMs) {
    const length = 500 + Math.floor(R() * 6000);
    if (R() < 0.7) captions.push({startMs: ct, endMs: ct + length, width: 200 + R() * 400, height: [57.7, 87.4, 117.1][Math.floor(R() * 3)]});
    ct += length;
  }
  return {width: W, height: H, uiScale: U, zoom, endMs, home, moves, cues, captions};
}

/** A scene crop: the window the video exports, somewhere inside the stage. */
function randomFrame(seed, W, H) {
  const R = rng(seed * 7919 + 13);
  const width = Math.max(1, Math.round(W * (0.4 + 0.6 * R())));
  const height = Math.max(1, Math.round(H * (0.4 + 0.6 * R())));
  return {x: Math.floor(R() * (W - width + 1)), y: Math.floor(R() * (H - height + 1)), width, height};
}

/** The example at the three zooms the range allows, then random seeds 1–200 at each, then cropped scenes. */
function* plannedInputs() {
  for (const zoom of [1.2, 1.8, 2.5]) yield {label: `example at ${zoom}`, input: exampleInput(zoom)};
  for (let seed = 1; seed <= 200; seed += 1) {
    for (const zoom of [1.2, 1.8, 2.5]) yield {label: `seed ${seed} at ${zoom}`, input: randomInput(seed, zoom)};
  }
  for (let seed = 1; seed <= 60; seed += 1) {
    const input = randomInput(seed, 1.8);
    yield {label: `seed ${seed} cropped`, input: {...input, frame: randomFrame(seed, input.width, input.height)}};
  }
}

const PLANNED = [...plannedInputs()].map((entry) => ({...entry, plan: planCamera(entry.input)}));

test("the camera curve starts still, never goes back, and lands exactly at 1000 ms", () => {
  let previous = -Infinity;
  for (let time = -10; time <= 1010; time += 1) {
    const value = transition(time);
    assert.ok(value >= previous, `the curve goes back at ${time} ms: ${value} after ${previous}`);
    previous = value;
  }
  assert.equal(transition(0), 0);
  assert.equal(transition(1000), 1);
  assert.ok(transition(240) >= 0.49 && transition(240) <= 0.52, `half-way near 240 ms: ${transition(240)}`);
  assert.ok(transition(650) >= 0.94, `nearly landed at 650 ms: ${transition(650)}`);
  assert.ok(transition(10) < 0.01, `zero start velocity: ${transition(10)}`);
});

test("the camera at a time is the same whatever frames were evaluated before, at any frame rate", () => {
  const input = exampleInput(1.8);
  const plan = planCamera(input);
  const times = [];
  for (let time = 0; time <= input.endMs; time += 7) times.push(time);
  const ascending = new Map(times.map((time) => [time, cameraAt(plan, time)]));
  const shuffled = [...times].sort((left, right) => ((left * 7919) % 101) - ((right * 7919) % 101) || right - left);
  const reordered = new Map(shuffled.map((time) => [time, cameraAt(plan, time)]));
  const grid = (fps) => {
    const views = new Map();
    for (let index = 0; (index * 1000) / fps <= input.endMs; index += 1) {
      const time = Math.round((index * 1000) / fps);
      views.set(time, cameraAt(plan, time));
    }
    return views;
  };
  const tenFps = grid(10);
  const thirtyFps = grid(30);
  const same = (left, right, label) => {
    for (const key of ["x", "y", "w"]) assert.ok(Object.is(left[key], right[key]), `${label}: ${key} ${left[key]} vs ${right[key]}`);
  };
  for (const time of times) same(ascending.get(time), reordered.get(time), `shuffled order at ${time} ms`);
  let shared = 0;
  for (const [time, view] of tenFps) {
    if (!thirtyFps.has(time)) continue;
    shared += 1;
    same(view, thirtyFps.get(time), `10 fps vs 30 fps at ${time} ms`);
    same(view, cameraAt(plan, time), `10 fps vs a direct seek at ${time} ms`);
  }
  assert.ok(shared > 300, "the frame rates share timestamps");
});

/** What the video shows: the scene crop when there is one, else the whole stage. */
const frameOf = (input) => input.frame ?? {x: 0, y: 0, width: input.width, height: input.height};

test("the camera never shows outside the stage (or the crop) and never zooms below 1", () => {
  for (const {label, input, plan} of PLANNED) {
    const {x: X, y: Y, width: W, height: H} = frameOf(input);
    for (let time = 0; time <= input.endMs; time += 10) {
      const view = cameraAt(plan, time);
      const h = (view.w * H) / W;
      assert.ok(
        view.x >= X - 1e-6 && view.y >= Y - 1e-6 && view.x + view.w <= X + W + 1e-6 && view.y + h <= Y + H + 1e-6 && view.w <= W + 1e-6,
        `${label}: view ${JSON.stringify(view)} at ${time} ms leaves the ${W}x${H} frame at (${X}, ${Y})`
      );
    }
  }
});

test("the drawn camera fills the stage (or the crop) with what the plan frames, and nothing outside it", () => {
  let zoomed = 0;
  for (const {label, input, plan} of PLANNED) {
    const {x: X, y: Y, width: W, height: H} = frameOf(input);
    for (let time = 0; time <= input.endMs; time += 50) {
      const {zoom, tx, ty, css, view} = cameraTransform(plan, time);
      // What the frame's screen area shows, in world px: stage point p is drawn at p·zoom + t.
      const shown = rect((X - tx) / zoom, (Y - ty) / zoom, (X + W - tx) / zoom, (Y + H - ty) / zoom);
      assert.ok(inside(shown, rect(X, Y, X + W, Y + H), 1e-6), `${label}: the frame shows ${JSON.stringify(shown)} at ${time} ms`);
      assert.ok(zoom >= 1, `${label}: zoom ${zoom}`);
      const planned = cameraAt(plan, time);
      // Rounding (zoom to 5 decimals, translation to 3) moves a 4K frame by at most a few hundredths of a pixel.
      assert.ok(Math.abs(view.x - planned.x) < 0.05 && Math.abs(view.y - planned.y) < 0.05 && Math.abs(view.w - planned.w) < 0.05,
        `${label}: drawn ${JSON.stringify(view)} vs planned ${JSON.stringify(planned)} at ${time} ms`);
      assert.equal(css, zoom === 1 && tx === 0 && ty === 0 ? "none" : `translate(${tx}px, ${ty}px) scale(${zoom})`);
      if (zoom > 1.2 && input.frame) zoomed += 1;
    }
  }
  assert.ok(zoomed > 100, `cropped frames zoomed in: ${zoomed}`);
});

test("the pointer, arrow included, stays inside the frame whenever it is on the stage (or in the crop)", () => {
  for (const {label, input, plan} of PLANNED) {
    const u = input.uiScale;
    const window = frameOf(input);
    const bounds = rect(window.x, window.y, window.x + window.width, window.y + window.height);
    const outside = [];
    for (let time = 0; time <= input.endMs; time += 10) {
      const tip = cursorAt(input.moves, input.home, time, u);
      const arrow = rect(tip.x - 13 * u, tip.y - 13 * u, tip.x + 24 * u, tip.y + 27 * u);
      const frame = viewRect(plan, cameraAt(plan, time));
      if (inside(arrow, bounds, 0)) {
        assert.ok(inside(arrow, frame, 0.5), `${label}: pointer ${JSON.stringify(tip)} outside ${JSON.stringify(frame)} at ${time} ms`);
        continue;
      }
      // Partly outside the stage or crop: the part the video can show is in view.
      outside.push(time);
      const visible = rect(Math.max(arrow.x0, bounds.x0), Math.max(arrow.y0, bounds.y0), Math.min(arrow.x1, bounds.x1), Math.min(arrow.y1, bounds.y1));
      if (visible.x1 <= visible.x0 || visible.y1 <= visible.y0) continue;
      assert.ok(inside(visible, frame, 0.5), `${label}: visible pointer ${JSON.stringify(visible)} outside ${JSON.stringify(frame)} at ${time} ms`);
    }
    if (label.startsWith("example")) {
      // The sidebar scrolls the Layout header into view below the open Colors group, so the pointer never leaves the stage.
      assert.deepEqual(outside, [], `${label}: off the stage at ${outside.join(", ")} ms`);
    }
  }
});

test("popups, typed text, the toast, and reacting widgets stay fully in view while they are held", () => {
  for (const {label, input, plan} of PLANNED) {
    const window = frameOf(input);
    const shown = (r) => r.x0 < window.x + window.width && r.x1 > window.x && r.y0 < window.y + window.height && r.y1 > window.y;
    assert.ok(plan.holds.length > 0 || !input.cues.some((cue) => cue.rects.some(({rect: r}) => shown(r))), `${label}: cues become holds`);
    for (const hold of plan.holds) {
      for (let time = Math.max(0, Math.ceil(hold.startMs / 10) * 10); time < hold.endMs && time <= input.endMs; time += 10) {
        const frame = viewRect(plan, cameraAt(plan, time));
        assert.ok(inside(hold.rect, frame, 0.5), `${label}: hold ${JSON.stringify(hold)} leaves ${JSON.stringify(frame)} at ${time} ms`);
      }
    }
  }
});

test("the example tutorial zooms in for real and needs no repair", () => {
  const input = exampleInput(1.8);
  const plan = planCamera(input);
  assert.deepEqual(plan.repairedMoves, []);
  assert.equal(plan.fallback, false);
  let maxZoom = 0;
  let zoomedMs = 0;
  for (let time = 0; time <= input.endMs; time += 5) {
    const zoom = zoomOf(plan, cameraAt(plan, time));
    maxZoom = Math.max(maxZoom, zoom);
    if (zoom > 1.2) zoomedMs += 5;
  }
  assert.ok(maxZoom >= 1.75, `the close-up reaches the configured zoom: ${maxZoom}`);
  assert.ok(zoomedMs >= 0.4 * input.endMs, `zoomed in for ${((zoomedMs / input.endMs) * 100).toFixed(0)}% of the video`);
});

const W = 1920;
const H = 1080;
const U = 4 / 3;
const HOME = {x: W * 0.62, y: H * 0.58};
const A = {x: 300, y: 300};
const B = {x: 900, y: 520};
const B2 = {x: 960, y: 560};
const move = (startMs, endMs, workEndMs, from, to) => ({startMs, endMs, workEndMs, from, approach: to, arrive: to, leave: to});
const script = (moves, extra = {}) => ({width: W, height: H, uiScale: U, zoom: 1.8, endMs: 12_000, home: HOME, moves, cues: [], captions: [], ...extra});

test("a zoom-in waits for the pointer to start moving and lands around the click", () => {
  const plan = planCamera(script([move(600, 1250, 3000, HOME, A)]));
  assert.equal(zoomOf(plan, cameraAt(plan, 700)), 1, "still wide 100 ms into the move");
  const atClick = zoomOf(plan, cameraAt(plan, 1250));
  assert.ok(atClick >= 1.6, `mostly zoomed at the click: ${atClick}`);
  const zoomIn = plan.keys.find((key) => key.kind === "zoom-in");
  assert.ok(zoomIn, "a zoom-in key");
  assert.deepEqual(cameraAt(plan, 1750), zoomIn.view, "fully landed 500 ms after the click");
});

test("pans start ahead of the pointer and land before the click; targets inside the dead zone move nothing", () => {
  const first = move(600, 1250, 3000, HOME, A);
  const second = move(3000, 3650, 4200, A, B);
  const plan = planCamera(script([first, second]));
  const pan = plan.keys.find((key) => key.kind === "pan");
  assert.ok(pan, `a pan key: ${JSON.stringify(plan.keys.map((key) => [key.t, key.kind]))}`);
  assert.deepEqual(cameraAt(plan, 3550), pan.view, "the pan has landed 100 ms before the click");
  assert.equal(pan.t, 2550, "the pan starts 450 ms before the pointer");
  assert.deepEqual(plan.repairedMoves, []);
  const third = move(4200, 4600, 4700, B, B2);
  const withThird = planCamera(script([first, second, third]));
  const shape = (keys) => keys.filter((key) => key.kind !== "idle").map((key) => `${key.t} ${key.kind}`);
  assert.deepEqual(shape(withThird.keys), shape(plan.keys), "a short hop inside the dead zone adds no key");
});

test("the camera returns to the full editor after inactivity", () => {
  const plan = planCamera(script([move(600, 1250, 3000, HOME, A), move(3000, 3650, 4200, A, B), move(9000, 9650, 9700, B, A)]));
  for (let time = 5700; time <= 9000; time += 100) {
    assert.deepEqual(cameraAt(plan, time), full(W), `full editor at ${time} ms`);
  }
});

test("the camera pulls back to reveal the widget before it reacts", () => {
  const F = {x: 200, y: 300};
  const widget = rect(800, 200, 1200, 700);
  const row = rect(0, 270, 430, 330);
  const plan = planCamera(script([move(600, 1250, 4800, HOME, F)], {
    endMs: 9000,
    cues: [cueOf("typing", 1250, 4800, [row]), cueOf("reveal", 5000, 5000, [widget, row])],
    captions: [{startMs: 0, endMs: 9000, height: 57.7}]
  }));
  assert.ok(plan.keys.some((key) => key.kind === "reveal" && key.t === 4000), `a reveal key 1000 ms early: ${JSON.stringify(plan.keys.map((key) => [key.t, key.kind]))}`);
  const view = cameraAt(plan, 5000);
  assert.ok(inside(widget, viewRect(plan, view), 0.5), `the widget is in view when it reacts: ${JSON.stringify(view)}`);
  assert.ok(zoomOf(plan, view) <= 1.5 + 1e-9, `reveal zoom ${zoomOf(plan, view)}`);
});

test("with a scene crop, the camera frames the crop and reveals the widget inside it", () => {
  // A 1920x1080 tutorial cropped to the canvas: the sidebar field the pointer types into is cut off.
  const crop = {x: 427, y: 0, width: 1066, height: 1080};
  const F = {x: 170, y: 400};
  const widget = rect(755, 84, 1123, 631);
  const row = rect(0, 360, 427, 421);
  const plan = planCamera(script([move(600, 1250, 4800, HOME, F)], {
    frame: crop,
    endMs: 9000,
    cues: [cueOf("typing", 1250, 4800, [row]), cueOf("reveal", 5000, 5000, [widget, row])],
    captions: [{startMs: 0, endMs: 9000, height: 57.7}]
  }));
  assert.deepEqual(plan.frame, crop);
  assert.deepEqual(cameraAt(plan, 0), {x: 427, y: 0, w: 1066}, "the full view is the crop");
  const cropRect = rect(427, 0, 1493, 1080);
  for (let time = 0; time <= 9000; time += 10) {
    const frame = viewRect(plan, cameraAt(plan, time));
    assert.ok(inside(frame, cropRect, 1e-6), `the view ${JSON.stringify(frame)} leaves the crop at ${time} ms`);
    // The target is outside the crop: no close-up on the crop's edge while the pointer works there.
    if (time < 4000) assert.equal(zoomOf(plan, cameraAt(plan, time)), 1, `a close-up on nothing at ${time} ms`);
  }
  for (let time = 5000; time < 5600; time += 10) {
    const view = cameraAt(plan, time);
    assert.ok(inside(widget, viewRect(plan, view), 0.5), `the widget leaves the crop at ${time} ms: ${JSON.stringify(view)}`);
  }
  const reveal = cameraAt(plan, 5000);
  assert.ok(zoomOf(plan, reveal) > 1.2, `the reveal zooms in on the widget: ${zoomOf(plan, reveal)}`);
  const center = ((widget.x0 + widget.x1) / 2 - reveal.x) / reveal.w;
  assert.ok(Math.abs(center - 0.5) < 0.1, `the reveal centers the widget, not the crop edge the pointer left by: ${center}`);
});

test("with a scene crop, captions slide just clear of popups as the video shows them", () => {
  // Captions sit in the HUD in stage px; the camera draws a world point at crop origin + (point - view)·zoom.
  const crop = {x: 240, y: 120, width: 1440, height: 900};
  const picker = {startMs: 2000, endMs: 5000, rect: rect(728, 243, 1192, 837), side: "below"};
  const menu = {startMs: 6000, endMs: 8000, rect: rect(576, 454.7, 1061.3, 1020), side: "above"};
  // Both sides fit: the caption takes the one nearer its default place at the stage bottom.
  const list = {startMs: 9000, endMs: 10500, rect: rect(800, 700, 1100, 850), side: "below"};
  const swatch = {x: 900, y: 500};
  const counts = {below: 0, above: 0};
  for (const [zoom, height] of [[null, 57.7], [1.8, 57.7], [null, 87.4], [1.8, 87.4], [2.5, 87.4]]) {
    const box = {left: 710 - 608.4 / 2, top: 810 - 104 - height, width: 608.4, height};
    const plan = planCamera(script([move(600, 1250, 2000, HOME, swatch)], {
      zoom,
      frame: crop,
      endMs: 11_000,
      cues: [picker, menu, list].map((popup) => cueOf("popup", popup.startMs, popup.endMs, [popup.rect])),
      captions: [{startMs: 0, endMs: 11_000, height}]
    }));
    for (const popup of [picker, menu, list]) {
      for (let time = popup.startMs; time < popup.endMs; time += 5) {
        const view = cameraAt(plan, time);
        const z = zoomOf(plan, view);
        const top = captionTop(plan, view, time, box, 810);
        assert.equal(captionOpacity(plan, view, time, {...box, top}), 1, `a side fits, so the caption stays opaque at ${time} ms`);
        const hud = (value, origin, from) => (origin + (value - from) * z) / U;
        const r = popup.rect;
        const p = rect(hud(r.x0, crop.x, view.x), hud(r.y0, crop.y, view.y), hud(r.x1, crop.x, view.x), hud(r.y1, crop.y, view.y));
        assert.ok(top >= p.y1 || top + height <= p.y0, `the caption at ${top.toFixed(1)} covers the popup ${JSON.stringify(p)} at ${time} ms (zoom ${zoom})`);
        // Just clear, 20 HUD px below or above the popup, when its default place overlaps it
        // (closer than 20 px, it moves part of the way; the check above covers that).
        const overlapsDefault = box.top <= p.y1 && p.y0 <= box.top + height;
        if (popup.side === "below" && overlapsDefault) {
          assert.ok(Math.abs(top - (p.y1 + 20)) < 0.01, `${top} is not just below the popup's ${p.y1} at ${time} ms (zoom ${zoom})`);
          counts.below += 1;
        }
        if (popup.side === "above" && overlapsDefault) {
          assert.ok(Math.abs(top + height - (p.y0 - 20)) < 0.01, `${top} is not just above the popup's ${p.y0} at ${time} ms (zoom ${zoom})`);
          counts.above += 1;
        }
      }
    }
  }
  assert.ok(counts.below > 1000 && counts.above > 1000, `frames that slid: ${JSON.stringify(counts)}`);
  // A popup near the crop's top edge leaves no room above it inside the video: the caption fades
  // instead of sliding above the crop.
  const low = {x: 240, y: 400, width: 1440, height: 680};
  const tall = rect(576, 450, 1061, 1080);
  const box = {left: 710 - 608.4 / 2, top: 810 - 104 - 57.7, width: 608.4, height: 57.7};
  const plan = planCamera(script([], {zoom: null, frame: low, endMs: 4000, cues: [cueOf("popup", 1000, 3000, [tall])], captions: [{startMs: 0, endMs: 4000, height: 57.7}]}));
  for (let time = 1000; time < 3000; time += 5) {
    const view = cameraAt(plan, time);
    const top = captionTop(plan, view, time, box, 810);
    const opacity = captionOpacity(plan, view, time, {...box, top});
    assert.ok(opacity === 0 || top * U >= low.y, `the caption is drawn above the crop at ${time} ms: top ${top * U} px, opacity ${opacity}`);
  }
});

const captionBox = (input, caption) => ({
  left: input.editor.captionCenterX - caption.width / 2,
  top: input.editor.height - 104 - caption.height,
  width: caption.width,
  height: caption.height
});

test("with the camera off, a caption moves just below the color picker, as before", () => {
  const input = exampleInput(null);
  const plan = planCamera(input);
  assert.equal(plan.keys.length, 0);
  const picker = input.cues.find((cue) => cue.kind === "popup");
  const time = picker.startMs + 400;
  const caption = input.captions.find((entry) => entry.startMs <= time && time < entry.endMs);
  const top = captionTop(plan, full(W), time, captionBox(input, caption), 810);
  assert.ok(Math.abs(top - 648) < 1e-6, `caption top ${top}, dialog bottom 628 + 20 expected`);
});

test("with the camera on, captions never cover an open popup and slide instead of jumping", () => {
  const input = exampleInput(1.8);
  const plan = planCamera(input);
  const popups = input.cues.filter((cue) => cue.kind === "popup");
  const at = (time) => {
    const caption = input.captions.find((entry) => entry.startMs <= time && time < entry.endMs);
    if (!caption) return null;
    const box = captionBox(input, caption);
    const view = cameraAt(plan, time);
    return {caption, box, view, top: captionTop(plan, view, time, box, 810)};
  };
  let checked = 0;
  for (let time = 0; time <= input.endMs; time += 5) {
    const frame = at(time);
    if (!frame) continue;
    const {box, view, top} = frame;
    const zoom = zoomOf(plan, view);
    for (const popup of popups) {
      if (time < popup.startMs || time >= popup.endMs) continue;
      for (const {rect: r, obstacle} of popup.rects) {
        if (!obstacle) continue;
        const p = rect(((r.x0 - view.x) * zoom) / U, ((r.y0 - view.y) * zoom) / U, ((r.x1 - view.x) * zoom) / U, ((r.y1 - view.y) * zoom) / U);
        const overlaps = box.left < p.x1 && p.x0 < box.left + box.width && top < p.y1 && p.y0 < top + box.height;
        assert.ok(!overlaps, `caption at ${top.toFixed(1)} covers the popup ${JSON.stringify(p)} at ${time} ms`);
        checked += 1;
      }
    }
  }
  assert.ok(checked > 1000, `popup frames checked: ${checked}`);
  let previous = null;
  for (let time = 0; time <= input.endMs; time += 1) {
    const frame = at(time);
    if (!frame) {
      previous = null;
      continue;
    }
    assert.ok(frame.top >= 60 && frame.top <= 810 - 8 - frame.caption.height, `caption top ${frame.top} off the editor at ${time} ms`);
    if (previous && previous.caption === frame.caption) {
      assert.ok(Math.abs(frame.top - previous.top) <= 8, `caption jumps ${Math.abs(frame.top - previous.top).toFixed(1)} px at ${time} ms`);
    }
    previous = frame;
  }
});

test("a caption with no room around a popup fades out instead of covering it", () => {
  // 2560x1080 (21:9): the editor is 1440x607.5 at uiScale 16/9, and the 347x445 color picker leaves no room above or below it.
  const W21 = 2560;
  const u = W21 / 1440;
  const editorHeight = 607.5;
  const ed = (x0, y0, x1, y1) => rect(x0 * u, y0 * u, x1 * u, y1 * u);
  const dialog = ed(546.5, 81.25, 893.5, 526.25);
  const home = {x: W21 * 0.62, y: 1080 * 0.58};
  const swatch = {x: 28 * u, y: 347 * u};
  const popup = {startMs: 2000, endMs: 7000};
  let checked = 0;
  for (const height of [57.7, 87.4]) {
    for (const zoom of [null, 1.8]) {
      const plan = planCamera({
        width: W21,
        height: 1080,
        uiScale: u,
        zoom,
        endMs: 9000,
        home,
        moves: [{startMs: 600, endMs: 1250, workEndMs: 2000, from: home, approach: swatch, arrive: swatch, leave: swatch}],
        cues: [cueOf("popup", popup.startMs, popup.endMs, [dialog])],
        captions: [{startMs: 0, endMs: 9000, height}]
      });
      const box = {left: 710 - 608.4 / 2, top: editorHeight - 104 - height, width: 608.4, height};
      let previous = null;
      for (let time = 0; time <= 9000; time += 1) {
        const view = cameraAt(plan, time);
        const top = captionTop(plan, view, time, box, editorHeight);
        const placed = {...box, top};
        const opacity = captionOpacity(plan, view, time, placed);
        assert.ok(opacity >= 0 && opacity <= 1, `opacity ${opacity}`);
        if (previous !== null) assert.ok(Math.abs(opacity - previous) <= 0.01, `the caption blinks at ${time} ms: ${previous} -> ${opacity}`);
        previous = opacity;
        if (time < popup.startMs - 200 || time >= popup.endMs + 200) assert.equal(opacity, 1, `faded outside the popup at ${time} ms`);
        if (time < popup.startMs || time >= popup.endMs) continue;
        const z = zoomOf(plan, view);
        const p = rect(((dialog.x0 - view.x) * z) / u, ((dialog.y0 - view.y) * z) / u, ((dialog.x1 - view.x) * z) / u, ((dialog.y1 - view.y) * z) / u);
        const covers = placed.left < p.x1 && p.x0 < placed.left + placed.width && top < p.y1 && p.y0 < top + height;
        assert.ok(!covers || opacity === 0, `a ${height}px caption covers the open popup at ${time} ms (zoom ${zoom}, opacity ${opacity})`);
        checked += 1;
      }
    }
  }
  assert.ok(checked > 10_000, `popup frames checked: ${checked}`);
  // Where a side fits, as in the 1080p example, captions never fade.
  const input = exampleInput(1.8);
  const plan = planCamera(input);
  for (let time = 0; time <= input.endMs; time += 5) {
    const caption = input.captions.find((entry) => entry.startMs <= time && time < entry.endMs);
    if (!caption) continue;
    const view = cameraAt(plan, time);
    const box = captionBox(input, caption);
    const top = captionTop(plan, view, time, box, 810);
    assert.equal(captionOpacity(plan, view, time, {...box, top}), 1, `the example caption fades at ${time} ms`);
  }
});

test("the pointer shrinks on a click, holds during a drag, and springs back smoothly", () => {
  const click = [{downMs: 0, upMs: 0}];
  const drag = [{downMs: 0, upMs: 900}];
  const scripts = [click, drag, [{downMs: 0, upMs: 0}, {downMs: 150, upMs: 150}, {downMs: 260, upMs: 700}]];
  for (const presses of scripts) {
    for (let time = 0; time < 1500; time += 1) {
      const step = Math.abs(pointerScale(presses, time + 1) - pointerScale(presses, time));
      assert.ok(step <= 0.01, `the pointer jumps ${step.toFixed(4)} at ${time} ms in ${JSON.stringify(presses)}`);
    }
  }
  assert.ok(Math.abs(pointerScale(click, 35) - 0.85) <= 0.001, `+35 ms: ${pointerScale(click, 35)}`);
  assert.ok(Math.abs(pointerScale(click, 70) - 0.8) <= 1e-9, `+70 ms: ${pointerScale(click, 70)}`);
  assert.ok(Math.abs(pointerScale(click, 210) - 1.0326) <= 0.002, `+210 ms overshoot: ${pointerScale(click, 210)}`);
  assert.equal(pointerScale(click, -1), 1);
  for (let time = 520; time <= 1500; time += 1) assert.equal(pointerScale(click, time), 1, `rest at +${time} ms`);
  for (let time = 70; time < 900; time += 1) assert.ok(Math.abs(pointerScale(drag, time) - 0.8) <= 1e-9, `held at +${time} ms`);
});

test("the click ripple fades in, grows, and is gone after 520 ms", () => {
  const presses = [{downMs: 1000, upMs: 1000}];
  assert.equal(ripple(presses, 999), null);
  assert.equal(ripple(presses, 1000).opacity, 0, "no pop at the press");
  let previousScale = -Infinity;
  for (let time = 1000; time < 1520; time += 1) {
    const wave = ripple(presses, time);
    assert.ok(wave.opacity >= 0 && wave.opacity <= 0.85, `opacity ${wave.opacity} at +${time - 1000} ms`);
    assert.ok(wave.scale >= previousScale, `the ring shrinks at +${time - 1000} ms`);
    previousScale = wave.scale;
  }
  for (let time = 1520; time < 2000; time += 7) assert.equal(ripple(presses, time), null);
});

test("the pointer is drawn at the camera's zoom and pulses around its tip on a click", () => {
  const arrow = {size: 28, hotspot: {x: 5, y: 2.5}};
  const presses = [{downMs: 1000, upMs: 1000}];
  const tip = {x: 500, y: 300};
  const parse = (transform) => {
    const match = /^translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)$/.exec(transform);
    assert.ok(match, `transform ${transform}`);
    return match.slice(1).map(Number);
  };
  for (const zoom of [1, 1.8, 2.5]) {
    const style = pointerStyle(arrow, tip, U, zoom, presses, 0);
    assert.ok(Math.abs(style.size - 28 * U * zoom) < 1e-9, `the pointer is 28 editor px times the zoom: ${style.size} at ${zoom}`);
    const [x, y, scale] = parse(style.transform);
    assert.equal(scale, 1, "at rest");
    const hotspot = [(5 * style.size) / 24, (2.5 * style.size) / 24];
    assert.ok(Math.abs(x + hotspot[0] - tip.x) < 1e-9 && Math.abs(y + hotspot[1] - tip.y) < 1e-9, `the hotspot sits on the tip at ${zoom}`);
    assert.equal(style.origin, `${hotspot[0]}px ${hotspot[1]}px`, "the pulse shrinks toward the tip");
    assert.equal(style.ripple, null);
  }
  const scaleAt = (time) => parse(pointerStyle(arrow, tip, U, 1.8, presses, time).transform)[2];
  assert.ok(Math.abs(scaleAt(1070) - 0.8) <= 1e-9, `pressed at +70 ms: ${scaleAt(1070)}`);
  assert.ok(Math.abs(scaleAt(1210) - 1.0326) <= 0.002, `springs past 1 at +210 ms: ${scaleAt(1210)}`);
  assert.equal(scaleAt(1520), 1, "at rest from +520 ms");
  const wave = (zoom) => /scale\(([-\d.e]+)\)$/.exec(pointerStyle(arrow, tip, U, zoom, presses, 1200).ripple.transform)[1];
  assert.ok(Math.abs(Number(wave(1.8)) / Number(wave(1)) - 1.8) < 1e-9, "the ripple scales with the camera");
  assert.ok(pointerStyle(arrow, tip, U, 1.8, presses, 1200).ripple.transform.startsWith(`translate(${tip.x}px, ${tip.y}px)`), "the ripple is centered on the tip");
});
