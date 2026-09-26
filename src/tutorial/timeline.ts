import type {
  FixtureDefinition,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  NormalizedField,
  TutorialDefinition,
  TutorialEmulateKind,
  TutorialStep,
  TutorialTarget
} from "../types.js";
import {StudioError} from "../shared/errors.js";
import {DEFAULT_FIXED_TIME} from "../scenarios/state.js";
import {cssColor, formatColor, hsvToRgb, needsDarkText, parseColor, rgbToHsv, type Rgba} from "./color.js";

/** Internal cursor targets extend the author-facing ones with transient menu entries. */
export type TimelineTarget =
  | TutorialTarget
  | `section:${string}`
  | `menu:${string}`
  | `menu-option:${string}:${number}`
  | `option:${string}:${number}`
  | `swatch:${string}`
  | `picker:${TutorialPickerTarget}`;

/** Parts of the md-color-picker dialog the cursor can reach; `grab` is where a spectrum drag starts. */
export type TutorialPickerTarget = "hue" | "spectrum" | "alpha" | "grab" | "select";

export interface TutorialChatLine {
  id: string;
  user: string;
  color: string;
  badges: string[];
  text: string;
}

export interface TutorialUiPatch {
  selected?: boolean;
  settingsOpen?: boolean;
  openGroup?: string | null;
  menu?: {hover: string | null; submenu: string | null; hoverOption: number | null} | null;
  select?: {field: string; hover: number | null} | null;
  focusField?: string | null;
  selectAll?: string | null;
  fieldValue?: {id: string; value: JsonPrimitive};
  caption?: string | null;
  chatDraft?: string;
  chatFocus?: boolean;
  chatAppend?: TutorialChatLine;
  pressed?: string | null;
  toast?: string | null;
  colorPicker?: TutorialColorPicker | null;
}

/**
 * Full state of the open md-color-picker dialog at a patch time. The host draws the
 * dialog from it and derives the open/close animation from `openedAtMs`/`closedAtMs`.
 */
export interface TutorialColorPicker {
  field: string;
  /** Hue in degrees; 360 is the top of the hue strip. */
  h: number;
  s: number;
  v: number;
  a: number;
  rgb: {r: number; g: number; b: number};
  /** Header value text, in the notation of the requested value. */
  text: string;
  /** Header background. */
  css: string;
  /** md-color-picker's `dark` class: dark header text on a light color. */
  darkText: boolean;
  tab: "hex" | "rgb";
  /** The header value is focused and selected, as right after opening. */
  selected: boolean;
  drag: "hue" | "spectrum" | "alpha" | null;
  /** Spectrum point (saturation, value) the cursor aims at before pressing. */
  grab: {s: number; v: number} | null;
  hoverAtMs: number | null;
  selectAtMs: number | null;
  openedAtMs: number;
  closedAtMs: number | null;
}

export interface TutorialCursorMove {
  startMs: number;
  endMs: number;
  to: TimelineTarget;
}

export type TutorialWidgetAction =
  | {atMs: number; kind: "dispatch"; listener: string; event: JsonValue}
  | {atMs: number; kind: "fields"; fieldData: JsonObject};

export interface TutorialPanelField {
  id: string;
  label: string;
  type: string;
  group: string;
  min?: number;
  max?: number;
  step?: number;
  options: {label: string; value: JsonPrimitive}[];
}

export interface TutorialTimeline {
  endMs: number;
  chrome: {
    overlayName: string;
    layerName: string;
    overlay: {width: number; height: number};
    widget: {x: number; y: number; scale: number};
    uiScale: number;
    chat: {enabled: boolean; title: string; channel: string};
    liveEmulation: boolean;
  };
  fields: TutorialPanelField[];
  groups: string[];
  initialValues: Record<string, JsonPrimitive>;
  patches: {atMs: number; patch: TutorialUiPatch}[];
  moves: TutorialCursorMove[];
  clicks: number[];
  widget: TutorialWidgetAction[];
}

export const DEFAULT_GROUP = "General";
const DEFAULT_MOVE_MS = 650;
const PRESS_MS = 140;
const AFTER_CLICK_MS = 260;
const DEFAULT_TYPING_MS = 70;
const SLIDER_DRAG_MS = 900;
const SLIDER_SAMPLE_MS = 33;
const DEFAULT_VIEWER = "StudioViewer";
/* md-color-picker timing: $mdDialog opens and closes in 400ms; the rest paces a person. */
const PICKER_CLICK_MS = 90;
const PICKER_OPEN_MS = 400;
/** Pause on the open dialog so viewers can read the current value selected in its header. */
const PICKER_READ_MS = 500;
const PICKER_CLOSE_MS = 400;
const PICKER_MOVE_MS = 450;
const PICKER_HOLD_MS = 150;
const PICKER_REVIEW_MS = 300;
/** The cursor rests on Select, with its hover background fading in, before pressing it. */
const PICKER_HOVER_MS = 200;
const PICKER_DRAG_MIN_MS = 350;
const PICKER_DRAG_MAX_MS = 900;
const PICKER_DRAG_MS_PER_PX = 3.5;
/** A spectrum drag starts this far from its target, as a person clicks near the color and fine-tunes. */
const PICKER_APPROACH_PX = 36;
/** Canvas size of md-color-picker's spectrum, hue, and alpha strips. */
const PICKER_SIZE = 255;

export interface EmulateMenuEntry {
  kind: TutorialEmulateKind | "emote" | "charity" | "other";
  label: string;
  icon: string;
  options: string[];
  emulatable: boolean;
}

/** Mirrors the order and submenus of the StreamElements overlay editor's Emulate menu. */
export const EMULATE_MENU: EmulateMenuEntry[] = [
  {kind: "follower", label: "Follower event", icon: "favorite", options: [], emulatable: true},
  {kind: "subscriber", label: "Subscriber event", icon: "subscriber", options: ["1", "Gift", "Community gift", "Custom..."], emulatable: true},
  {kind: "tip", label: "Tip event", icon: "credit_card", options: ["$10", "$50", "Custom..."], emulatable: true},
  {kind: "cheer", label: "Cheer event", icon: "cheer", options: ["1k", "5k", "Custom..."], emulatable: true},
  {kind: "raid", label: "Raid event", icon: "people", options: ["10", "50", "Custom..."], emulatable: true},
  {kind: "redemption", label: "Item redemption", icon: "redeem", options: [], emulatable: true},
  {kind: "emote", label: "Emote event", icon: "face", options: ["Custom..."], emulatable: false},
  {kind: "merch", label: "Merch event", icon: "attach_money", options: [], emulatable: true},
  {kind: "charity", label: "Charity event", icon: "charity", options: ["Tiltify", "Extralife", "DonorDrive"], emulatable: false},
  {kind: "other", label: "Other", icon: "dots", options: ["Custom..."], emulatable: false}
];

const TEXT_TYPES = new Set([
  "text",
  "textfield",
  "textarea",
  "number",
  "googleFont",
  "fontpicker",
  "image-input",
  "video-input",
  "sound-input"
]);

function fixedEpoch(): number {
  return Date.parse(DEFAULT_FIXED_TIME);
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

const USER_COLORS = ["#ff7ad9", "#8be9fd", "#50fa7b", "#ffb86c", "#bd93f9", "#f1fa8c", "#ff5555", "#7aa2f7"];

function colorFor(user: string): string {
  return USER_COLORS[Number.parseInt(hashString(user.toLowerCase()), 16) % USER_COLORS.length]!;
}

function badgeUrl(type: string): string {
  const fills: Record<string, string> = {
    broadcaster: "#e91916",
    moderator: "#00ad03",
    vip: "#e005b9",
    subscriber: "#8205b4"
  };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18"><rect width="18" height="18" rx="3" fill="${fills[type] ?? "#6b6b6b"}"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

/** Builds a StreamElements-shaped chat `message` event with synthetic identifiers. */
export function chatMessageEvent(options: {
  id: string;
  user: string;
  text: string;
  color: string;
  badges: string[];
  channel: string;
  atMs: number;
  data?: JsonObject;
}): JsonObject {
  const nick = options.user.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const data: JsonObject = {
    time: fixedEpoch() + options.atMs,
    tags: {
      "badge-info": "",
      badges: options.badges.map((badge) => `${badge}/1`).join(","),
      color: options.color,
      "display-name": options.user,
      emotes: "",
      id: options.id,
      mod: options.badges.includes("moderator") ? "1" : "0",
      subscriber: options.badges.includes("subscriber") ? "1" : "0",
      "user-id": `sws-${hashString(nick)}`
    },
    nick,
    userId: `sws-${hashString(nick)}`,
    displayName: options.user,
    displayColor: options.color,
    badges: options.badges.map((type) => ({type, version: "1", url: badgeUrl(type), description: type})),
    channel: options.channel,
    text: options.text,
    isAction: false,
    emotes: [],
    msgId: options.id,
    ...(options.data ?? {})
  };
  return {data, renderedText: options.text};
}

function emulatePayload(
  step: Extract<TutorialStep, {action: "emulate"}>,
  optionLabel: string | undefined
): {listener: string; event: JsonValue} {
  const name = step.name ?? DEFAULT_VIEWER;
  const numeric = (label: string | undefined, fallback: number) => {
    if (step.amount !== undefined) return step.amount;
    if (!label) return fallback;
    const match = /^\$?(\d+(?:\.\d+)?)(k)?$/i.exec(label);
    if (!match) return fallback;
    return Number(match[1]) * (match[2] ? 1000 : 1);
  };
  let listener: string;
  let event: JsonObject;
  switch (step.event) {
    case "follower":
      listener = "follower-latest";
      event = {name};
      break;
    case "subscriber":
      listener = "subscriber-latest";
      if (optionLabel === "Gift") {
        event = {name, amount: numeric(undefined, 1), tier: "1000", gifted: true, sender: "GenerousViewer", message: ""};
      } else if (optionLabel === "Community gift") {
        event = {name, amount: numeric(undefined, 5), tier: "1000", bulkGifted: true, sender: name, message: ""};
      } else {
        event = {name, amount: numeric(optionLabel, 1), tier: "1000", message: step.message ?? ""};
      }
      break;
    case "tip":
      listener = "tip-latest";
      event = {name, amount: numeric(optionLabel, 10), message: step.message ?? ""};
      break;
    case "cheer":
      listener = "cheer-latest";
      event = {name, amount: numeric(optionLabel, 1000), message: step.message ?? ""};
      break;
    case "raid":
      listener = "raid-latest";
      event = {name, amount: numeric(optionLabel, 10)};
      break;
    case "redemption":
      listener = "redemption-latest";
      event = {name, amount: numeric(undefined, 1), redemption: "Store item", message: step.message ?? ""};
      break;
    case "merch":
      listener = "merch-latest";
      event = {name, amount: numeric(undefined, 1), items: [{name: "Hoodie", quantity: 1, price: 40}]};
      break;
  }
  return {listener: step.listener ?? listener, event: step.payload ?? event};
}

function coerceFieldValue(field: TutorialPanelField, value: JsonPrimitive): JsonPrimitive {
  if (field.type === "number" || field.type === "slider") {
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric)) {
      throw new StudioError("TUTORIAL_FIELD_VALUE_INVALID", `Field "${field.id}" expects a number; received ${String(value)}.`);
    }
    return numeric;
  }
  if (field.type === "checkbox") {
    if (typeof value !== "boolean") {
      throw new StudioError("TUTORIAL_FIELD_VALUE_INVALID", `Checkbox "${field.id}" expects true or false.`);
    }
    return value;
  }
  if (field.type === "dropdown") {
    if (!field.options.some((option) => option.value === value)) {
      throw new StudioError(
        "TUTORIAL_FIELD_VALUE_INVALID",
        `Dropdown "${field.id}" has no option ${JSON.stringify(value)}.`,
        `Use one of: ${field.options.map((option) => JSON.stringify(option.value)).join(", ")}.`
      );
    }
    return value;
  }
  if (field.type === "colorpicker") {
    if (typeof value !== "string" || !parseColor(value)) {
      throw new StudioError(
        "TUTORIAL_FIELD_VALUE_INVALID",
        `Color picker "${field.id}" expects a color; received ${JSON.stringify(value)}.`,
        "Use #rgb, #rgba, #rrggbb, #rrggbbaa, rgb(r, g, b), or rgba(r, g, b, a), for example \"#ff7ad9\"."
      );
    }
    return value;
  }
  return value === null ? "" : String(value);
}

function easeInOutQuad(progress: number): number {
  return progress < 0.5 ? 2 * progress * progress : 1 - (-2 * progress + 2) ** 2 / 2;
}

/** Linear interpolation that lands exactly on `to` at the end, so drags finish on the target parameters. */
function lerp(from: number, to: number, progress: number): number {
  return progress >= 1 ? to : from + (to - from) * progress;
}

function pickerDragMs(distancePx: number): number {
  return Math.min(PICKER_DRAG_MAX_MS, Math.max(PICKER_DRAG_MIN_MS, Math.round(250 + distancePx * PICKER_DRAG_MS_PER_PX)));
}

function panelFields(fields: NormalizedField[]): TutorialPanelField[] {
  return fields
    .filter((field) => field.type !== "hidden")
    .map((field) => {
      const entry: TutorialPanelField = {
        id: field.id,
        label: field.label,
        type: field.type,
        group: field.group ?? DEFAULT_GROUP,
        options: field.options
      };
      if (field.min !== undefined) entry.min = field.min;
      if (field.max !== undefined) entry.max = field.max;
      if (field.step !== undefined) entry.step = field.step;
      return entry;
    });
}

function asPrimitive(value: JsonValue | undefined): JsonPrimitive {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object") return value;
  return JSON.stringify(value);
}

export function compileTutorial(options: {
  tutorial: TutorialDefinition;
  fields: NormalizedField[];
  fieldData: JsonObject;
  channel: string;
  fixture?: FixtureDefinition;
}): TutorialTimeline {
  const {tutorial} = options;
  const fields = panelFields(options.fields);
  const groups = [...new Set(fields.map((field) => field.group))];
  const values: Record<string, JsonPrimitive> = {};
  for (const field of fields) values[field.id] = asPrimitive(options.fieldData[field.id]);
  const initialValues = {...values};
  const typingMs = tutorial.typingMsPerChar ?? DEFAULT_TYPING_MS;
  const hasChatStep = tutorial.steps.some((step) => step.action === "chat");
  const channel = tutorial.chat?.channel ?? options.channel;
  if (tutorial.chat?.enabled === false && hasChatStep) {
    throw new StudioError("TUTORIAL_CHAT_DISABLED", "The tutorial has chat steps but chat.enabled is false.");
  }

  const patches: TutorialTimeline["patches"] = [];
  const moves: TutorialCursorMove[] = [];
  const clicks: number[] = [];
  const widget: TutorialWidgetAction[] = [];
  let t = 0;
  let selected = false;
  let openGroup: string | null = null;
  let chatCount = 0;

  const patch = (atMs: number, value: TutorialUiPatch) => patches.push({atMs, patch: value});
  const move = (to: TimelineTarget, durationMs = DEFAULT_MOVE_MS) => {
    moves.push({startMs: t, endMs: t + durationMs, to});
    t += durationMs;
  };
  const press = (pressedId: string) => {
    clicks.push(t);
    patch(t, {pressed: pressedId});
    patch(t + PRESS_MS, {pressed: null});
  };
  const click = (to: TimelineTarget, pressedId: string, durationMs?: number) => {
    move(to, durationMs);
    press(pressedId);
  };
  const targetId = (target: TimelineTarget) => (typeof target === "string" ? target : `point:${target.x},${target.y}`);

  const selectLayer = () => {
    if (selected) return;
    click("layer", "layer");
    selected = true;
    openGroup = null;
    patch(t, {selected: true, openGroup: null});
    t += AFTER_CLICK_MS + 200;
    click("section:settings", "section:settings");
    patch(t, {settingsOpen: true});
    t += AFTER_CLICK_MS;
  };
  const ensureGroup = (group: string) => {
    if (!groups.includes(group)) {
      throw new StudioError(
        "TUTORIAL_GROUP_NOT_FOUND",
        `Tutorial group "${group}" does not exist in the widget FIELDS.`,
        `Available groups: ${groups.join(", ") || "(none)"}.`
      );
    }
    selectLayer();
    if (openGroup === group) return;
    click(`group:${group}`, `group:${group}`);
    openGroup = group;
    patch(t, {openGroup: group});
    t += AFTER_CLICK_MS + 120;
  };
  const typeInto = (apply: (partial: string) => TutorialUiPatch, text: string) => {
    for (let index = 1; index <= text.length; index += 1) {
      t += typingMs;
      patch(t, apply(text.slice(0, index)));
    }
  };
  /**
   * Edits a colorpicker the way a person does in md-color-picker: click the swatch,
   * drag the hue strip, drag in the saturation/brightness square (and the alpha strip
   * when opacity changes), then press Select. Positions come from HSV parameters and the
   * last drag sample is the exact target, so the committed value is the requested string.
   */
  const pickColor = (field: TutorialPanelField, value: string) => {
    const current = values[field.id];
    const start: Rgba = (typeof current === "string" ? parseColor(current) : undefined) ?? {r: 255, g: 255, b: 255, a: 1};
    const goal = parseColor(value)!;
    const from = rgbToHsv(start);
    const to = rgbToHsv(goal);
    let state: TutorialColorPicker = {
      field: field.id,
      h: from.h,
      s: from.s,
      v: from.v,
      a: start.a,
      rgb: {r: start.r, g: start.g, b: start.b},
      text: formatColor(start, value),
      css: cssColor(start),
      darkText: needsDarkText(start),
      tab: value.startsWith("#") ? "hex" : "rgb",
      selected: true,
      drag: null,
      grab: null,
      hoverAtMs: null,
      selectAtMs: null,
      openedAtMs: 0,
      closedAtMs: null
    };
    const emit = (atMs: number, changes: Partial<TutorialColorPicker>) => {
      state = {...state, ...changes};
      if ("h" in changes || "s" in changes || "v" in changes || "a" in changes) {
        const color: Rgba = {...hsvToRgb(state), a: state.a};
        state = {
          ...state,
          rgb: {r: color.r, g: color.g, b: color.b},
          text: formatColor(color, value),
          css: cssColor(color),
          darkText: needsDarkText(color)
        };
      }
      patch(atMs, {colorPicker: state});
    };
    const drag = (distancePx: number, at: (progress: number) => Partial<TutorialColorPicker>) => {
      const durationMs = pickerDragMs(distancePx);
      const samples = Math.max(1, Math.round(durationMs / SLIDER_SAMPLE_MS));
      for (let index = 1; index <= samples; index += 1) {
        const progress = index / samples;
        emit(t + Math.round(progress * durationMs), at(index === samples ? 1 : easeInOutQuad(progress)));
      }
      t += durationMs;
      emit(t, {drag: null});
      t += PICKER_HOLD_MS;
    };

    const swatch = `swatch:${field.id}` as const;
    move(swatch);
    press(swatch);
    t += PICKER_CLICK_MS;
    emit(t, {openedAtMs: t});
    t += PICKER_OPEN_MS + PICKER_READ_MS;

    // Hue first: the spectrum keeps its marker and repaints under the new hue.
    let goalHue = to.s > 0 && to.v > 0 ? to.h : from.h;
    if (goalHue === 0 && from.h > 180) goalHue = 360; // red sits at both ends of the strip; take the nearer one
    const hueDistance = (Math.abs(goalHue - from.h) / 360) * PICKER_SIZE;
    if (hueDistance >= 0.5) {
      move("picker:hue", PICKER_MOVE_MS);
      press("picker:hue");
      emit(t, {drag: "hue", selected: false});
      drag(hueDistance, (progress) => ({h: lerp(from.h, goalHue, progress)}));
    }

    const svDistance = Math.hypot((to.s - from.s) * PICKER_SIZE, (to.v - from.v) * PICKER_SIZE);
    if (svDistance >= 0.5) {
      const reach = Math.min(1, PICKER_APPROACH_PX / svDistance);
      const grab = {s: to.s + (from.s - to.s) * reach, v: to.v + (from.v - to.v) * reach};
      emit(t, {grab});
      move("picker:grab", PICKER_MOVE_MS);
      press("picker:grab");
      emit(t, {drag: "spectrum", selected: false, grab: null, s: grab.s, v: grab.v});
      move("picker:spectrum", 0);
      drag(svDistance * reach, (progress) => ({s: lerp(grab.s, to.s, progress), v: lerp(grab.v, to.v, progress)}));
    }

    const alphaDistance = Math.abs(goal.a - start.a) * PICKER_SIZE;
    if (alphaDistance >= 0.5) {
      move("picker:alpha", PICKER_MOVE_MS);
      press("picker:alpha");
      emit(t, {drag: "alpha", selected: false});
      drag(alphaDistance, (progress) => ({a: lerp(start.a, goal.a, progress)}));
    }

    // The grid cannot reach every color; the header settles on the exact requested string.
    state = {
      ...state,
      h: goalHue,
      s: to.s,
      v: to.v,
      a: goal.a,
      rgb: {r: goal.r, g: goal.g, b: goal.b},
      text: value,
      css: cssColor(goal),
      darkText: needsDarkText(goal)
    };
    emit(t, {});
    t += PICKER_REVIEW_MS;

    move("picker:select", PICKER_MOVE_MS);
    emit(t, {hoverAtMs: t});
    t += PICKER_HOVER_MS;
    press("picker:select");
    emit(t, {selectAtMs: t});
    t += PICKER_CLICK_MS;
    emit(t, {closedAtMs: t});
    // md-color-picker writes the model when the close animation ends; ng-change then updates the widget.
    t += PICKER_CLOSE_MS;
    patch(t, {colorPicker: null, fieldValue: {id: field.id, value}});
  };
  const lookupField = (id: string) => {
    const field = fields.find((candidate) => candidate.id === id);
    if (!field) {
      throw new StudioError("TUTORIAL_FIELD_NOT_FOUND", `Tutorial field "${id}" is not a visible field in the widget FIELDS.`);
    }
    return field;
  };

  for (const step of tutorial.steps) {
    switch (step.action) {
      case "wait":
        t += step.ms;
        break;
      case "caption":
        patch(t, {caption: step.text});
        break;
      case "move":
        move(step.target, step.durationMs);
        break;
      case "click":
        click(step.target, targetId(step.target), step.durationMs);
        t += AFTER_CLICK_MS;
        break;
      case "selectLayer":
        selectLayer();
        break;
      case "openGroup":
        ensureGroup(step.group);
        break;
      case "setField": {
        const field = lookupField(step.field);
        const value = coerceFieldValue(field, step.value);
        ensureGroup(field.group);
        const target = `field:${field.id}` as const;
        if (field.type === "slider") {
          move(target);
          press(target);
          patch(t, {pressed: target});
          const from = Number(values[field.id] ?? field.min ?? 0);
          const samples = Math.max(1, Math.round(SLIDER_DRAG_MS / SLIDER_SAMPLE_MS));
          const stepSize = field.step ?? 1;
          for (let index = 1; index <= samples; index += 1) {
            const progress = index / samples;
            const eased = progress < 0.5 ? 2 * progress * progress : 1 - (-2 * progress + 2) ** 2 / 2;
            const raw = from + (value as number - from) * eased;
            const snapped = index === samples ? (value as number) : Math.round(raw / stepSize) * stepSize;
            patch(t + Math.round(progress * SLIDER_DRAG_MS), {fieldValue: {id: field.id, value: Number(snapped.toFixed(6))}});
          }
          t += SLIDER_DRAG_MS;
          patch(t, {pressed: null});
        } else if (field.type === "dropdown") {
          click(target, target);
          patch(t, {select: {field: field.id, hover: null}});
          t += AFTER_CLICK_MS;
          const index = field.options.findIndex((option) => option.value === value);
          move(`option:${field.id}:${index}`, 500);
          patch(t, {select: {field: field.id, hover: index}});
          press(`option:${field.id}:${index}`);
          t += PRESS_MS;
          patch(t, {select: null, fieldValue: {id: field.id, value}});
        } else if (field.type === "checkbox") {
          click(target, target);
          patch(t, {fieldValue: {id: field.id, value}});
        } else if (field.type === "colorpicker") {
          pickColor(field, value as string);
        } else if (TEXT_TYPES.has(field.type)) {
          click(target, target);
          patch(t, {focusField: field.id, selectAll: field.id});
          t += 320;
          patch(t, {selectAll: null, fieldValue: {id: field.id, value: ""}});
          typeInto((partial) => ({fieldValue: {id: field.id, value: partial}}), String(value));
          t += 220;
          patch(t, {focusField: null, fieldValue: {id: field.id, value}});
        } else {
          throw new StudioError(
            "TUTORIAL_FIELD_UNSUPPORTED",
            `Field "${field.id}" has type "${field.type}", which the tutorial editor cannot animate.`
          );
        }
        values[field.id] = value;
        widget.push({atMs: t, kind: "fields", fieldData: {[field.id]: value}});
        t += AFTER_CLICK_MS;
        break;
      }
      case "emulate": {
        const entry = EMULATE_MENU.find((candidate) => candidate.kind === step.event)!;
        let optionIndex = -1;
        if (entry.options.length > 0) {
          optionIndex = step.option === undefined ? 0 : entry.options.indexOf(step.option);
          if (optionIndex < 0 || entry.options[optionIndex] === "Custom...") {
            throw new StudioError(
              "TUTORIAL_EMULATE_OPTION_INVALID",
              `Emulate ${step.event} has no scripted option ${JSON.stringify(step.option)}.`,
              `Use one of: ${entry.options.filter((option) => option !== "Custom...").join(", ")}; set "amount" for other values.`
            );
          }
        } else if (step.option !== undefined) {
          throw new StudioError("TUTORIAL_EMULATE_OPTION_INVALID", `Emulate ${step.event} has no submenu options.`);
        }
        click("emulate", "emulate");
        patch(t, {menu: {hover: null, submenu: null, hoverOption: null}});
        t += AFTER_CLICK_MS;
        move(`menu:${entry.kind}`, 500);
        patch(t, {menu: {hover: entry.kind, submenu: optionIndex >= 0 ? entry.kind : null, hoverOption: null}});
        if (optionIndex >= 0) {
          t += 220;
          move(`menu-option:${entry.kind}:${optionIndex}`, 420);
          patch(t, {menu: {hover: entry.kind, submenu: entry.kind, hoverOption: optionIndex}});
          press(`menu-option:${entry.kind}:${optionIndex}`);
        } else {
          press(`menu:${entry.kind}`);
        }
        t += PRESS_MS;
        patch(t, {menu: null});
        const payload = emulatePayload(step, optionIndex >= 0 ? entry.options[optionIndex] : undefined);
        widget.push({atMs: t, kind: "dispatch", listener: payload.listener, event: payload.event});
        t += AFTER_CLICK_MS;
        break;
      }
      case "chat": {
        chatCount += 1;
        const id = `tutorial-chat-${chatCount}`;
        const badges = step.badges ?? (step.typed ? ["broadcaster"] : []);
        const color = step.color ?? colorFor(step.user);
        if (step.typed) {
          click("chat-input", "chat-input");
          patch(t, {chatFocus: true});
          t += 200;
          typeInto((partial) => ({chatDraft: partial}), step.text);
          t += 300;
        }
        const line: TutorialChatLine = {id, user: step.user, color, badges, text: step.text};
        patch(t, {chatAppend: line, ...(step.typed ? {chatDraft: "", chatFocus: false} : {})});
        widget.push({
          atMs: t,
          kind: "dispatch",
          listener: "message",
          event: chatMessageEvent({
            id,
            user: step.user,
            text: step.text,
            color,
            badges,
            channel,
            atMs: t,
            ...(step.data ? {data: step.data} : {})
          })
        });
        t += 400;
        break;
      }
      case "save":
        click("save", "save");
        patch(t, {toast: "Overlay saved"});
        patch(t + 2200, {toast: null});
        t += AFTER_CLICK_MS;
        break;
    }
  }

  for (const event of options.fixture?.events ?? []) {
    if (event.listener !== "message" || !event.event || typeof event.event !== "object" || Array.isArray(event.event)) continue;
    const data = (event.event as JsonObject).data;
    if (!data || typeof data !== "object" || Array.isArray(data)) continue;
    const user = String(data.displayName ?? data.nick ?? DEFAULT_VIEWER);
    const text = String(data.text ?? "");
    if (!text) continue;
    chatCount += 1;
    patch(event.atMs, {
      chatAppend: {
        id: `fixture-chat-${chatCount}`,
        user,
        text,
        color: typeof data.displayColor === "string" && data.displayColor ? data.displayColor : colorFor(user),
        badges: Array.isArray(data.badges)
          ? data.badges.flatMap((badge) =>
              badge && typeof badge === "object" && !Array.isArray(badge) && typeof badge.type === "string" ? [badge.type] : []
            )
          : []
      }
    });
  }

  const ordered = patches
    .map((entry, index) => ({entry, index}))
    .sort((left, right) => left.entry.atMs - right.entry.atMs || left.index - right.index)
    .map(({entry}) => entry);
  const overlay = tutorial.overlay ?? {width: 1920, height: 1080};
  return {
    endMs: Math.max(t, ...ordered.map((entry) => entry.atMs)),
    chrome: {
      overlayName: tutorial.overlayName ?? "My overlay",
      layerName: tutorial.layerName ?? "Custom widget",
      overlay,
      widget: {
        x: tutorial.widget?.x ?? overlay.width / 2,
        y: tutorial.widget?.y ?? overlay.height / 2,
        scale: tutorial.widget?.scale ?? 1
      },
      uiScale: tutorial.uiScale ?? 1,
      chat: {
        enabled: tutorial.chat?.enabled ?? (hasChatStep || (options.fixture?.events ?? []).some((event) => event.listener === "message")),
        title: tutorial.chat?.title ?? "Stream chat",
        channel
      },
      liveEmulation: tutorial.liveEmulation ?? false
    },
    fields,
    groups,
    initialValues,
    patches: ordered,
    moves,
    clicks,
    widget: widget.sort((left, right) => left.atMs - right.atMs)
  };
}
