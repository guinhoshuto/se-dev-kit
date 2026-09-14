import {FrameBridge, type FrameEvent} from "./bridge.js";
import type {
  FixtureDefinition,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  NormalizedField,
  RecipeDefinition,
  SceneDefinition,
  ScenarioDefinition,
  StageBackground,
  ThemeDefinition,
  TimelineEvent,
  WidgetViewport
} from "../types.js";

type CatalogKey = "scenes" | "themes" | "fixtures" | "scenarios";
type RouteMode = "studio" | "gallery";
type LogLevel = "info" | "success" | "warn" | "error";
type NamedCatalogItem = SceneDefinition | ThemeDefinition | FixtureDefinition | ScenarioDefinition;

const RUNTIME_SEED = 1_337;
const RUNTIME_FIXED_TIME = "2025-01-15T12:00:00.000Z";

interface ProjectPayload {
  studio: {
    version: string;
    origin: string;
    frameOrigin: string;
  };
  widget: {
    name: string;
    files: {html: string; css: string; js: string; fields: string};
    viewport: WidgetViewport;
    ready: {selector?: string; timeoutMs?: number};
  };
  channel: JsonObject;
  fields: NormalizedField[];
  fieldDefaults: JsonObject;
  rawFields: JsonValue;
  themes: ThemeDefinition[];
  fixtures: FixtureDefinition[];
  scenarios: ScenarioDefinition[];
  scenes: SceneDefinition[];
  recipes: RecipeDefinition[];
  limitations: string[];
}

interface GalleryVariant {
  key: string;
  id: string;
  name: string;
  description: string;
  scene: SceneDefinition | null;
  theme: ThemeDefinition | null;
  fixture: FixtureDefinition | null;
  viewport: WidgetViewport;
  background: StageBackground | null;
  camera: {scale: number; x: number; y: number; origin: string};
}

interface StudioState {
  project: ProjectPayload | null;
  route: RouteMode;
  activeCatalog: CatalogKey;
  selected: Record<CatalogKey, string | null>;
  bridge: FrameBridge | null;
  galleryBridges: FrameBridge[];
  galleryObservers: ResizeObserver[];
  manualOverrides: JsonObject;
  fieldValues: JsonObject;
  viewport: WidgetViewport;
  backgroundMode: "checker" | "charcoal" | "white" | "transparent" | "image" | "custom";
  backgroundColor: string;
  backgroundImage: string | null;
  cameraX: number;
  cameraY: number;
  zoom: number;
  runToken: number;
  runnerBusy: boolean;
  reloadSequence: number;
  fieldTimers: Map<string, number>;
  sourceReloadTimer: number;
  eventSource: EventSource | null;
}

const catalogLabels: Record<CatalogKey, string> = {
  scenes: "Scenes",
  themes: "Themes",
  fixtures: "Fixtures",
  scenarios: "Scenarios"
};

const state: StudioState = {
  project: null,
  route: window.location.pathname === "/gallery" ? "gallery" : "studio",
  activeCatalog: "scenes",
  selected: {scenes: null, themes: null, fixtures: null, scenarios: null},
  bridge: null,
  galleryBridges: [],
  galleryObservers: [],
  manualOverrides: {},
  fieldValues: {},
  viewport: {width: 430, height: 640, deviceScaleFactor: 1},
  backgroundMode: "checker",
  backgroundColor: "#16202a",
  backgroundImage: null,
  cameraX: 0,
  cameraY: 0,
  zoom: 100,
  runToken: 0,
  runnerBusy: false,
  reloadSequence: 0,
  fieldTimers: new Map(),
  sourceReloadTimer: 0,
  eventSource: null
};

function requiredElement<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Studio markup is missing #${id}.`);
  return node as T;
}

const elements = {
  shell: requiredElement<HTMLDivElement>("app-shell"),
  version: requiredElement<HTMLSpanElement>("studio-version"),
  widgetName: requiredElement<HTMLElement>("widget-name"),
  widgetFiles: requiredElement<HTMLSpanElement>("widget-files"),
  catalogTitle: requiredElement<HTMLSpanElement>("catalog-title"),
  catalogList: requiredElement<HTMLDivElement>("catalog-list"),
  catalogAction: requiredElement<HTMLButtonElement>("catalog-action"),
  connectionDot: requiredElement<HTMLSpanElement>("connection-dot"),
  connectionLabel: requiredElement<HTMLSpanElement>("connection-label"),
  workspaceKicker: requiredElement<HTMLSpanElement>("workspace-kicker"),
  workspaceTitle: requiredElement<HTMLHeadingElement>("workspace-title"),
  frameStatusDot: requiredElement<HTMLSpanElement>("frame-status-dot"),
  frameStatus: requiredElement<HTMLSpanElement>("frame-status"),
  viewportWidth: requiredElement<HTMLInputElement>("viewport-width"),
  viewportHeight: requiredElement<HTMLInputElement>("viewport-height"),
  backgroundMode: requiredElement<HTMLSelectElement>("background-mode"),
  backgroundColorWrap: requiredElement<HTMLLabelElement>("background-color-wrap"),
  backgroundColor: requiredElement<HTMLInputElement>("background-color"),
  zoom: requiredElement<HTMLInputElement>("zoom"),
  zoomOutput: requiredElement<HTMLOutputElement>("zoom-output"),
  reloadFrame: requiredElement<HTMLButtonElement>("reload-frame"),
  stageView: requiredElement<HTMLElement>("stage-view"),
  stageCanvas: requiredElement<HTMLDivElement>("stage-canvas"),
  stageFrameShell: requiredElement<HTMLDivElement>("stage-frame-shell"),
  widgetFrame: requiredElement<HTMLIFrameElement>("widget-frame"),
  frameLoading: requiredElement<HTMLDivElement>("frame-loading"),
  canvasSize: requiredElement<HTMLSpanElement>("canvas-size"),
  canvasBackground: requiredElement<HTMLSpanElement>("canvas-background"),
  galleryView: requiredElement<HTMLElement>("gallery-view"),
  gallerySummary: requiredElement<HTMLParagraphElement>("gallery-summary"),
  galleryGrid: requiredElement<HTMLDivElement>("gallery-grid"),
  inspectorNote: requiredElement<HTMLParagraphElement>("inspector-note"),
  fieldForm: requiredElement<HTMLFormElement>("field-form"),
  resetFields: requiredElement<HTMLButtonElement>("reset-fields"),
  eventLog: requiredElement<HTMLDivElement>("event-log"),
  clearLog: requiredElement<HTMLButtonElement>("clear-log"),
  fatalOverlay: requiredElement<HTMLDivElement>("fatal-overlay"),
  fatalMessage: requiredElement<HTMLParagraphElement>("fatal-message"),
  retryProject: requiredElement<HTMLButtonElement>("retry-project"),
  toastRegion: requiredElement<HTMLDivElement>("toast-region")
};

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneObject(value: JsonObject | undefined): JsonObject {
  return value ? structuredClone(value) : {};
}

function mergeObjects(...objects: (JsonObject | undefined)[]): JsonObject {
  const merged: JsonObject = {};
  for (const object of objects) {
    if (!object) continue;
    Object.assign(merged, structuredClone(object));
  }
  return merged;
}

function clampInteger(value: number, minimum: number, maximum: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.round(value))) : fallback;
}

function valueToText(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function valueToBoolean(value: JsonValue | undefined): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return ["true", "yes", "on", "1"].includes(value.toLowerCase());
  return false;
}

function encodeOption(value: JsonPrimitive): string {
  return JSON.stringify(value) ?? "null";
}

function decodeOption(value: string): JsonPrimitive {
  const decoded: unknown = JSON.parse(value);
  return typeof decoded === "string" || typeof decoded === "number" || typeof decoded === "boolean" || decoded === null
    ? decoded
    : value;
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function browserAssetUrl(value: string): string {
  if (/^[a-z]+:/i.test(value) || value.startsWith("//")) return value;
  const origin = state.project?.studio.frameOrigin ?? window.location.origin;
  const clean = (value.split(/[?#]/, 1)[0] ?? value).replaceAll("\\", "/").replace(/^\.\//, "");
  const encoded = clean.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return `${origin}/__sws/widget/${encoded}`;
}

function catalogItems(key: CatalogKey): NamedCatalogItem[] {
  const project = state.project;
  if (!project) return [];
  switch (key) {
    case "scenes": return project.scenes;
    case "themes": return project.themes;
    case "fixtures": return project.fixtures;
    case "scenarios": return project.scenarios;
  }
}

function findScene(id: string | null): SceneDefinition | null {
  return state.project?.scenes.find((item) => item.id === id) ?? null;
}

function findTheme(id: string | null): ThemeDefinition | null {
  return state.project?.themes.find((item) => item.id === id) ?? null;
}

function findFixture(id: string | null): FixtureDefinition | null {
  return state.project?.fixtures.find((item) => item.id === id) ?? null;
}

function findScenario(id: string | null): ScenarioDefinition | null {
  return state.project?.scenarios.find((item) => item.id === id) ?? null;
}

function selectedCatalogItem(key: CatalogKey): NamedCatalogItem | null {
  const selectedId = state.selected[key];
  return catalogItems(key).find((item) => item.id === selectedId) ?? null;
}

function resolveFieldValues(
  scene: SceneDefinition | null = findScene(state.selected.scenes),
  theme: ThemeDefinition | null = findTheme(state.selected.themes),
  fixture: FixtureDefinition | null = findFixture(state.selected.fixtures),
  manual: JsonObject = state.manualOverrides
): JsonObject {
  const project = state.project;
  if (!project) return {};
  return mergeObjects(project.fieldDefaults, theme?.fieldData, fixture?.fieldData, scene?.fieldData, manual);
}

function setConnection(status: "busy" | "ready" | "error", label: string): void {
  elements.connectionDot.className = `connection-dot is-${status}`;
  elements.connectionLabel.textContent = label;
}

function setFrameStatus(status: "busy" | "ready" | "error" | "idle", label: string): void {
  elements.frameStatusDot.className = status === "idle" ? "status-dot" : `status-dot is-${status}`;
  elements.frameStatus.textContent = label;
}

function logEvent(level: LogLevel, message: string): void {
  const entry = document.createElement("div");
  entry.className = "log-entry";
  entry.dataset.level = level;

  const time = document.createElement("span");
  time.className = "log-time";
  time.textContent = new Date().toLocaleTimeString([], {hour: "2-digit", minute: "2-digit", second: "2-digit"});

  const levelLabel = document.createElement("span");
  levelLabel.className = "log-level";
  levelLabel.textContent = level === "success" ? "ok" : level;

  const text = document.createElement("span");
  text.className = "log-message";
  text.textContent = message;

  entry.append(time, levelLabel, text);
  elements.eventLog.append(entry);
  while (elements.eventLog.childElementCount > 140) elements.eventLog.firstElementChild?.remove();
  elements.eventLog.scrollTop = elements.eventLog.scrollHeight;
}

function showToast(message: string): void {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  elements.toastRegion.append(toast);
  window.setTimeout(() => toast.remove(), 2800);
}

function showFatal(error: unknown): void {
  elements.fatalMessage.textContent = safeMessage(error);
  elements.fatalOverlay.hidden = false;
  elements.shell.setAttribute("aria-busy", "false");
  setConnection("error", "Project endpoint unavailable");
}

function updateRouteUi(): void {
  document.body.classList.toggle("is-gallery", state.route === "gallery");
  elements.stageView.hidden = state.route === "gallery";
  elements.galleryView.hidden = state.route !== "gallery";
  document.querySelectorAll<HTMLAnchorElement>(".route-link").forEach((link) => {
    link.classList.toggle("is-active", link.dataset.route === state.route);
  });
  elements.workspaceKicker.textContent = state.route === "gallery" ? "Variant overview" : "Interactive preview";
}

function renderProjectHeader(): void {
  const project = state.project;
  if (!project) return;
  elements.version.textContent = `v${project.studio.version} · local`;
  elements.widgetName.textContent = project.widget.name;
  elements.widgetFiles.textContent = [
    project.widget.files.html,
    project.widget.files.css,
    project.widget.files.js,
    project.widget.files.fields
  ].join(" · ");
  for (const key of Object.keys(catalogLabels) as CatalogKey[]) {
    const count = document.querySelector<HTMLElement>(`[data-count="${key}"]`);
    if (count) count.textContent = String(catalogItems(key).length);
  }
}

function renderWorkspaceTitle(): void {
  if (state.route === "gallery") {
    elements.workspaceTitle.textContent = "Preview gallery";
    setFrameStatus("ready", `${buildGalleryVariants().length} variants`);
    return;
  }
  const scene = findScene(state.selected.scenes);
  const theme = findTheme(state.selected.themes);
  elements.workspaceTitle.textContent = scene?.name ?? theme?.name ?? state.project?.widget.name ?? "Widget stage";
}

function renderCatalog(): void {
  elements.catalogTitle.textContent = catalogLabels[state.activeCatalog];
  document.querySelectorAll<HTMLButtonElement>(".catalog-tab").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.catalog === state.activeCatalog);
  });

  elements.catalogList.replaceChildren();
  const items = catalogItems(state.activeCatalog);
  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "catalog-empty";
    empty.textContent = `No ${catalogLabels[state.activeCatalog].toLowerCase()} were discovered for this widget.`;
    elements.catalogList.append(empty);
  } else {
    for (const item of items) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "catalog-item";
      button.classList.toggle("is-selected", state.selected[state.activeCatalog] === item.id);
      button.dataset.itemId = item.id;

      const name = document.createElement("strong");
      name.textContent = item.name;
      const description = document.createElement("span");
      description.textContent = item.description ?? item.id;
      button.append(name, description);
      button.addEventListener("click", () => void selectCatalogItem(state.activeCatalog, item.id));
      elements.catalogList.append(button);
    }
  }

  const runnable = state.activeCatalog === "fixtures" || state.activeCatalog === "scenarios";
  elements.catalogAction.hidden = !runnable || items.length === 0;
  if (runnable) {
    const noun = state.activeCatalog === "fixtures" ? "fixture" : "scenario";
    elements.catalogAction.textContent = state.route === "gallery" ? "Open in Studio" : state.runnerBusy ? "Running…" : `Run ${noun}`;
    elements.catalogAction.disabled = state.runnerBusy || !state.selected[state.activeCatalog];
  }
}

function setBackgroundFromScene(background: StageBackground | undefined): void {
  state.backgroundImage = background?.image ?? null;
  if (!background) {
    state.backgroundMode = "checker";
    state.backgroundColor = "#16202a";
    return;
  }
  if (background.checkerboard) {
    state.backgroundMode = "checker";
    return;
  }
  if (background.image) {
    state.backgroundMode = "image";
    if (background.color) state.backgroundColor = background.color;
    return;
  }
  if (background.color) {
    const normalized = background.color.toLowerCase();
    if (["#fff", "#ffffff", "white", "rgb(255,255,255)", "rgb(255, 255, 255)"].includes(normalized)) {
      state.backgroundMode = "white";
    } else if (normalized === "transparent") {
      state.backgroundMode = "transparent";
      state.backgroundColor = background.color;
    } else {
      state.backgroundMode = "custom";
      state.backgroundColor = background.color;
    }
    return;
  }
  state.backgroundMode = "transparent";
}

function adoptScene(scene: SceneDefinition, adoptReferences: boolean): void {
  state.selected.scenes = scene.id;
  if (adoptReferences) {
    state.selected.themes = scene.theme && findTheme(scene.theme) ? scene.theme : null;
    state.selected.fixtures = scene.fixture && findFixture(scene.fixture) ? scene.fixture : null;
  }
  state.viewport = structuredClone(scene.viewport ?? state.project?.widget.viewport ?? {width: 430, height: 640});
  setBackgroundFromScene(scene.background);
  state.cameraX = scene.camera?.x ?? 0;
  state.cameraY = scene.camera?.y ?? 0;
  state.zoom = Math.min(2_000, Math.max(5, Math.round((scene.camera?.scale ?? 1) * 100)));
}

function updateUrlSelection(): void {
  const url = new URL(window.location.href);
  for (const key of Object.keys(state.selected) as CatalogKey[]) {
    const parameter = key.slice(0, -1);
    const value = state.selected[key];
    if (value) url.searchParams.set(parameter, value);
    else url.searchParams.delete(parameter);
  }
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

async function selectCatalogItem(key: CatalogKey, id: string): Promise<void> {
  state.runToken += 1;
  if (state.runnerBusy) {
    state.runnerBusy = false;
    elements.reloadFrame.disabled = false;
  }
  state.selected[key] = id;
  if (key === "scenes") {
    const scene = findScene(id);
    if (scene) adoptScene(scene, true);
    state.manualOverrides = {};
  } else if (key === "themes" || key === "fixtures") {
    state.manualOverrides = {};
  }

  if (key !== "scenarios") state.fieldValues = resolveFieldValues();
  updateUrlSelection();
  renderCatalog();
  renderWorkspaceTitle();
  renderInspector();
  syncStageControls();

  if (state.route === "gallery") {
    focusGalleryItem(key, id);
    return;
  }
  if (key !== "scenarios") await reloadFrame(`${catalogLabels[key].slice(0, -1)} selected`, true);
}

function syncStageControls(): void {
  elements.viewportWidth.value = String(state.viewport.width);
  elements.viewportHeight.value = String(state.viewport.height);
  elements.backgroundMode.value = state.backgroundMode;
  elements.backgroundColor.value = /^#[0-9a-f]{6}$/i.test(state.backgroundColor) ? state.backgroundColor : "#16202a";
  elements.backgroundColorWrap.hidden = state.backgroundMode !== "custom";
  elements.zoom.value = String(Math.min(2_000, Math.max(5, state.zoom)));
  elements.zoomOutput.value = `${state.zoom}%`;
  updateStageGeometry();
  applyStageBackground();
}

function updateStageGeometry(): void {
  const bounds = elements.stageView.getBoundingClientRect();
  const availableWidth = Math.max(120, bounds.width - 28);
  const availableHeight = Math.max(120, bounds.height - 28);
  const scene = findScene(state.selected.scenes);
  const output = scene?.output ?? {width: state.viewport.width, height: state.viewport.height};
  const fit = Math.min(availableWidth / output.width, availableHeight / output.height, 1.5);
  const scale = fit * (state.zoom / 100);
  elements.stageCanvas.style.width = `${Math.max(1, output.width * fit)}px`;
  elements.stageCanvas.style.height = `${Math.max(1, output.height * fit)}px`;
  elements.stageFrameShell.style.width = `${state.viewport.width}px`;
  elements.stageFrameShell.style.height = `${state.viewport.height}px`;
  elements.stageFrameShell.style.transform = `translate(-50%, -50%) translate(${state.cameraX * fit}px, ${state.cameraY * fit}px) scale(${scale})`;
  elements.canvasSize.textContent = `${output.width} × ${output.height}`;
}

function applyStageBackground(): void {
  elements.stageCanvas.dataset.background = state.backgroundMode;
  elements.stageCanvas.style.backgroundColor = "";
  elements.stageCanvas.style.backgroundImage = "";
  elements.stageCanvas.style.backgroundSize = "";
  elements.stageCanvas.style.backgroundPosition = "";
  switch (state.backgroundMode) {
    case "checker":
      elements.canvasBackground.textContent = "Checkerboard";
      break;
    case "charcoal":
      elements.stageCanvas.style.backgroundColor = "#151b22";
      elements.canvasBackground.textContent = "Charcoal";
      break;
    case "white":
      elements.stageCanvas.style.backgroundColor = "#ffffff";
      elements.canvasBackground.textContent = "White";
      break;
    case "transparent":
      elements.canvasBackground.textContent = "Transparent";
      break;
    case "image": {
      const image = state.backgroundImage ? browserAssetUrl(state.backgroundImage) : null;
      elements.stageCanvas.style.backgroundColor = state.backgroundColor;
      elements.stageCanvas.style.backgroundImage = image ? `url("${image.replaceAll('"', '%22')}")` : "none";
      elements.stageCanvas.style.backgroundPosition = "center";
      elements.stageCanvas.style.backgroundSize = "cover";
      elements.canvasBackground.textContent = image ? "Scene image" : "Image unavailable";
      break;
    }
    case "custom":
      elements.stageCanvas.style.backgroundColor = state.backgroundColor;
      elements.canvasBackground.textContent = state.backgroundColor.toUpperCase();
      break;
  }
}

function fieldValue(field: NormalizedField): JsonValue {
  return state.fieldValues[field.id] ?? field.value;
}

function commitFieldValue(id: string, value: JsonValue, immediate = false): void {
  state.fieldValues = {...state.fieldValues, [id]: structuredClone(value)};
  state.manualOverrides = {...state.manualOverrides, [id]: structuredClone(value)};
  syncRawFieldEditor();

  const previousTimer = state.fieldTimers.get(id);
  if (previousTimer !== undefined) window.clearTimeout(previousTimer);
  const send = () => {
    state.fieldTimers.delete(id);
    void state.bridge?.updateFields({[id]: structuredClone(value)}).catch((error) => {
      logEvent("error", `Field update failed: ${safeMessage(error)}`);
    });
  };
  if (immediate) send();
  else state.fieldTimers.set(id, window.setTimeout(send, 90));
}

function makeFieldLabel(field: NormalizedField): HTMLLabelElement {
  const label = document.createElement("label");
  label.className = "field-label";
  const title = document.createElement("span");
  title.textContent = field.label;
  const key = document.createElement("span");
  key.className = "field-key";
  key.textContent = field.id;
  label.append(title, key);
  return label;
}

function createTextInput(field: NormalizedField, inputType: "text" | "number" = "text"): HTMLInputElement {
  const input = document.createElement("input");
  input.className = "control-input";
  input.type = inputType;
  input.value = valueToText(fieldValue(field));
  input.id = `field-${field.id}`;
  input.autocomplete = "off";
  if (inputType === "number") {
    if (field.min !== undefined) input.min = String(field.min);
    if (field.max !== undefined) input.max = String(field.max);
    input.step = String(field.step ?? 1);
  }
  input.addEventListener("input", () => {
    if (inputType === "number") {
      const number = Number(input.value);
      if (Number.isFinite(number)) commitFieldValue(field.id, number);
    } else {
      commitFieldValue(field.id, input.value);
    }
  });
  return input;
}

function createSliderControl(field: NormalizedField): HTMLElement {
  const pair = document.createElement("div");
  pair.className = "range-pair";
  const range = document.createElement("input");
  range.type = "range";
  range.min = String(field.min ?? 0);
  range.max = String(field.max ?? 100);
  range.step = String(field.step ?? 1);
  range.value = valueToText(fieldValue(field));
  range.id = `field-${field.id}`;
  const number = createTextInput(field, "number");
  number.removeAttribute("id");
  range.addEventListener("input", () => {
    const value = Number(range.value);
    number.value = range.value;
    commitFieldValue(field.id, value);
  });
  number.addEventListener("input", () => {
    if (number.value !== "") range.value = number.value;
  });
  pair.append(range, number);
  return pair;
}

function createCheckboxControl(field: NormalizedField): HTMLLabelElement {
  const label = document.createElement("label");
  label.className = "checkbox-control";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.id = `field-${field.id}`;
  input.checked = valueToBoolean(fieldValue(field));
  const track = document.createElement("span");
  track.className = "checkbox-track";
  input.addEventListener("change", () => commitFieldValue(field.id, input.checked, true));
  label.append(input, track);
  return label;
}

function createDropdownControl(field: NormalizedField): HTMLSelectElement {
  const select = document.createElement("select");
  select.className = "control-select";
  select.id = `field-${field.id}`;
  const current = fieldValue(field);
  const currentEncoded = encodeOption(
    typeof current === "string" || typeof current === "number" || typeof current === "boolean" || current === null
      ? current
      : valueToText(current)
  );
  let hasCurrent = false;
  for (const option of field.options) {
    const node = document.createElement("option");
    node.value = encodeOption(option.value);
    node.textContent = option.label;
    node.selected = node.value === currentEncoded;
    hasCurrent ||= node.selected;
    select.append(node);
  }
  if (!hasCurrent) {
    const custom = document.createElement("option");
    custom.value = currentEncoded;
    custom.textContent = valueToText(current) || "Not set";
    custom.selected = true;
    select.prepend(custom);
  }
  select.addEventListener("change", () => commitFieldValue(field.id, decodeOption(select.value), true));
  return select;
}

function normalizedHex(value: string): string {
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value);
  return short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : "#000000";
}

function createColorControl(field: NormalizedField): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "color-control";
  const swatch = document.createElement("input");
  swatch.type = "color";
  swatch.value = normalizedHex(valueToText(fieldValue(field)));
  swatch.setAttribute("aria-label", `${field.label} color picker`);
  const text = createTextInput(field);
  swatch.addEventListener("input", () => {
    text.value = swatch.value;
    commitFieldValue(field.id, swatch.value);
  });
  text.addEventListener("input", () => {
    if (/^#[0-9a-f]{3,6}$/i.test(text.value)) swatch.value = normalizedHex(text.value);
  });
  wrapper.append(swatch, text);
  return wrapper;
}

function createUnsupportedControl(field: NormalizedField): HTMLElement {
  const wrapper = document.createElement("div");
  const textarea = document.createElement("textarea");
  textarea.className = "control-textarea";
  textarea.value = JSON.stringify(fieldValue(field), null, 2);
  textarea.spellcheck = false;
  textarea.setAttribute("aria-label", `${field.label} raw JSON value`);
  const actions = document.createElement("div");
  actions.className = "raw-control-actions";
  const status = document.createElement("span");
  status.className = "inline-status";
  status.textContent = `${field.type} · raw JSON`;
  const apply = document.createElement("button");
  apply.type = "button";
  apply.className = "secondary-button";
  apply.textContent = "Apply";
  apply.addEventListener("click", () => {
    try {
      const parsed: unknown = JSON.parse(textarea.value);
      if (parsed === undefined) throw new Error("Value is undefined.");
      commitFieldValue(field.id, parsed as JsonValue, true);
      status.textContent = "Applied";
      status.classList.remove("is-error");
    } catch (error) {
      status.textContent = safeMessage(error);
      status.classList.add("is-error");
    }
  });
  actions.append(status, apply);
  wrapper.append(textarea, actions);
  return wrapper;
}

function createButtonControl(field: NormalizedField): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "secondary-button";
  button.textContent = "Trigger";
  button.addEventListener("click", () => {
    if (!state.bridge) return;
    void state.bridge.dispatch("widget-button", {field: field.id, value: structuredClone(fieldValue(field))}).catch((error) => {
      logEvent("error", `Widget button failed: ${safeMessage(error)}`);
    });
    logEvent("info", `Triggered widget button “${field.id}”.`);
  });
  return button;
}

function createFieldControl(field: NormalizedField): HTMLElement {
  switch (field.type) {
    case "number": return createTextInput(field, "number");
    case "slider": return createSliderControl(field);
    case "checkbox": return createCheckboxControl(field);
    case "dropdown": return createDropdownControl(field);
    case "color":
    case "colorpicker": return createColorControl(field);
    case "button": return createButtonControl(field);
    case "text":
    case "font":
    case "googlefont":
    case "image-input":
    case "video-input":
    case "sound-input": return createTextInput(field);
    default: return createUnsupportedControl(field);
  }
}

function syncRawFieldEditor(): void {
  const editor = document.querySelector<HTMLTextAreaElement>("#raw-field-editor");
  if (editor && document.activeElement !== editor) editor.value = JSON.stringify(state.fieldValues, null, 2);
}

function createRawFieldEditor(): HTMLDetailsElement {
  const details = document.createElement("details");
  details.className = "raw-field-data";
  const summary = document.createElement("summary");
  summary.textContent = "Raw field data";
  const editor = document.createElement("textarea");
  editor.className = "raw-editor";
  editor.id = "raw-field-editor";
  editor.value = JSON.stringify(state.fieldValues, null, 2);
  editor.spellcheck = false;
  editor.setAttribute("aria-label", "Raw field data JSON");
  const actions = document.createElement("div");
  actions.className = "raw-editor-actions";
  const status = document.createElement("span");
  status.className = "inline-status";
  status.textContent = "Object values are merged into the active preview.";
  const apply = document.createElement("button");
  apply.type = "button";
  apply.className = "secondary-button";
  apply.textContent = "Apply JSON";
  apply.addEventListener("click", () => {
    try {
      const parsed: unknown = JSON.parse(editor.value);
      if (!isJsonObject(parsed)) throw new Error("Field data must be a JSON object.");
      state.fieldValues = cloneObject(parsed);
      state.manualOverrides = cloneObject(parsed);
      void state.bridge?.updateFields(parsed).catch((error) => {
        status.textContent = safeMessage(error);
        status.classList.add("is-error");
      });
      status.textContent = "Applied to preview";
      status.classList.remove("is-error");
      logEvent("success", "Raw field data applied.");
      renderInspector();
    } catch (error) {
      status.textContent = safeMessage(error);
      status.classList.add("is-error");
    }
  });
  actions.append(status, apply);
  details.append(summary, editor, actions);
  return details;
}

function renderInspector(): void {
  const project = state.project;
  elements.fieldForm.replaceChildren();
  if (!project) return;

  elements.inspectorNote.textContent = `${project.fields.length} controls generated from ${project.widget.files.fields}. Unsupported values remain editable as raw JSON.`;
  const visibleFields = project.fields.filter((field) => field.type !== "hidden");
  const groups = new Map<string, NormalizedField[]>();
  for (const field of visibleFields) {
    const group = field.group?.trim() || (field.editable || field.type === "button" ? "General" : "Raw / unsupported");
    const items = groups.get(group) ?? [];
    items.push(field);
    groups.set(group, items);
  }

  if (groups.size === 0) {
    const empty = document.createElement("p");
    empty.className = "catalog-empty";
    empty.textContent = "This schema has no visible fields. Hidden values remain available in raw field data.";
    elements.fieldForm.append(empty);
  }

  for (const [group, fields] of groups) {
    const fieldset = document.createElement("fieldset");
    fieldset.className = "field-group";
    const legend = document.createElement("legend");
    legend.textContent = group;
    fieldset.append(legend);

    for (const field of fields) {
      const row = document.createElement("div");
      row.className = field.editable || field.type === "button" ? "field-row" : "field-row is-stacked";
      const label = makeFieldLabel(field);
      const control = createFieldControl(field);
      if (field.editable || field.type === "button") {
        const labelTarget = control.id || control.querySelector<HTMLElement>("[id]")?.id;
        if (labelTarget) label.htmlFor = labelTarget;
      } else {
        const badge = document.createElement("span");
        badge.className = "type-badge";
        badge.textContent = field.type;
        label.append(badge);
      }
      row.append(label, control);
      fieldset.append(row);
    }
    elements.fieldForm.append(fieldset);
  }
  elements.fieldForm.append(createRawFieldEditor());
}

function runtimeContext(fixture: FixtureDefinition | null = findFixture(state.selected.fixtures)): {
  fieldData: Record<string, unknown>;
  channel: Record<string, unknown>;
  recents: Record<string, unknown>;
  seed: number;
  fixedTime: string;
} {
  const project = state.project;
  return {
    fieldData: cloneObject(state.fieldValues),
    channel: mergeObjects(project?.channel, fixture?.channel),
    recents: cloneObject(fixture?.recents),
    seed: RUNTIME_SEED,
    fixedTime: RUNTIME_FIXED_TIME
  };
}

function handleFrameEvent(event: FrameEvent): void {
  const payload = isJsonObject(event.payload) ? event.payload : {};
  switch (event.type) {
    case "frame:console": {
      const level = typeof payload.level === "string" ? payload.level : "log";
      const message = typeof payload.message === "string" ? payload.message : "Widget console event";
      logEvent(level === "error" ? "error" : level === "warn" ? "warn" : "info", `[console.${level}] ${message}`);
      break;
    }
    case "frame:error": {
      const message = typeof payload.message === "string" ? payload.message : "Widget frame error";
      setFrameStatus("error", "Runtime error");
      logEvent("error", message);
      break;
    }
    case "frame:unhandled-rejection": {
      const message = typeof payload.message === "string" ? payload.message : "Unhandled widget rejection";
      logEvent("error", message);
      break;
    }
    case "frame:widget-load-dispatched":
      logEvent("info", "onWidgetLoad dispatched.");
      break;
    case "frame:event-dispatched": {
      const listener = typeof payload.listener === "string" ? payload.listener : "unknown";
      logEvent("info", `Event dispatched: ${listener}`);
      break;
    }
    case "frame:widget-ready":
      setFrameStatus("ready", "Ready");
      break;
    case "frame:fields-updated":
    case "frame:booted":
      break;
    default:
      logEvent("info", event.type);
  }
}

async function reloadFrame(reason: string, cancelRun = true, primeScene = true): Promise<boolean> {
  const project = state.project;
  if (!project || state.route !== "studio") return false;
  if (cancelRun) {
    state.runToken += 1;
    if (state.runnerBusy) {
      state.runnerBusy = false;
      elements.reloadFrame.disabled = false;
      renderCatalog();
    }
  }
  const sequence = ++state.reloadSequence;

  for (const timer of state.fieldTimers.values()) window.clearTimeout(timer);
  state.fieldTimers.clear();
  state.bridge?.destroy();
  state.bridge = null;
  elements.stageFrameShell.classList.add("is-reloading");
  elements.frameLoading.classList.remove("is-hidden");
  setFrameStatus("busy", "Starting isolated frame");
  logEvent("info", `${reason}; creating a clean widget session.`);

  const bridge = new FrameBridge(elements.widgetFrame, project.studio.frameOrigin, runtimeContext(), handleFrameEvent);
  state.bridge = bridge;
  try {
    await bridge.start((project.widget.ready.timeoutMs ?? 10_000) + 2_000);
    if (sequence !== state.reloadSequence) return false;
    const scene = findScene(state.selected.scenes);
    const fixture = findFixture(state.selected.fixtures);
    if (primeScene && scene?.captureAtMs !== undefined && fixture) {
      setFrameStatus("busy", `Playing ${fixture.name}`);
      const events = [...fixture.events]
        .filter((item) => item.atMs <= (scene.captureAtMs ?? 0))
        .sort((left, right) => left.atMs - right.atMs);
      const token = state.runToken;
      if (!(await runTimeline(events, token))) return false;
      const finalEventTime = events.at(-1)?.atMs ?? 0;
      if (scene.captureAtMs > finalEventTime) await sleep(scene.captureAtMs - finalEventTime);
      if (sequence !== state.reloadSequence || token !== state.runToken) return false;
      logEvent("success", `Scene fixture primed at ${scene.captureAtMs}ms.`);
    }
    elements.stageFrameShell.classList.remove("is-reloading");
    elements.frameLoading.classList.add("is-hidden");
    setFrameStatus("ready", "Ready");
    logEvent("success", "Widget frame ready.");
    return true;
  } catch (error) {
    if (sequence !== state.reloadSequence) return false;
    elements.stageFrameShell.classList.remove("is-reloading");
    elements.frameLoading.classList.add("is-hidden");
    setFrameStatus("error", "Failed to load");
    logEvent("error", `Frame failed: ${safeMessage(error)}`);
    showToast("Widget frame failed to load");
    return false;
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function runTimeline(events: TimelineEvent[], token: number): Promise<boolean> {
  let cursor = 0;
  const ordered = [...events].sort((left, right) => left.atMs - right.atMs);
  for (const item of ordered) {
    await sleep(Math.max(0, item.atMs - cursor));
    if (token !== state.runToken || !state.bridge) return false;
    await state.bridge.dispatch(item.listener, item.event);
    cursor = item.atMs;
  }
  return token === state.runToken;
}

function setRunnerBusy(busy: boolean): void {
  state.runnerBusy = busy;
  renderCatalog();
  elements.reloadFrame.disabled = busy;
}

async function runFixture(fixture: FixtureDefinition): Promise<void> {
  const token = ++state.runToken;
  state.selected.fixtures = fixture.id;
  state.manualOverrides = {};
  state.fieldValues = resolveFieldValues();
  updateUrlSelection();
  renderInspector();
  setRunnerBusy(true);
  logEvent("info", `Running fixture “${fixture.name}” with ${fixture.events.length} event${fixture.events.length === 1 ? "" : "s"}.`);
  try {
    if (!(await reloadFrame("Fixture state loaded", false, false)) || token !== state.runToken) return;
    const completed = await runTimeline(fixture.events, token);
    if (completed) {
      logEvent("success", `Fixture “${fixture.name}” completed.`);
      showToast(`Fixture complete · ${fixture.name}`);
    }
  } finally {
    if (token === state.runToken) setRunnerBusy(false);
  }
}

async function runScenario(scenario: ScenarioDefinition): Promise<void> {
  const token = ++state.runToken;
  const referencedScene = scenario.scene ? findScene(scenario.scene) : state.project?.scenes[0] ?? null;
  if (referencedScene) adoptScene(referencedScene, true);
  if (scenario.theme && findTheme(scenario.theme)) state.selected.themes = scenario.theme;
  if (scenario.fixture && findFixture(scenario.fixture)) state.selected.fixtures = scenario.fixture;
  state.selected.scenarios = scenario.id;
  state.manualOverrides = {};
  state.fieldValues = resolveFieldValues();
  updateUrlSelection();
  renderInspector();
  syncStageControls();
  renderWorkspaceTitle();
  setRunnerBusy(true);
  logEvent("info", `Running scenario “${scenario.name}” with ${scenario.steps.length} steps.`);

  let assertionCount = 0;
  try {
    if (!(await reloadFrame("Scenario state loaded", false, false)) || token !== state.runToken) return;
    const fixture = findFixture(state.selected.fixtures);
    if (fixture && !(await runTimeline(fixture.events, token))) return;

    for (const [index, step] of scenario.steps.entries()) {
      if (token !== state.runToken || !state.bridge) return;
      switch (step.action) {
        case "dispatch":
          await state.bridge.dispatch(step.listener, step.event);
          break;
        case "updateFields":
          state.fieldValues = mergeObjects(state.fieldValues, step.fieldData);
          state.manualOverrides = mergeObjects(state.manualOverrides, step.fieldData);
          await state.bridge.updateFields(step.fieldData);
          renderInspector();
          break;
        case "wait":
          await sleep(step.ms);
          break;
        case "assert":
          assertionCount += 1;
          logEvent("warn", `Step ${index + 1}: assertion for “${step.selector}” requires the CLI browser test.`);
          break;
      }
    }

    if (token === state.runToken) {
      if (assertionCount > 0) {
        logEvent(
          "warn",
          `Scenario actions finished; ${assertionCount} assertion${assertionCount === 1 ? "" : "s"} require CLI verification.`
        );
        showToast(`Actions finished · verify ${scenario.name} with CLI`);
      } else {
        logEvent("success", `Scenario “${scenario.name}” completed.`);
        showToast(`Scenario complete · ${scenario.name}`);
      }
    }
  } finally {
    if (token === state.runToken) setRunnerBusy(false);
  }
}

async function handleCatalogAction(): Promise<void> {
  if (state.route === "gallery") {
    const url = new URL("/", window.location.origin);
    const selectedId = state.selected[state.activeCatalog];
    if (selectedId) url.searchParams.set(state.activeCatalog.slice(0, -1), selectedId);
    window.location.href = url.href;
    return;
  }
  if (state.activeCatalog === "fixtures") {
    const fixture = findFixture(state.selected.fixtures);
    if (fixture) await runFixture(fixture);
  } else if (state.activeCatalog === "scenarios") {
    const scenario = findScenario(state.selected.scenarios);
    if (scenario) await runScenario(scenario);
  }
}

function variantFieldValues(variant: GalleryVariant): JsonObject {
  const project = state.project;
  if (!project) return {};
  return mergeObjects(project.fieldDefaults, variant.theme?.fieldData, variant.fixture?.fieldData, variant.scene?.fieldData);
}

function buildGalleryVariants(): GalleryVariant[] {
  const project = state.project;
  if (!project) return [];
  const variants: GalleryVariant[] = project.scenes.map((scene) => {
      const theme = project.themes.find((item) => item.id === scene.theme) ?? null;
      const fixture = project.fixtures.find((item) => item.id === scene.fixture) ?? null;
      return {
        key: `scene:${scene.id}`,
        id: scene.id,
        name: scene.name,
        description: scene.description ?? ([theme?.name, fixture?.name].filter(Boolean).join(" · ") || scene.id),
        scene,
        theme,
        fixture,
        viewport: structuredClone(scene.viewport ?? project.widget.viewport),
        background: scene.background ?? null,
        camera: {
          scale: scene.camera?.scale ?? 1,
          x: scene.camera?.x ?? 0,
          y: scene.camera?.y ?? 0,
          origin: scene.camera?.origin ?? "center center"
        }
      };
    });
  if (project.themes.length > 0) {
    const baseScene = project.scenes[0] ?? null;
    const baseFixture = project.fixtures.find((item) => item.id === baseScene?.fixture) ?? project.fixtures[0] ?? null;
    variants.push(...project.themes.map((theme) => ({
      key: `theme:${theme.id}`,
      id: theme.id,
      name: theme.name,
      description: theme.description ?? `Theme on ${baseScene?.name ?? "default widget"}`,
      scene: baseScene,
      theme,
      fixture: baseFixture,
      viewport: structuredClone(baseScene?.viewport ?? project.widget.viewport),
      background: baseScene?.background ?? null,
      camera: {
        scale: baseScene?.camera?.scale ?? 1,
        x: baseScene?.camera?.x ?? 0,
        y: baseScene?.camera?.y ?? 0,
        origin: baseScene?.camera?.origin ?? "center center"
      }
    })));
  }
  if (variants.length === 0) {
    variants.push({
      key: "default:widget",
      id: "widget",
      name: project.widget.name,
      description: "Default field values",
      scene: null,
      theme: null,
      fixture: project.fixtures[0] ?? null,
      viewport: structuredClone(project.widget.viewport),
      background: null,
      camera: {scale: 1, x: 0, y: 0, origin: "center center"}
    });
  }
  return variants;
}

function applyGalleryBackground(element: HTMLElement, background: StageBackground | null): void {
  element.style.backgroundColor = "";
  element.style.backgroundImage = "";
  if (background?.image) {
    element.style.backgroundColor = background.color ?? "#0c1116";
    element.style.backgroundImage = `url("${browserAssetUrl(background.image).replaceAll('"', '%22')}")`;
    element.style.backgroundPosition = "center";
    element.style.backgroundSize = "cover";
  } else if (background?.color) {
    element.style.backgroundColor = background.color;
    element.style.backgroundImage = "none";
  } else if (background && !background.checkerboard) {
    element.style.backgroundColor = "#0c1116";
    element.style.backgroundImage = "radial-gradient(circle, rgba(122,145,164,.16) .8px, transparent .9px)";
    element.style.backgroundSize = "16px 16px";
  }
}

function cleanupGallery(): void {
  for (const bridge of state.galleryBridges) bridge.destroy();
  for (const observer of state.galleryObservers) observer.disconnect();
  state.galleryBridges = [];
  state.galleryObservers = [];
  elements.galleryGrid.replaceChildren();
}

async function primeGalleryFixture(bridge: FrameBridge, fixture: FixtureDefinition | null): Promise<void> {
  if (!fixture) return;
  for (const item of [...fixture.events].sort((left, right) => left.atMs - right.atMs).slice(0, 20)) {
    await bridge.dispatch(item.listener, item.event);
    await sleep(28);
  }
}

function createGalleryCard(variant: GalleryVariant): HTMLElement {
  const project = state.project;
  if (!project) return document.createElement("article");

  const card = document.createElement("article");
  card.className = "gallery-card";
  card.dataset.variantKey = variant.key;
  const preview = document.createElement("div");
  preview.className = "gallery-preview";
  applyGalleryBackground(preview, variant.background);
  const shell = document.createElement("div");
  shell.className = "gallery-frame-shell";
  shell.style.width = `${variant.viewport.width}px`;
  shell.style.height = `${variant.viewport.height}px`;
  shell.style.transformOrigin = variant.camera.origin;
  const iframe = document.createElement("iframe");
  iframe.title = `${variant.name} preview`;
  iframe.sandbox.add("allow-scripts", "allow-same-origin");
  iframe.referrerPolicy = "no-referrer";
  shell.append(iframe);
  preview.append(shell);

  const meta = document.createElement("div");
  meta.className = "gallery-card-meta";
  const copy = document.createElement("a");
  copy.className = "gallery-card-copy";
  const url = new URL("/", window.location.origin);
  const variantKind = variant.key.split(":", 1)[0];
  url.searchParams.set(variantKind === "scene" || variantKind === "theme" ? variantKind : "preview", variant.id);
  copy.href = url.href;
  const title = document.createElement("strong");
  title.textContent = variant.name;
  const description = document.createElement("span");
  description.textContent = `${variant.viewport.width} × ${variant.viewport.height} · ${variant.description}`;
  copy.append(title, description);
  const status = document.createElement("span");
  status.className = "gallery-card-status";
  status.textContent = "Starting";
  meta.append(copy, status);
  card.append(preview, meta);

  const observer = new ResizeObserver(() => {
    const bounds = preview.getBoundingClientRect();
    const output = variant.scene?.output ?? variant.viewport;
    const fit = Math.min((bounds.width - 30) / output.width, (bounds.height - 28) / output.height);
    const scale = Math.max(0.02, fit * variant.camera.scale);
    shell.style.transform = `translate(-50%, -50%) translate(${variant.camera.x * fit}px, ${variant.camera.y * fit}px) scale(${scale})`;
  });
  observer.observe(preview);
  state.galleryObservers.push(observer);

  const bridge = new FrameBridge(
    iframe,
    project.studio.frameOrigin,
    {
      fieldData: variantFieldValues(variant),
      channel: mergeObjects(project.channel, variant.fixture?.channel),
      recents: cloneObject(variant.fixture?.recents),
      seed: RUNTIME_SEED,
      fixedTime: RUNTIME_FIXED_TIME
    },
    (event) => {
      if (event.type === "frame:error" || event.type === "frame:unhandled-rejection") {
        status.textContent = "Error";
        status.className = "gallery-card-status is-error";
      }
    }
  );
  state.galleryBridges.push(bridge);
  void bridge.start((project.widget.ready.timeoutMs ?? 10_000) + 2_000)
    .then(async () => {
      status.textContent = "Ready";
      status.className = "gallery-card-status is-ready";
      await primeGalleryFixture(bridge, variant.fixture);
    })
    .catch((error) => {
      status.textContent = "Failed";
      status.className = "gallery-card-status is-error";
      logEvent("error", `${variant.name}: ${safeMessage(error)}`);
    });
  return card;
}

function renderGallery(): void {
  cleanupGallery();
  const variants = buildGalleryVariants();
  const visible = variants.slice(0, 32);
  elements.gallerySummary.textContent = variants.length > 32
    ? `Showing 32 of ${variants.length} variants. Use recipes for larger deterministic matrices.`
    : `${variants.length} isolated ${variants.length === 1 ? "preview" : "previews"}, loaded from production widget files.`;
  if (visible.length === 0) {
    const empty = document.createElement("div");
    empty.className = "gallery-empty";
    empty.textContent = "No scenes or themes were discovered. Add a scene or theme catalog to build a gallery.";
    elements.galleryGrid.append(empty);
    return;
  }
  for (const variant of visible) elements.galleryGrid.append(createGalleryCard(variant));
}

function focusGalleryItem(key: CatalogKey, id: string): void {
  if (key !== "scenes" && key !== "themes") return;
  const variantKey = `${key.slice(0, -1)}:${id}`;
  const card = Array.from(elements.galleryGrid.querySelectorAll<HTMLElement>(".gallery-card"))
    .find((item) => item.dataset.variantKey === variantKey);
  if (!card) {
    showToast("This item is not a standalone gallery variant");
    return;
  }
  card.scrollIntoView({behavior: "smooth", block: "center"});
  card.classList.add("is-highlighted");
  window.setTimeout(() => card.classList.remove("is-highlighted"), 1100);
}

function initializeSelection(): void {
  const project = state.project;
  if (!project) return;
  const parameters = new URLSearchParams(window.location.search);
  const requestedScene = parameters.get("scene");
  const scene = project.scenes.find((item) => item.id === requestedScene) ?? project.scenes[0] ?? null;
  if (scene) adoptScene(scene, true);
  else state.viewport = structuredClone(project.widget.viewport);

  const requestedTheme = parameters.get("theme");
  const theme = project.themes.find((item) => item.id === requestedTheme) ?? (!scene ? project.themes[0] : null);
  if (theme) state.selected.themes = theme.id;

  const requestedFixture = parameters.get("fixture");
  const fixture = project.fixtures.find((item) => item.id === requestedFixture);
  if (fixture) state.selected.fixtures = fixture.id;

  const requestedScenario = parameters.get("scenario");
  const scenario = project.scenarios.find((item) => item.id === requestedScenario) ?? project.scenarios[0] ?? null;
  if (scenario) state.selected.scenarios = scenario.id;

  state.fieldValues = resolveFieldValues();
}

function connectSourceEvents(): void {
  state.eventSource?.close();
  const source = new EventSource("/__sws/events");
  state.eventSource = source;
  source.addEventListener("connected", () => setConnection("ready", "Local runtime connected"));
  source.addEventListener("change", (message) => {
    let file = "Widget source";
    try {
      const parsed: unknown = JSON.parse((message as MessageEvent<string>).data);
      if (isJsonObject(parsed) && typeof parsed.file === "string") file = parsed.file;
    } catch {
      // Keep the generic label.
    }
    logEvent("info", `${file} changed on disk.`);
    showToast("Project changed · refreshing Studio data");
    window.clearTimeout(state.sourceReloadTimer);
    state.sourceReloadTimer = window.setTimeout(() => window.location.reload(), 180);
  });
  source.addEventListener("error", () => setConnection("error", "Runtime event stream disconnected"));
}

function bindStaticEvents(): void {
  document.querySelectorAll<HTMLButtonElement>(".catalog-tab").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.catalog;
      if (key === "scenes" || key === "themes" || key === "fixtures" || key === "scenarios") {
        state.activeCatalog = key;
        renderCatalog();
      }
    });
  });

  elements.catalogAction.addEventListener("click", () => void handleCatalogAction());
  elements.reloadFrame.addEventListener("click", () => void reloadFrame("Manual reload", true));
  elements.clearLog.addEventListener("click", () => elements.eventLog.replaceChildren());
  elements.retryProject.addEventListener("click", () => window.location.reload());

  elements.resetFields.addEventListener("click", () => {
    state.manualOverrides = {};
    state.fieldValues = resolveFieldValues();
    renderInspector();
    void reloadFrame("Fields reset", true);
  });

  const updateViewport = () => {
    state.viewport = {
      ...state.viewport,
      width: clampInteger(Number(elements.viewportWidth.value), 1, 16_384, state.viewport.width),
      height: clampInteger(Number(elements.viewportHeight.value), 1, 16_384, state.viewport.height)
    };
    elements.viewportWidth.value = String(state.viewport.width);
    elements.viewportHeight.value = String(state.viewport.height);
    updateStageGeometry();
  };
  elements.viewportWidth.addEventListener("change", updateViewport);
  elements.viewportHeight.addEventListener("change", updateViewport);

  elements.backgroundMode.addEventListener("change", () => {
    const value = elements.backgroundMode.value;
    if (value === "checker" || value === "charcoal" || value === "white" || value === "transparent" || value === "image" || value === "custom") {
      state.backgroundMode = value;
      elements.backgroundColorWrap.hidden = value !== "custom";
      applyStageBackground();
    }
  });
  elements.backgroundColor.addEventListener("input", () => {
    state.backgroundColor = elements.backgroundColor.value;
    applyStageBackground();
  });
  elements.zoom.addEventListener("input", () => {
    state.zoom = Number(elements.zoom.value);
    elements.zoomOutput.value = `${state.zoom}%`;
    updateStageGeometry();
  });

  const stageObserver = new ResizeObserver(() => updateStageGeometry());
  stageObserver.observe(elements.stageView);
  window.addEventListener("beforeunload", () => {
    stageObserver.disconnect();
    state.bridge?.destroy();
    cleanupGallery();
    state.eventSource?.close();
  });
}

async function bootstrap(): Promise<void> {
  updateRouteUi();
  setConnection("busy", "Loading local project");
  try {
    const response = await fetch("/__sws/api/project", {headers: {Accept: "application/json"}});
    if (!response.ok) throw new Error(`Project endpoint returned HTTP ${response.status}.`);
    state.project = await response.json() as ProjectPayload;
    initializeSelection();
    renderProjectHeader();
    renderCatalog();
    renderInspector();
    syncStageControls();
    renderWorkspaceTitle();
    connectSourceEvents();
    elements.shell.setAttribute("aria-busy", "false");
    elements.fatalOverlay.hidden = true;
    setConnection("ready", "Local runtime connected");

    if (state.route === "gallery") {
      renderGallery();
      logEvent("success", "Gallery variants initialized.");
    } else {
      await reloadFrame("Project loaded", false);
    }
  } catch (error) {
    showFatal(error);
  }
}

bindStaticEvents();
void bootstrap();
