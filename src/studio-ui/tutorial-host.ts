type Primitive = string | number | boolean | null;
type Target = string | {x: number; y: number};

interface ChatLine {
  id: string;
  user: string;
  color: string;
  badges: string[];
  text: string;
}

interface UiPatch {
  selected?: boolean;
  settingsOpen?: boolean;
  openGroup?: string | null;
  menu?: {hover: string | null; submenu: string | null; hoverOption: number | null} | null;
  select?: {field: string; hover: number | null} | null;
  focusField?: string | null;
  selectAll?: string | null;
  fieldValue?: {id: string; value: Primitive};
  caption?: string | null;
  chatDraft?: string;
  chatFocus?: boolean;
  chatAppend?: ChatLine;
  pressed?: string | null;
  toast?: string | null;
}

interface PanelField {
  id: string;
  label: string;
  type: string;
  group: string;
  min?: number;
  max?: number;
  step?: number;
  options: {label: string; value: Primitive}[];
}

interface MenuEntry {
  kind: string;
  label: string;
  icon: string;
  options: string[];
}

interface Timeline {
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
  fields: PanelField[];
  groups: string[];
  initialValues: Record<string, Primitive>;
  patches: {atMs: number; patch: UiPatch}[];
  moves: {startMs: number; endMs: number; to: Target}[];
  clicks: number[];
}

interface SetupOptions {
  timeline: Timeline;
  menu: MenuEntry[];
  viewport: {width: number; height: number};
  output: {width: number; height: number};
}

interface UiState {
  selected: boolean;
  settingsOpen: boolean;
  openGroup: string | null;
  menu: {hover: string | null; submenu: string | null; hoverOption: number | null} | null;
  select: {field: string; hover: number | null} | null;
  focusField: string | null;
  selectAll: string | null;
  values: Record<string, Primitive>;
  swatches: Record<string, string>;
  caption: string | null;
  chatDraft: string;
  chatFocus: boolean;
  chat: ChatLine[];
  pressed: string | null;
  toast: string | null;
}

declare global {
  interface Window {
    __SWS_TUTORIAL__: TutorialController;
  }
}

/* Material icon paths (24px grid) used by the StreamElements overlay editor. */
const ICONS: Record<string, string> = {
  arrow_back: "M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z",
  help: "M11 18h2v-2h-2v2zm1-16C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm0-14c-2.21 0-4 1.79-4 4h2c0-1.1.9-2 2-2s2 .9 2 2c0 2-3 1.75-3 5h2c0-2.25 3-2.5 3-5 0-2.21-1.79-4-4-4z",
  stream: "M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 1.99-.9 1.99-2L23 5c0-1.1-.9-2-2-2zm0 14H3V5h18v12zM9 8.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm6 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM6 15c0-1.33 2-2 3-2s3 .67 3 2v.5H6V15zm6 0c0-1.33 2-2 3-2s3 .67 3 2v.5h-6V15z",
  link: "M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z",
  layers: "M4 15h16v-2H4v2zm0 4h16v-2H4v2zm0-8h16V9H4v2zm0-6v2h16V5H4z",
  build: "M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z",
  crop_free: "M3 5v4h2V5h4V3H5c-1.1 0-2 .9-2 2zm2 10H3v4c0 1.1.9 2 2 2h4v-2H5v-4zm14 4h-4v2h4c1.1 0 2-.9 2-2v-4h-2v4zm0-16h-4v2h4v4h2V5c0-1.1-.9-2-2-2z",
  movie_filter: "M18 4l2 3h-3l-2-3h-2l2 3h-3l-2-3H8l2 3H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4zm-6.75 11.25L10 18l-1.25-2.75L6 14l2.75-1.25L10 10l1.25 2.75L14 14l-2.75 1.25zm5.69-3.31L16 14l-.94-2.06L13 11l2.06-.94L16 8l.94 2.06L19 11l-2.06.94z",
  folder_off: "M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-3.5 10.1-1.4 1.4-2.1-2.1-2.1 2.1-1.4-1.4 2.1-2.1-2.1-2.1 1.4-1.4 2.1 2.1 2.1-2.1 1.4 1.4-2.1 2.1 2.1 2.1z",
  folder: "M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z",
  copy: "M3 5H1v16c0 1.1.9 2 2 2h16v-2H3V5zm18-4H7c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V3c0-1.1-.9-2-2-2zm0 16H7V3h14v14z",
  delete: "M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z",
  photo_library: "M22 16V4c0-1.1-.9-2-2-2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2zm-11-4l2.03 2.71L16 11l4 5H8l3-4zM2 6v14c0 1.1.9 2 2 2h14v-2H4V6H2z",
  visibility: "M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z",
  lock_open: "M12 17c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm6-9h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6h1.9c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm0 12H6V10h12v10z",
  expand_more: "M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z",
  expand_less: "M12 8l-6 6 1.41 1.41L12 10.83l4.59 4.58L18 14z",
  chevron_right: "M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z",
  chevron_left: "M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z",
  arrow_drop_down: "M7 10l5 5 5-5z",
  check: "M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z",
  upload: "M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z",
  add: "M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z",
  notifications: "M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z",
  undo: "M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z",
  redo: "M18.4 10.6C16.55 8.99 14.15 8 11.5 8c-4.65 0-8.58 3.03-9.96 7.22L3.9 16c1.05-3.19 4.05-5.5 7.6-5.5 1.95 0 3.73.72 5.12 1.88L13 16h9V7l-3.6 3.6z",
  zoom_in: "M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14zm2.5-4h-2v2H9v-2H7V9h2V7h1v2h2v1z",
  zoom_out: "M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14zM7 9h5v1H7z",
  fullscreen: "M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z",
  fullscreen_exit: "M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z",
  grid_on: "M20 2H4c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM8 20H4v-4h4v4zm0-6H4v-4h4v4zm0-6H4V4h4v4zm6 12h-4v-4h4v4zm0-6h-4v-4h4v4zm0-6h-4V4h4v4zm6 12h-4v-4h4v4zm0-6h-4v-4h4v4zm0-6h-4V4h4v4z",
  volume_up: "M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z",
  favorite: "M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z",
  subscriber: "M9 17l3-2.94c-.39-.04-.68-.06-1-.06-2.67 0-8 1.34-8 4v2h9l-3-3zm2-5c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm4.47 8.5L12 17l1.4-1.41 2.07 2.08 5.13-5.17 1.4 1.41z",
  credit_card: "M20 4H4c-1.11 0-1.99.89-1.99 2L2 18c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V6c0-1.11-.89-2-2-2zm0 14H4v-6h16v6zm0-10H4V6h16v2z",
  cheer: "M20 8.69V4h-4.69L12 .69 8.69 4H4v4.69L.69 12 4 15.31V20h4.69L12 23.31 15.31 20H20v-4.69L23.31 12 20 8.69zM12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6 6 2.69 6 6-2.69 6-6 6zm0-10c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4z",
  people: "M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z",
  redeem: "M20 6h-2.18c.11-.31.18-.65.18-1 0-1.66-1.34-3-3-3-1.05 0-1.96.54-2.5 1.35l-.5.67-.5-.68C10.96 2.54 10.05 2 9 2 7.34 2 6 3.34 6 5c0 .35.07.69.18 1H4c-1.11 0-1.99.89-1.99 2L2 19c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V8c0-1.11-.89-2-2-2zm-5-2c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zM9 4c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm11 15H4v-2h16v2zm0-5H4V8h5.08L7 10.83 8.62 12 11 8.76l1-1.36 1 1.36L15.38 12 17 10.83 14.92 8H20v6z",
  face: "M9 11.75c-.69 0-1.25.56-1.25 1.25s.56 1.25 1.25 1.25 1.25-.56 1.25-1.25-.56-1.25-1.25-1.25zm6 0c-.69 0-1.25.56-1.25 1.25s.56 1.25 1.25 1.25 1.25-.56 1.25-1.25-.56-1.25-1.25-1.25zM12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8 0-.29.02-.58.05-.86 2.36-1.05 4.23-2.98 5.21-5.37C11.07 8.33 14.05 10 17.42 10c.78 0 1.53-.09 2.25-.26.21.71.33 1.47.33 2.26 0 4.41-3.59 8-8 8z",
  attach_money: "M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1h-2.2c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4z",
  charity: "M16 2.5c-1.2 0-2.3.6-3 1.5-.7-.9-1.8-1.5-3-1.5-2.1 0-3.7 1.6-3.7 3.6 0 2.6 2.7 4.8 6.7 8.4 4-3.6 6.7-5.8 6.7-8.4 0-2-1.6-3.6-3.7-3.6zM1 11h4v11H1V11zm15 4.5-7.4 2.3L7 17.2V13h1.8l6.4 2.3c.5.2.8.7.8 1.2zM6.5 21.5v-3.2l2.4.8 8.2-2.6h1.4c1.2 0 2.2.9 2.3 2.1L12.9 22l-6.4-.5z",
  dots: "M7 13a3 3 0 1 1 0 6 3 3 0 0 1 0-6zm10-2a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM12 4a3 3 0 1 1 0 6 3 3 0 0 1 0-6z"
};

function icon(name: string, className = ""): string {
  return `<svg class="i ${className}" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[name] ?? ""}"/></svg>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function attr(value: string): string {
  return escapeHtml(value);
}

const COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$|^rgba?\([^)]*\)$/i;
const BADGE_COLORS: Record<string, string> = {broadcaster: "#e91916", moderator: "#00ad03", vip: "#e005b9", subscriber: "#8205b4"};

function ease(progress: number): number {
  return progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
}

class TutorialController {
  readonly stage = document.querySelector<HTMLElement>("#capture-stage")!;
  readonly editor = document.querySelector<HTMLElement>("#se-editor")!;
  readonly toolbar = document.querySelector<HTMLElement>("#se-toolbar")!;
  readonly sidebar = document.querySelector<HTMLElement>("#se-sidebar")!;
  readonly canvas = document.querySelector<HTMLElement>("#se-canvas")!;
  readonly overlay = document.querySelector<HTMLElement>("#se-overlay")!;
  readonly widgetBox = document.querySelector<HTMLElement>("#se-widget-box")!;
  readonly caption = document.querySelector<HTMLElement>("#se-caption")!;
  readonly bottom = document.querySelector<HTMLElement>("#se-bottom")!;
  readonly menuLayer = document.querySelector<HTMLElement>("#se-menu-layer")!;
  readonly toast = document.querySelector<HTMLElement>("#se-toast")!;
  readonly chat = document.querySelector<HTMLElement>("#se-chat")!;
  readonly popupLayer = document.querySelector<HTMLElement>("#se-popup-layer")!;
  readonly cursor = document.querySelector<SVGElement>("#se-cursor")!;
  readonly ripple = document.querySelector<HTMLElement>("#se-ripple")!;
  timeline?: Timeline;
  menu: MenuEntry[] = [];
  viewport = {width: 0, height: 0};
  scale = 1;
  #rendered: Record<string, string> = {};
  #positions = new Map<string, {x: number; y: number}>();
  #cursor = {x: 0, y: 0};
  #segment = -1;
  #segmentFrom = {x: 0, y: 0};

  setup(options: SetupOptions): void {
    this.timeline = options.timeline;
    this.menu = options.menu;
    this.viewport = options.viewport;
    const {chrome} = options.timeline;
    this.scale = chrome.uiScale;
    const width = options.output.width / this.scale;
    const height = options.output.height / this.scale;
    this.editor.style.width = `${width}px`;
    this.editor.style.height = `${height}px`;
    this.editor.style.transform = `scale(${this.scale})`;
    const chatWidth = chrome.chat.enabled ? 340 : 0;
    this.chat.style.display = chrome.chat.enabled ? "flex" : "none";
    this.canvas.style.right = `${chatWidth}px`;
    const canvasWidth = width - 320 - chatWidth;
    const overlayScale = Math.max(0.05, (canvasWidth - 12) / chrome.overlay.width);
    this.overlay.style.width = `${chrome.overlay.width}px`;
    this.overlay.style.height = `${chrome.overlay.height}px`;
    this.overlay.style.transform = `scale(${overlayScale})`;
    const spacing = 12 / overlayScale;
    const radius = 1.05 / overlayScale;
    this.overlay.style.backgroundImage = `radial-gradient(circle, rgba(118,118,214,.6) ${radius}px, transparent ${radius + 0.6 / overlayScale}px)`;
    this.overlay.style.backgroundSize = `${spacing}px ${spacing}px`;
    this.overlay.style.backgroundPosition = `${spacing / 2}px ${spacing / 2}px`;
    this.widgetBox.style.setProperty("--inv", String(1 / overlayScale / chrome.widget.scale));
    this.toolbar.innerHTML = [
      `<span data-target="back">${icon("arrow_back")}</span>`,
      `<div class="title">${escapeHtml(chrome.overlayName)}</div>`,
      `<div class="spacer"></div>`,
      `<span class="icon-btn">${icon("help")}</span>`,
      `<span class="icon-btn">${icon("stream")}</span>`,
      `<span class="icon-btn">${icon("link")}</span>`,
      `<span class="se-btn ghost" data-target="preview">Preview</span>`,
      `<span class="se-btn raised" data-target="save">Save</span>`
    ].join("");
    this.#cursor = {x: options.output.width * 0.62, y: options.output.height * 0.58};
    this.#segment = -1;
    this.#positions.clear();
    this.#rendered = {};
  }

  #state(timeMs: number): UiState {
    const timeline = this.timeline!;
    const state: UiState = {
      selected: false,
      settingsOpen: false,
      openGroup: null,
      menu: null,
      select: null,
      focusField: null,
      selectAll: null,
      values: {...timeline.initialValues},
      swatches: {},
      caption: null,
      chatDraft: "",
      chatFocus: false,
      chat: [],
      pressed: null,
      toast: null
    };
    for (const field of timeline.fields) {
      const value = state.values[field.id];
      if (field.type === "colorpicker" && typeof value === "string" && COLOR.test(value)) state.swatches[field.id] = value;
    }
    for (const {atMs, patch} of timeline.patches) {
      if (atMs > timeMs) break;
      if (patch.fieldValue) {
        const {id, value} = patch.fieldValue;
        state.values[id] = value;
        if (typeof value === "string" && COLOR.test(value)) state.swatches[id] = value;
      }
      if (patch.chatAppend) state.chat.push(patch.chatAppend);
      for (const key of [
        "selected",
        "settingsOpen",
        "openGroup",
        "menu",
        "select",
        "focusField",
        "selectAll",
        "caption",
        "chatDraft",
        "chatFocus",
        "pressed",
        "toast"
      ] as const) {
        if (key in patch) (state as unknown as Record<string, unknown>)[key] = patch[key];
      }
    }
    return state;
  }

  #update(slot: string, element: HTMLElement, html: string): void {
    if (this.#rendered[slot] === html) return;
    this.#rendered[slot] = html;
    element.innerHTML = html;
  }

  #pressed(state: UiState, id: string): string {
    return state.pressed === id ? " pressed" : "";
  }

  #fieldHtml(field: PanelField, state: UiState, timeMs: number): string {
    const value = state.values[field.id];
    const focused = state.focusField === field.id;
    const caret = focused && Math.floor(timeMs / 530) % 2 === 0 ? `<span class="se-caret"></span>` : "";
    const text = value === null || value === undefined ? "" : String(value);
    const shown = state.selectAll === field.id ? `<span class="sel">${escapeHtml(text)}</span>` : escapeHtml(text);
    const target = `data-target="field:${attr(field.id)}"`;
    const pressed = this.#pressed(state, `field:${field.id}`);
    switch (field.type) {
      case "slider": {
        const min = field.min ?? 0;
        const max = field.max ?? 100;
        const numeric = Number(value ?? min);
        const ratio = max > min ? Math.min(1, Math.max(0, (numeric - min) / (max - min))) : 0;
        const decimals = String(field.step ?? 1).split(".")[1]?.length ?? 0;
        return `<div class="se-field slider${pressed}"><div class="flabel">${escapeHtml(field.label)}</div>`
          + `<div class="track"><div class="fill" style="width:${(ratio * 100).toFixed(3)}%"></div>`
          + `<div class="thumb" ${target} style="left:${(ratio * 100).toFixed(3)}%"></div></div>`
          + `<div class="num">${escapeHtml(numeric.toFixed(decimals))}</div></div>`;
      }
      case "checkbox":
        return `<div class="se-field checkbox" ${target}><div class="box${value === true ? " on" : ""}">${value === true ? icon("check") : ""}</div>`
          + `<div class="flabel">${escapeHtml(field.label)}</div></div>`;
      case "dropdown": {
        const option = field.options.find((candidate) => candidate.value === value);
        return `<div class="se-field dropdown${state.select?.field === field.id ? " focused" : ""}"><div class="flabel">${escapeHtml(field.label)}</div>`
          + `<div class="value" ${target}>${escapeHtml(option?.label ?? text)}</div>${icon("arrow_drop_down")}</div>`;
      }
      case "colorpicker": {
        const swatch = state.swatches[field.id] ?? "transparent";
        return `<div class="se-field color${focused ? " focused" : ""}"><div class="swatch-wrap"><div class="swatch" style="background:${attr(swatch)}"></div></div>`
          + `<div class="col"><div class="flabel">${escapeHtml(field.label)}</div><div class="value" ${target}>${shown}${caret}</div></div></div>`;
      }
      case "image-input":
      case "video-input":
      case "sound-input":
        return `<div class="se-field media${focused ? " focused" : ""}"><div class="flabel">${escapeHtml(field.label)}</div>`
          + `<div class="value" ${target}>${shown}${caret}</div>${icon("upload")}</div>`;
      default:
        return `<div class="se-field${focused ? " focused" : ""}"><div class="flabel">${escapeHtml(field.label)}</div>`
          + `<div class="value" ${target}>${shown}${caret}</div></div>`;
    }
  }

  #sidebarHtml(state: UiState, timeMs: number): string {
    const timeline = this.timeline!;
    const layerRow = `<div class="se-layer${state.selected ? " selected" : ""}${this.#pressed(state, "layer")}" data-target="layer">`
      + `${icon("photo_library")}<span class="label">${escapeHtml(timeline.chrome.layerName)}</span>`
      + (state.selected ? `${icon("visibility", "small")}${icon("lock_open", "small")}` : "")
      + `</div>`;
    const layersHead = `<div class="se-layers-head"><span class="label">Layers</span>${icon("folder_off")}${icon("folder")}${icon("copy")}${icon("delete")}</div>`;
    const section = (id: string, label: string, iconName: string, open: boolean) =>
      `<div class="se-section${open ? " open" : ""}${this.#pressed(state, `section:${id}`)}" data-target="section:${id}">`
      + `${icon(iconName)}<span class="label">${label}</span>${icon(open ? "expand_more" : "chevron_right")}</div>`;
    if (!state.settingsOpen) {
      return section("layers", "Layers", "layers", true) + layersHead + layerRow
        + (state.selected
          ? section("settings", "Settings", "build", false)
            + section("position", "Position, size and style", "crop_free", false)
            + section("animation", "Animation settings", "movie_filter", false)
          : "");
    }
    const groups = timeline.groups.map((group) => {
      const open = state.openGroup === group;
      const header = `<div class="se-group${this.#pressed(state, `group:${group}`)}" data-target="group:${attr(group)}">`
        + `${icon(open ? "expand_less" : "expand_more")}<span>${escapeHtml(group)}</span></div>`;
      if (!open) return header;
      const fields = timeline.fields.filter((field) => field.group === group).map((field) => this.#fieldHtml(field, state, timeMs));
      return `${header}<div class="se-fields">${fields.join("")}</div>`;
    });
    return section("layers", "Layers", "layers", false)
      + section("settings", "Settings", "build", true)
      + `<div class="se-open-editor"><span class="se-btn" data-target="open-editor">Open editor</span></div>`
      + groups.join("")
      + section("position", "Position, size and style", "crop_free", false)
      + section("animation", "Animation settings", "movie_filter", false);
  }

  #bottomHtml(state: UiState): string {
    return `<div class="se-fab add">${icon("add")}</div><div class="se-fab back">${icon("chevron_left")}</div>`
      + `<div class="se-emulate${state.menu ? " active" : ""}${this.#pressed(state, "emulate")}" data-target="emulate">${icon("notifications")}<span>EMULATE</span></div>`
      + `<div class="se-tools"><div class="grp">${icon("undo", "off")}${icon("redo", "off")}</div>`
      + `<div class="grp">${icon("zoom_in")}${icon("zoom_out")}</div>`
      + `<div class="grp">${icon("fullscreen")}${icon("fullscreen_exit")}</div>`
      + `<div class="grp">${icon("grid_on")}</div><div class="grp">${icon("volume_up")}</div></div>`;
  }

  #menuHtml(state: UiState): string {
    if (!state.menu) return "";
    const emulate = this.#rect("emulate");
    const canvas = this.canvas.getBoundingClientRect();
    if (!emulate) return "";
    const left = (emulate.left - canvas.left) / this.scale;
    const bottom = (canvas.bottom - emulate.top) / this.scale + 10;
    const menu = state.menu;
    const rows = this.menu.map((entry) => {
      const hover = menu.hover === entry.kind;
      return `<div class="row${hover ? " hover" : ""}${this.#pressed(state, `menu:${entry.kind}`)}" data-target="menu:${attr(entry.kind)}">`
        + `${icon(entry.icon)}<span class="grow">${escapeHtml(entry.label)}</span>${entry.options.length ? icon("chevron_right", "chev") : ""}</div>`;
    });
    const submenuEntry = this.menu.find((entry) => entry.kind === menu.submenu);
    const submenu = submenuEntry
      ? `<div class="sub" style="height:${this.menu.length * 32 + 12}px">${submenuEntry.options
          .map((option, index) =>
            `<div class="row${menu.hoverOption === index ? " hover" : ""}${this.#pressed(state, `menu-option:${submenuEntry.kind}:${index}`)}" data-target="menu-option:${attr(submenuEntry.kind)}:${index}">${escapeHtml(option)}</div>`)
          .join("")}</div>`
      : "";
    const live = this.timeline!.chrome.liveEmulation;
    return `<div class="se-emu" style="left:${left}px;bottom:${bottom}px"><div class="live"><div class="cb${live ? " on" : ""}">${live ? icon("check") : ""}</div>`
      + `<div>Preview <b>LIVE</b> on stream</div></div><div class="card">${rows.join("")}</div>${submenu}</div>`;
  }

  #selectHtml(state: UiState): string {
    if (!state.select) return "";
    const field = this.timeline!.fields.find((candidate) => candidate.id === state.select!.field);
    const anchor = this.#rect(`field:${state.select.field}`);
    if (!field || !anchor) return "";
    const editor = this.editor.getBoundingClientRect();
    const currentIndex = field.options.findIndex((option) => option.value === state.values[field.id]);
    const top = (anchor.top - editor.top) / this.scale - 8 - Math.max(0, currentIndex) * 48;
    const left = (anchor.left - editor.left) / this.scale - 16;
    const options = field.options.map((option, index) => {
      const classes = [
        "opt",
        index === state.select!.hover ? "hover" : "",
        option.value === state.values[field.id] ? "current" : ""
      ].filter(Boolean).join(" ");
      return `<div class="${classes}" data-target="option:${attr(field.id)}:${index}">${escapeHtml(option.label)}</div>`;
    });
    return `<div class="se-select-menu" style="left:${left}px;top:${Math.max(60, top)}px">${options.join("")}</div>`;
  }

  #chatHtml(state: UiState, timeMs: number): string {
    const chrome = this.timeline!.chrome;
    const lines = state.chat.slice(-40).map((line) => {
      const badges = line.badges.map((badge) => `<span class="badge" style="background:${BADGE_COLORS[badge] ?? "#6b6b6b"}"></span>`).join("");
      return `<div class="msg">${badges}<span class="name" style="color:${attr(line.color)}">${escapeHtml(line.user)}</span>: ${escapeHtml(line.text)}</div>`;
    });
    const caret = state.chatFocus && Math.floor(timeMs / 530) % 2 === 0 ? `<span class="se-caret"></span>` : "";
    const draft = state.chatDraft ? escapeHtml(state.chatDraft) + caret : state.chatFocus ? caret : `<span class="ph">Send a message</span>`;
    return `<div class="head">${escapeHtml(chrome.chat.title)}</div><div class="log">${lines.join("")}</div>`
      + `<div class="compose"><div class="input${state.chatFocus ? " focus" : ""}" data-target="chat-input">${draft}</div>`
      + `<div class="actions"><span class="send">Chat</span></div></div>`;
  }

  #rect(target: string): DOMRect | undefined {
    for (const element of this.editor.querySelectorAll<HTMLElement>("[data-target]")) {
      if (element.dataset.target === target) {
        const rect = element.getBoundingClientRect();
        if (rect.width > 0 || rect.height > 0) return rect;
      }
    }
    return undefined;
  }

  #resolve(target: Target): {x: number; y: number} | undefined {
    const stage = this.stage.getBoundingClientRect();
    if (typeof target !== "string") return {x: target.x * this.scale, y: target.y * this.scale};
    const rect = this.#rect(target);
    if (!rect) return this.#positions.get(target);
    const wide = rect.width > 220 * this.scale;
    const point = {
      x: rect.left - stage.left + (wide ? Math.min(rect.width / 2, 110 * this.scale) : rect.width / 2),
      y: rect.top - stage.top + rect.height / 2
    };
    this.#positions.set(target, point);
    return point;
  }

  #placeCursor(timeMs: number): void {
    const timeline = this.timeline!;
    let index = -1;
    for (let candidate = 0; candidate < timeline.moves.length; candidate += 1) {
      if (timeline.moves[candidate]!.startMs <= timeMs) index = candidate;
      else break;
    }
    if (index >= 0) {
      const move = timeline.moves[index]!;
      if (index !== this.#segment) {
        this.#segment = index;
        this.#segmentFrom = {...this.#cursor};
      }
      const destination = this.#resolve(move.to) ?? this.#cursor;
      const span = move.endMs - move.startMs;
      const progress = span <= 0 ? 1 : Math.min(1, Math.max(0, (timeMs - move.startMs) / span));
      const eased = ease(progress);
      const arc = Math.sin(Math.PI * progress) * Math.min(40, Math.hypot(destination.x - this.#segmentFrom.x, destination.y - this.#segmentFrom.y) * 0.08);
      this.#cursor = {
        x: this.#segmentFrom.x + (destination.x - this.#segmentFrom.x) * eased,
        y: this.#segmentFrom.y + (destination.y - this.#segmentFrom.y) * eased - arc * this.scale
      };
    }
    const lastClick = [...timeline.clicks].reverse().find((clickMs) => clickMs <= timeMs);
    const sinceClick = lastClick === undefined ? Infinity : timeMs - lastClick;
    const pressScale = sinceClick < 140 ? 0.86 : 1;
    const size = 28 * this.scale;
    this.cursor.style.width = `${size}px`;
    this.cursor.style.transformOrigin = `${(5 * size) / 24}px ${(2.5 * size) / 24}px`;
    this.cursor.style.height = `${size}px`;
    this.cursor.style.transform = `translate(${this.#cursor.x - 5 * this.scale * 28 / 24}px, ${this.#cursor.y - 2.5 * this.scale * 28 / 24}px) scale(${pressScale})`;
    if (sinceClick < 420) {
      const progress = sinceClick / 420;
      this.ripple.style.opacity = String(0.9 * (1 - progress));
      this.ripple.style.transform = `translate(${this.#cursor.x}px, ${this.#cursor.y}px) scale(${(0.3 + progress * 0.9) * this.scale})`;
    } else {
      this.ripple.style.opacity = "0";
    }
  }

  render(timeMs: number): void {
    if (!this.timeline) throw new Error("Tutorial host is not set up.");
    const state = this.#state(timeMs);
    this.#update("sidebar", this.sidebar, this.#sidebarHtml(state, timeMs));
    this.#update("bottom", this.bottom, this.#bottomHtml(state));
    if (this.timeline.chrome.chat.enabled) this.#update("chat", this.chat, this.#chatHtml(state, timeMs));
    this.#update("menu", this.menuLayer, this.#menuHtml(state));
    this.#update("select", this.popupLayer, this.#selectHtml(state));
    const box = state.selected
      ? `<span class="dims">${this.#dims()}</span>`
      : `<span class="tag">${escapeHtml(this.timeline.chrome.layerName)}</span>`;
    this.#update("box", this.widgetBox, box);
    this.widgetBox.classList.toggle("selected", state.selected);
    this.caption.style.display = state.caption ? "block" : "none";
    this.#update("caption", this.caption, state.caption ? escapeHtml(state.caption) : "");
    this.toast.style.display = state.toast ? "block" : "none";
    this.#update("toast", this.toast, state.toast ? escapeHtml(state.toast) : "");
    for (const target of ["preview", "save"]) {
      const element = this.toolbar.querySelector<HTMLElement>(`[data-target="${target}"]`);
      element?.classList.toggle("pressed", state.pressed === target);
    }
    this.#placeCursor(timeMs);
  }

  #dims(): string {
    const scale = this.timeline!.chrome.widget.scale;
    return `${(this.viewport.width * scale).toFixed(2)}px x ${(this.viewport.height * scale).toFixed(2)}px`;
  }
}

window.__SWS_TUTORIAL__ = new TutorialController();

export {};
