import {
  cameraTransform,
  captionOpacity,
  captionTop,
  cursorPoint,
  planCamera,
  pointerStyle,
  type CameraCue,
  type CameraInput,
  type CameraPlan,
  type Frame,
  type Point,
  type Rect,
  type View
} from "./tutorial-camera.js";

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
  colorPicker?: ColorPicker | null;
}

/** Mirrors TutorialColorPicker in src/tutorial/timeline.ts. */
interface ColorPicker {
  field: string;
  h: number;
  s: number;
  v: number;
  a: number;
  rgb: {r: number; g: number; b: number};
  text: string;
  css: string;
  darkText: boolean;
  tab: "hex" | "rgb";
  selected: boolean;
  drag: "hue" | "spectrum" | "alpha" | null;
  grab: {s: number; v: number} | null;
  hoverAtMs: number | null;
  selectAtMs: number | null;
  openedAtMs: number;
  closedAtMs: number | null;
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

/** Mirrors TutorialCue in src/tutorial/timeline.ts. */
type Cue =
  | {kind: "picker"; field: string; startMs: number; endMs: number}
  | {kind: "menu"; startMs: number; endMs: number; probeMs: number}
  | {kind: "select"; field: string; startMs: number; endMs: number}
  | {kind: "toast"; startMs: number; endMs: number}
  | {kind: "typing"; region: string; startMs: number; endMs: number}
  | {kind: "reveal"; site: string; atMs: number};

/** Where the pointer is for a move, measured in the setup pre-pass (stage px, camera at identity). */
interface Anchor {
  from: Point;
  approach: Point;
  arrive: Point;
  leave: Point;
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
  moves: {startMs: number; endMs: number; to: Target; workEndMs: number}[];
  scrolls: {target: string; startMs: number; endMs: number}[];
  clicks: number[];
  presses: {downMs: number; upMs: number}[];
  cues: Cue[];
  autoZoom: {zoom: number} | null;
}

interface SetupOptions {
  timeline: Timeline;
  menu: MenuEntry[];
  viewport: {width: number; height: number};
  output: {width: number; height: number};
  /** The scene crop in stage px, the window the video exports; the camera frames it. */
  crop?: Frame | null;
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
  colorPicker: ColorPicker | null;
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
  dots: "M7 13a3 3 0 1 1 0 6 3 3 0 0 1 0-6zm10-2a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM12 4a3 3 0 1 1 0 6 3 3 0 0 1 0-6z",
  /* md-color-picker 0.2.6 tab icons. */
  gradient: "M11 9h2v2h-2zm-2 2h2v2H9zm4 0h2v2h-2zm2-2h2v2h-2zM7 9h2v2H7zm12-6H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 18H7v-2h2v2zm4 0h-2v-2h2v2zm4 0h-2v-2h2v2zm2-7h-2v2h2v2h-2v-2h-2v2h-2v-2h-2v2H9v-2H7v2H5v-2h2v-2H5V5h14v6z",
  tune: "M13 21v-2h8v-2h-8v-2h-2v6h2zM3 17v2h6v-2H3zM21 13v-2H11v2h10zM7 9v2H3v2h4v2h2V9H7zM15 9h2V7h4V5h-4V3h-2v6zM3 5v2h10V5H3z",
  view_module: "M4 11h5V5H4v6zM4 18h5v-6H4v6zM10 18h5v-6h-5v6zM16 18h5v-6h-5v6zM10 11h5V5h-5v6zM16 5v6h5V5h-5z",
  view_headline: "M4 15h17v-2H4v2zM4 19h17v-2H4v2zM4 11h17V9H4v2zM4 5v2h17V5H4z",
  history: "M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zM12 8v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"
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

/** CSS cubic-bezier timing function, solved by bisection so every frame is a pure function of time. */
function cubicBezier(x1: number, y1: number, x2: number, y2: number): (progress: number) => number {
  const curve = (p1: number, p2: number, t: number) => 3 * p1 * t * (1 - t) ** 2 + 3 * p2 * t * t * (1 - t) + t ** 3;
  return (progress) => {
    if (progress <= 0) return 0;
    if (progress >= 1) return 1;
    let low = 0;
    let high = 1;
    let t = progress;
    for (let iteration = 0; iteration < 32; iteration += 1) {
      const x = curve(x1, x2, t);
      if (Math.abs(x - progress) < 1e-6) break;
      if (x < progress) low = t;
      else high = t;
      t = (low + high) / 2;
    }
    return curve(y1, y2, t);
  };
}

/* Angular Material's standard curve and the CSS keywords its dialog and buttons use. */
const MD_EASE = cubicBezier(0.25, 0.8, 0.25, 1);
const CSS_EASE = cubicBezier(0.25, 0.1, 0.25, 1);
const CSS_EASE_OUT = cubicBezier(0, 0, 0.58, 1);

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function px(value: number): string {
  return `${Number(value.toFixed(3))}px`;
}

/* md-color-picker dialog metrics (md-dialog 347x445; spectrum, hue, and alpha canvases are 255px tall). */
const PICKER_WIDTH = 347;
const PICKER_HEIGHT = 445;
const PICKER_SIZE = 255;
const PICKER_MARGIN = 8;
const PICKER_ANIMATION_MS = 400;
const PICKER_BACKDROP_IN_MS = 450;
const PICKER_BACKDROP_OPACITY = 0.48;
const PICKER_TYPES = [
  {id: "hex", label: "Hex", left: 0, width: 116.4},
  {id: "rgb", label: "RGB", left: 116.4, width: 117.3},
  {id: "hsl", label: "HSL", left: 233.7, width: 115.4}
] as const;
const PICKER_PANES = ["gradient", "tune", "view_module", "view_headline", "history"];
/** Select button box inside the md-dialog (md-actions row at y 397, 6px inset). */
const SELECT_BUTTON = {x: 181.5, y: 403, width: 157.5, height: 36};
const CURSOR_HOTSPOTS = {arrow: {x: 5, y: 2.5}, crosshair: {x: 12, y: 12}} as const;
/** Cursor sizes in editor pixels; the crosshair is smaller, and its open center keeps the 11px spectrum marker visible. */
const CURSOR_SIZES: Record<keyof typeof CURSOR_HOTSPOTS, number> = {arrow: 28, crosshair: 24};
/** Editor px the sidebar leaves between a scrolled-in target and its edge; more than a field label's 16 px. */
const SCROLL_MARGIN = 24;
/** The families tutorial-page.ts declares for the editor and its chat. */
const EDITOR_FONT_FAMILIES = ["Nunito Sans Variable", "Inter Variable"];

/**
 * Loads every face of the editor's fonts, in both unicode ranges, before setup measures anything,
 * so no anchor and no frame uses a fallback font. A face that cannot load fails the render.
 */
async function loadEditorFonts(): Promise<void> {
  const family = (face: FontFace) => face.family.replace(/^"(.*)"$/, "$1");
  const faces: FontFace[] = [];
  document.fonts.forEach((face) => {
    if (EDITOR_FONT_FAMILIES.includes(family(face))) faces.push(face);
  });
  const missing = EDITOR_FONT_FAMILIES.filter((name) => !faces.some((face) => family(face) === name));
  if (missing.length) throw new Error(`The editor replica declares no ${missing.join(" or ")} font face.`);
  await Promise.all(faces.map((face) => face.load().catch(() => {
    throw new Error(`An editor replica font face (${family(face)}, ${face.unicodeRange.slice(0, 16)}…) failed to load from /__sws/ui/fonts/.`);
  })));
}

class TutorialController {
  readonly stage = document.querySelector<HTMLElement>("#capture-stage")!;
  readonly cameraLayer = document.querySelector<HTMLElement>("#se-camera")!;
  readonly hud = document.querySelector<HTMLElement>("#se-hud")!;
  readonly hudCanvas = document.querySelector<HTMLElement>("#se-hud-canvas")!;
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
  readonly backdropLayer = document.querySelector<HTMLElement>("#se-backdrop-layer")!;
  readonly cursor = document.querySelector<SVGElement>("#se-cursor")!;
  readonly ripple = document.querySelector<HTMLElement>("#se-ripple")!;
  timeline?: Timeline;
  menu: MenuEntry[] = [];
  viewport = {width: 0, height: 0};
  scale = 1;
  #rendered: Record<string, string> = {};
  /** The pointer's stage position in the frame being drawn; never read by a later frame. */
  #cursor = {x: 0, y: 0};
  /** Where the cursor rests before the first scripted move. */
  #home = {x: 0, y: 0};
  /** Logical editor size: the browser window the StreamElements dialogs center in. */
  #editorSize = {width: 0, height: 0};
  #anchors: Anchor[] = [];
  #plan?: CameraPlan;
  /** The sidebar scrolls, resolved in setup: offsets in editor px, in time order. */
  #scrolls: {startMs: number; endMs: number; from: number; to: number}[] = [];

  async setup(options: SetupOptions): Promise<void> {
    await loadEditorFonts();
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
    this.#editorSize = {width, height};
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
    // Captions live in the HUD above the camera, laid out like the editor canvas so they keep their place.
    this.hud.style.width = `${width}px`;
    this.hud.style.height = `${height}px`;
    this.hud.style.transform = `scale(${this.scale})`;
    this.hudCanvas.style.right = `${chatWidth}px`;
    this.cameraLayer.style.transform = "none";
    this.#home = {x: options.output.width * 0.62, y: options.output.height * 0.58};
    this.#cursor = {...this.#home};
    this.#rendered = {};
    // Pre-pass: settle the sidebar scrolls, measure the editor at the times the camera plans from, then plan it.
    this.#resolveScrolls();
    this.#anchors = this.#measureAnchors();
    const cues = this.#measureCues();
    const captions = this.#measureCaptions();
    const timeline = options.timeline;
    this.#plan = planCamera({
      width: options.output.width,
      height: options.output.height,
      ...(options.crop ? {frame: options.crop} : {}),
      uiScale: this.scale,
      zoom: timeline.autoZoom?.zoom ?? null,
      endMs: timeline.endMs,
      home: this.#home,
      moves: timeline.moves.map((move, index) => ({
        startMs: move.startMs,
        endMs: move.endMs,
        workEndMs: move.workEndMs,
        ...this.#anchors[index]!
      })),
      cues,
      captions
    });
    // The first frame rewrites every slot the pre-pass left behind.
    this.#rendered = {};
  }

  /** Lays the editor out as it is at `timeMs`, with the camera at identity. */
  #measureAt(timeMs: number): void {
    this.#layout(this.#state(timeMs), timeMs);
  }

  /**
   * The editor's sidebar keeps its scroll where the user left it, and a target below or above
   * it has to be scrolled in before the pointer can reach it. Each scroll starts where the last
   * one left the sidebar (as the browser clamps it to the content then) and moves just enough to
   * show the target with a margin that also keeps a field's label in view; a target already in
   * view, or outside the sidebar, does not scroll it.
   */
  #resolveScrolls(): void {
    this.#scrolls = [];
    for (const scroll of this.timeline!.scrolls) {
      this.#measureAt(scroll.startMs);
      const from = this.sidebar.scrollTop;
      const target = this.#targetElement(scroll.target);
      let to = from;
      if (target && this.sidebar.contains(target)) {
        const view = this.sidebar.getBoundingClientRect();
        const box = target.getBoundingClientRect();
        const top = (box.top - view.top) / this.scale + from - SCROLL_MARGIN;
        const bottom = (box.bottom - view.top) / this.scale + from + SCROLL_MARGIN;
        const height = this.sidebar.clientHeight;
        if (top < from) to = top;
        else if (bottom > from + height) to = Math.min(top, bottom - height);
        to = Math.round(clamp(to, 0, Math.max(0, this.sidebar.scrollHeight - height)));
      }
      this.#scrolls.push({startMs: scroll.startMs, endMs: scroll.endMs, from, to});
    }
  }

  /** The sidebar's scroll offset at `timeMs`: where the last scroll that started by then leaves it, eased while it runs. */
  #scrollAt(timeMs: number): number {
    let offset = 0;
    for (const scroll of this.#scrolls) {
      if (scroll.startMs > timeMs) break;
      offset = timeMs >= scroll.endMs
        ? scroll.to
        : scroll.from + (scroll.to - scroll.from) * CSS_EASE((timeMs - scroll.startMs) / (scroll.endMs - scroll.startMs));
    }
    return offset;
  }

  /**
   * Each move's pointer positions: the target just before the click, right after it (a group
   * header can jump when it opens), and when the next move starts (the end of a drag). A target
   * that is gone keeps the previous position, as a vanished menu row stays where it was clicked.
   */
  #measureAnchors(): Anchor[] {
    const timeline = this.timeline!;
    const anchors: Anchor[] = [];
    let from: Point = {...this.#home};
    timeline.moves.forEach((move, index) => {
      this.#measureAt(Math.max(move.startMs, move.endMs - 1));
      const approach = this.#live(move.to) ?? from;
      this.#measureAt(move.endMs);
      const arrive = this.#live(move.to) ?? approach;
      this.#measureAt(timeline.moves[index + 1]?.startMs ?? timeline.endMs);
      const leave = this.#live(move.to) ?? arrive;
      anchors.push({from, approach, arrive, leave});
      from = leave;
    });
    return anchors;
  }

  /** Stage px rect of an element; undefined when it is missing or has no size. */
  #rectOf(element: Element | null | undefined): Rect | undefined {
    if (!element) return undefined;
    const box = element.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return undefined;
    const stage = this.stage.getBoundingClientRect();
    return {x0: box.left - stage.left, y0: box.top - stage.top, x1: box.right - stage.left, y1: box.bottom - stage.top};
  }

  #hullOf(elements: (Element | null | undefined)[]): Rect | undefined {
    const rects = elements.map((element) => this.#rectOf(element)).filter((rect): rect is Rect => rect !== undefined);
    if (rects.length === 0) return undefined;
    return rects.reduce((hull, rect) => ({
      x0: Math.min(hull.x0, rect.x0),
      y0: Math.min(hull.y0, rect.y0),
      x1: Math.max(hull.x1, rect.x1),
      y1: Math.max(hull.y1, rect.y1)
    }));
  }

  #targetElement(target: string): HTMLElement | undefined {
    for (const element of this.editor.querySelectorAll<HTMLElement>("[data-target]")) {
      if (element.dataset.target === target) return element;
    }
    return undefined;
  }

  /** A field's whole row in the sidebar: label, value, and control. */
  #row(field: string): Element | null | undefined {
    return this.#targetElement(`field:${field}`)?.closest(".se-field");
  }

  /** The widget as seen in the canvas: its box clipped by the canvas. */
  #widgetRect(): Rect | undefined {
    const widget = this.#rectOf(this.widgetBox);
    const canvas = this.#rectOf(this.canvas);
    if (!widget || !canvas) return undefined;
    const clipped = {
      x0: Math.max(widget.x0, canvas.x0),
      y0: Math.max(widget.y0, canvas.y0),
      x1: Math.min(widget.x1, canvas.x1),
      y1: Math.min(widget.y1, canvas.y1)
    };
    return clipped.x1 > clipped.x0 && clipped.y1 > clipped.y0 ? clipped : undefined;
  }

  /**
   * Measures what the camera must show for each cue: open popups, the toast, the text being typed,
   * and the widget with what made it react. Missing elements are skipped; a cue with nothing to
   * show is dropped.
   */
  #measureCues(): CameraCue[] {
    const cues: CameraCue[] = [];
    const u = this.scale;
    let widget: Rect | undefined;
    let widgetMeasured = false;
    for (const cue of this.timeline!.cues) {
      const rects: CameraCue["rects"] = [];
      const add = (rect: Rect | undefined, obstacle: boolean) => {
        if (rect) rects.push({rect, obstacle});
      };
      let kind: CameraCue["kind"];
      let startMs: number;
      let endMs: number;
      switch (cue.kind) {
        case "picker": {
          this.#measureAt(cue.startMs);
          const dialog = this.#pickerFrame();
          add({x0: dialog.left * u, y0: dialog.top * u, x1: dialog.right * u, y1: dialog.bottom * u}, true);
          add(this.#rectOf(this.#row(cue.field)), false);
          [kind, startMs, endMs] = ["popup", cue.startMs, cue.endMs];
          break;
        }
        case "menu":
          this.#measureAt(cue.probeMs);
          add(this.#hullOf([
            this.menuLayer.querySelector(".se-emu .live"),
            this.menuLayer.querySelector(".se-emu .card"),
            this.menuLayer.querySelector(".se-emu .sub"),
            this.#targetElement("emulate")
          ]), true);
          [kind, startMs, endMs] = ["popup", cue.startMs, cue.endMs];
          break;
        case "select":
          this.#measureAt(cue.startMs);
          add(this.#hullOf([this.popupLayer.querySelector(".se-select-menu"), this.#row(cue.field)]), true);
          [kind, startMs, endMs] = ["popup", cue.startMs, cue.endMs];
          break;
        case "toast":
          this.#measureAt(cue.startMs);
          add(this.#rectOf(this.toast), true);
          [kind, startMs, endMs] = ["toast", cue.startMs, cue.endMs];
          break;
        case "typing":
          this.#measureAt(cue.startMs);
          add(this.#rectOf(cue.region === "chat-input"
            ? this.#targetElement("chat-input")
            : this.#row(cue.region.slice("field:".length))), true);
          [kind, startMs, endMs] = ["typing", cue.startMs, cue.endMs];
          break;
        case "reveal": {
          this.#measureAt(cue.atMs);
          if (!widgetMeasured) {
            widget = this.#widgetRect();
            widgetMeasured = true;
          }
          add(widget, true);
          const site = cue.site === "chat-line"
            ? [...this.chat.querySelectorAll(".msg")].at(-1)
            : cue.site === "emulate"
              ? this.#targetElement("emulate")
              : this.#row(cue.site.slice("field:".length));
          add(this.#rectOf(site), true);
          [kind, startMs, endMs] = ["reveal", cue.atMs, cue.atMs];
          break;
        }
      }
      if (rects.length > 0) cues.push({kind, startMs, endMs, rects});
    }
    return cues;
  }

  /** One window per shown caption, with its laid-out height in HUD px. */
  #measureCaptions(): CameraInput["captions"] {
    const windows: {startMs: number; endMs: number; text: string}[] = [];
    let open: {startMs: number; text: string} | null = null;
    for (const {atMs, patch} of this.timeline!.patches) {
      if (!("caption" in patch)) continue;
      if (open) windows.push({...open, endMs: atMs});
      open = patch.caption ? {startMs: atMs, text: patch.caption} : null;
    }
    if (open) windows.push({...open, endMs: Infinity});
    const heights = new Map<string, number>();
    for (const {text} of windows) {
      if (heights.has(text)) continue;
      this.caption.innerHTML = escapeHtml(text);
      this.caption.style.display = "block";
      heights.set(text, this.caption.offsetHeight);
    }
    this.caption.style.display = "none";
    this.caption.innerHTML = "";
    return windows.map(({startMs, endMs, text}) => ({startMs, endMs, height: heights.get(text)!}));
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
      toast: null,
      colorPicker: null
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
        "toast",
        "colorPicker"
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
        return `<div class="se-field color${focused ? " focused" : ""}"><div class="swatch-wrap" data-target="swatch:${attr(field.id)}"><div class="swatch" style="background:${attr(swatch)}"></div></div>`
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
    // md-select keeps the menu 8 px inside the window: below the toolbar and above the editor's bottom edge.
    const height = options.length * 48 + 16;
    return `<div class="se-select-menu" style="left:${left}px;top:${Math.max(60, Math.min(top, this.#editorSize.height - 8 - height))}px">${options.join("")}</div>`;
  }

  /** Open fraction of the md-dialog: grows from the swatch on open and shrinks back on close. */
  #pickerOpen(picker: ColorPicker, timeMs: number): number {
    const opening = MD_EASE(clamp((timeMs - picker.openedAtMs) / PICKER_ANIMATION_MS, 0, 1));
    const closing = picker.closedAtMs === null ? 1 : 1 - MD_EASE(clamp((timeMs - picker.closedAtMs) / PICKER_ANIMATION_MS, 0, 1));
    return Math.min(opening, closing);
  }

  /**
   * The fully open dialog in editor pixels: $mdDialog centers it in the window, scaled down
   * only when the editor is too small to show it whole.
   */
  #pickerFrame(): {fit: number; center: {x: number; y: number}; left: number; top: number; right: number; bottom: number} {
    const {width, height} = this.#editorSize;
    const fit = Math.min(1, (width - 2 * PICKER_MARGIN) / PICKER_WIDTH, (height - 2 * PICKER_MARGIN) / PICKER_HEIGHT);
    const center = {x: width / 2, y: height / 2};
    const half = {x: (fit * PICKER_WIDTH) / 2, y: (fit * PICKER_HEIGHT) / 2};
    return {fit, center, left: center.x - half.x, top: center.y - half.y, right: center.x + half.x, bottom: center.y + half.y};
  }

  /**
   * Draws the md-color-picker dialog that StreamElements opens from a colorpicker swatch:
   * centered in the editor window over a #212121 backdrop that dims the whole window
   * (the toolbar spans the chat panel too), scaled down only when the editor is too small
   * to show it whole, so every picker target stays on the stage.
   */
  #pickerHtml(state: UiState, timeMs: number): {backdrop: string; dialog: string} {
    const picker = state.colorPicker;
    if (!picker) return {backdrop: "", dialog: ""};
    const {width, height} = this.#editorSize;
    const {fit, center} = this.#pickerFrame();
    // The dialog grows out of the swatch as laid out in this frame (the dialog center without one).
    const swatch = this.#rect(`swatch:${picker.field}`);
    const editor = this.editor.getBoundingClientRect();
    const origin = swatch
      ? {x: (swatch.left + swatch.width / 2 - editor.left) / this.scale, y: (swatch.top + swatch.height / 2 - editor.top) / this.scale}
      : center;
    const open = this.#pickerOpen(picker, timeMs);
    const backdropIn = CSS_EASE(clamp((timeMs - picker.openedAtMs) / PICKER_BACKDROP_IN_MS, 0, 1));
    const backdropOut = picker.closedAtMs === null ? 1 : 1 - CSS_EASE(clamp((timeMs - picker.closedAtMs) / PICKER_ANIMATION_MS, 0, 1));
    const backdrop = `<div class="se-cp-backdrop" style="width:${px(width)};height:${px(height)};`
      + `opacity:${(PICKER_BACKDROP_OPACITY * Math.min(backdropIn, backdropOut)).toFixed(4)}"></div>`;
    const scaleX = fit * (0.07 + 0.93 * open);
    const scaleY = fit * (0.05 + 0.95 * open);
    const transform = open === 1 && fit === 1
      ? "none"
      : `translate(${px((origin.x - center.x) * (1 - open))}, ${px((origin.y - center.y) * (1 - open))}) scale(${scaleX.toFixed(5)}, ${scaleY.toFixed(5)})`;

    const valueIn = clamp((timeMs - picker.openedAtMs) / 250, 0, 1);
    const value = `<div class="se-cp-value" style="top:${px(-15 * (1 - MD_EASE(valueIn)))};opacity:${CSS_EASE_OUT(valueIn).toFixed(4)}">`
      + `<span class="${picker.selected ? "sel" : ""}">${escapeHtml(picker.text)}</span></div>`;
    const types = PICKER_TYPES.map((type) =>
      `<span class="${type.id === picker.tab ? "on" : ""}" style="left:${type.left}px;width:${type.width}px">${type.label}</span>`).join("");
    const activeType = PICKER_TYPES.find((type) => type.id === picker.tab)!;
    const head = `<div class="se-cp-head${picker.darkText ? " dark" : ""}"><div class="se-cp-result" style="background:${attr(picker.css)}"></div>`
      + `${value}<div class="se-cp-types">${types}<i class="ink" style="left:${activeType.left}px;width:${activeType.width}px"></i></div></div>`;

    const hue = Number(picker.h.toFixed(3));
    const {r, g, b} = picker.rgb;
    const spectrumMarker = `left:${px(clamp(PICKER_SIZE * picker.s - 5.5, -5, 249.5))};top:${px(clamp(PICKER_SIZE * (1 - picker.v) - 5.5, -5, 249.5))}`;
    const grab = picker.grab
      ? `<i class="grab" data-target="picker:grab" style="left:${px(PICKER_SIZE * picker.grab.s - 0.5)};top:${px(PICKER_SIZE * (1 - picker.grab.v) - 0.5)}"></i>`
      : "";
    const stripMarker = (fraction: number) => `top:${px(clamp(PICKER_SIZE * (1 - fraction) - 2.5, -2, 251.5))}`;
    const body = `<div class="se-cp-body">`
      + `<div class="se-cp-spectrum" data-cursor="crosshair" style="background:linear-gradient(to bottom, rgba(0,0,0,0), #000), linear-gradient(to right, #fff, rgba(255,255,255,0)), hsl(${hue}, 100%, 50%)">`
      + `<div class="mk" data-target="picker:spectrum" style="${spectrumMarker}"></div>${grab}</div>`
      + `<div class="se-cp-hue" data-cursor="crosshair"><div class="mk" data-target="picker:hue" style="${stripMarker(picker.h / 360)}"></div></div>`
      + `<div class="se-cp-alpha" data-cursor="crosshair"><div class="fill" style="background:linear-gradient(to bottom, rgba(${r},${g},${b},1) 1%, rgba(${r},${g},${b},0) 99.9%)"></div>`
      + `<div class="mk" data-target="picker:alpha" style="${stripMarker(picker.a)}"></div></div></div>`;
    const panes = `<div class="se-cp-panes">${PICKER_PANES.map((name, index) =>
      `<span class="${index === 0 ? "on" : ""}" style="left:${px(index * 69.8)}">${icon(name)}<b>…</b></span>`).join("")}<i class="ink"></i></div>`;

    const hover = picker.hoverAtMs === null ? 0 : MD_EASE(clamp((timeMs - picker.hoverAtMs) / 400, 0, 1));
    let ink = "";
    if (picker.selectAtMs !== null && timeMs >= picker.selectAtMs) {
      const since = timeMs - picker.selectAtMs;
      const grow = CSS_EASE_OUT(clamp(since / 450, 0, 1));
      const fade = since <= 90 ? 1 : 1 - clamp((since - 90) / 300, 0, 1);
      ink = `<i class="ink" style="transform:translate(-50%, -50%) scale(${grow.toFixed(4)});opacity:${(0.1 * fade).toFixed(4)}"></i>`;
    }
    const actions = `<div class="se-cp-actions"><span class="se-cp-btn" style="left:8px">Cancel</span>`
      + `<span class="se-cp-btn" style="left:181.5px;background:rgba(158,158,158,${(0.2 * hover).toFixed(4)})">Select${ink}</span></div>`;
    // The cursor aims at a fixed anchor over the open dialog's Select button, so it stays where it
    // clicked while the dialog shrinks back into the swatch.
    const select = {x: SELECT_BUTTON.x - PICKER_WIDTH / 2, y: SELECT_BUTTON.y - PICKER_HEIGHT / 2};
    const anchor = `<i class="se-cp-anchor" data-target="picker:select" style="left:${px(center.x + fit * select.x)};top:${px(center.y + fit * select.y)};`
      + `width:${px(fit * SELECT_BUTTON.width)};height:${px(fit * SELECT_BUTTON.height)}"></i>`;

    const dialog = `<div class="se-cp" style="left:${px(center.x - PICKER_WIDTH / 2)};top:${px(center.y - PICKER_HEIGHT / 2)};`
      + `transform:${transform};opacity:${open.toFixed(4)}">${head}${body}${panes}${actions}</div>${anchor}`;
    return {backdrop, dialog};
  }

  /**
   * Keeps the caption readable: it slides clear of open popups, the reacting widget, and the text
   * being typed, as projected through this frame's camera (see captionTop). Layout offsets ignore
   * transforms, so the default box depends only on the caption text.
   */
  #placeCaption(state: UiState, timeMs: number, view: View): void {
    if (!state.caption) {
      this.caption.style.transform = "";
      this.caption.style.opacity = "";
      return;
    }
    const width = this.caption.offsetWidth;
    const height = this.caption.offsetHeight;
    const left = this.hudCanvas.offsetLeft + this.caption.offsetLeft - width / 2;
    const top = this.hudCanvas.offsetTop + this.caption.offsetTop;
    const placed = captionTop(this.#plan!, view, timeMs, {left, top, width, height}, this.#editorSize.height);
    this.caption.style.transform = placed === top ? "" : `translate(-50%, ${px(placed - top)})`;
    // A popup with no room for the caption on either side fades it out: the popup stays whole.
    const opacity = captionOpacity(this.#plan!, view, timeMs, {left, top: placed, width, height});
    this.caption.style.opacity = opacity >= 1 ? "" : opacity.toFixed(4);
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

  /** A target's pointer position in stage px as laid out now; undefined when it is not on screen. */
  #live(target: Target): Point | undefined {
    if (typeof target !== "string") return {x: target.x * this.scale, y: target.y * this.scale};
    const rect = this.#rect(target);
    if (!rect) return undefined;
    const stage = this.stage.getBoundingClientRect();
    const wide = rect.width > 220 * this.scale;
    return {
      x: rect.left - stage.left + (wide ? Math.min(rect.width / 2, 110 * this.scale) : rect.width / 2),
      y: rect.top - stage.top + rect.height / 2
    };
  }

  /**
   * md-color-picker's canvases use a crosshair cursor. Real drags hide the pointer
   * (cursor: none); the replica keeps a small crosshair with an open center visible so
   * viewers can follow the drag and still see the marker under it.
   */
  #cursorShape(state: UiState, timeMs: number): keyof typeof CURSOR_HOTSPOTS {
    const picker = state.colorPicker;
    if (!picker || this.#pickerOpen(picker, timeMs) < 1) return "arrow";
    if (picker.drag) return "crosshair";
    const stage = this.stage.getBoundingClientRect();
    const hit = document.elementFromPoint(stage.left + this.#cursor.x, stage.top + this.#cursor.y);
    return hit?.closest("[data-cursor='crosshair']") ? "crosshair" : "arrow";
  }

  /**
   * The pointer in stage px with the camera at identity. A move starts from the previous target as
   * laid out in this frame, not from whatever frame was rendered last, and a target that is gone
   * falls back to the position measured in setup; frames stay a function of time at any fps and
   * seek order.
   */
  #pointerAt(timeMs: number): Point {
    const moves = this.timeline!.moves;
    let index = -1;
    for (let candidate = 0; candidate < moves.length; candidate += 1) {
      if (moves[candidate]!.startMs <= timeMs) index = candidate;
      else break;
    }
    if (index < 0) return {...this.#home};
    const move = moves[index]!;
    const anchor = this.#anchors[index]!;
    const span = move.endMs - move.startMs;
    if (span > 0 && timeMs < move.endMs) {
      const from = index > 0 ? this.#live(moves[index - 1]!.to) ?? anchor.from : this.#home;
      return cursorPoint(from, this.#live(move.to) ?? anchor.approach, (timeMs - move.startMs) / span, this.scale);
    }
    return this.#live(move.to) ?? anchor.leave;
  }

  /** Draws the pointer, scaled with the camera and pulsing on clicks, and the click ripple. `screen` is the tip in stage px. */
  #placeCursor(state: UiState, timeMs: number, shape: keyof typeof CURSOR_HOTSPOTS, screen: Point, zoom: number): void {
    const style = pointerStyle({size: CURSOR_SIZES[shape], hotspot: CURSOR_HOTSPOTS[shape]}, screen, this.scale, zoom, this.timeline!.presses, timeMs);
    this.cursor.dataset.shape = shape;
    this.cursor.style.width = `${style.size}px`;
    this.cursor.style.transformOrigin = style.origin;
    this.cursor.style.height = `${style.size}px`;
    this.cursor.style.transform = style.transform;
    // While a picker marker is dragged, the click ripple is drawn as a ring so the marker shows through it.
    this.ripple.classList.toggle("ring", Boolean(state.colorPicker?.drag));
    if (style.ripple) {
      this.ripple.style.opacity = String(style.ripple.opacity);
      this.ripple.style.transform = style.ripple.transform;
    } else {
      this.ripple.style.opacity = "0";
    }
  }

  /** Everything but the camera, the pointer, and the caption position: sidebar, menus, picker, chat, widget box, toast. */
  #layout(state: UiState, timeMs: number): void {
    const timeline = this.timeline!;
    this.#update("sidebar", this.sidebar, this.#sidebarHtml(state, timeMs));
    // Before the popups below: a select menu opens where its field is after the scroll.
    this.sidebar.scrollTop = this.#scrollAt(timeMs);
    this.#update("bottom", this.bottom, this.#bottomHtml(state));
    if (timeline.chrome.chat.enabled) this.#update("chat", this.chat, this.#chatHtml(state, timeMs));
    this.#update("menu", this.menuLayer, this.#menuHtml(state));
    const picker = this.#pickerHtml(state, timeMs);
    this.#update("backdrop", this.backdropLayer, picker.backdrop);
    this.#update("popup", this.popupLayer, this.#selectHtml(state) + picker.dialog);
    const box = state.selected
      ? `<span class="dims">${this.#dims()}</span>`
      : `<span class="tag">${escapeHtml(timeline.chrome.layerName)}</span>`;
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
  }

  /**
   * Draws the frame at `timeMs`. `full` draws the same instant with the camera on the whole frame and
   * no pointer, for a `still` step with `camera: "full"`; the next render draws the video again.
   */
  render(timeMs: number, options: {full?: boolean} = {}): void {
    if (!this.timeline || !this.#plan) throw new Error("Tutorial host is not set up.");
    const state = this.#state(timeMs);
    // Measure with the camera removed: getBoundingClientRect and elementFromPoint then see stage px.
    this.cameraLayer.style.transform = "none";
    this.#layout(state, timeMs);
    this.#cursor = this.#pointerAt(timeMs);
    const shape = this.#cursorShape(state, timeMs);
    // Apply the camera last. It frames the crop (or the whole stage) and never shows outside it.
    const {zoom, tx, ty, css, view} = cameraTransform(options.full ? {frame: this.#plan.frame, keys: []} : this.#plan, timeMs);
    this.cameraLayer.style.transform = css;
    this.#placeCursor(state, timeMs, shape, {x: this.#cursor.x * zoom + tx, y: this.#cursor.y * zoom + ty}, zoom);
    this.cursor.style.visibility = options.full ? "hidden" : "";
    this.ripple.style.visibility = options.full ? "hidden" : "";
    this.#placeCaption(state, timeMs, view);
  }

  #dims(): string {
    const scale = this.timeline!.chrome.widget.scale;
    return `${(this.viewport.width * scale).toFixed(2)}px x ${(this.viewport.height * scale).toFixed(2)}px`;
  }
}

window.__SWS_TUTORIAL__ = new TutorialController();

export {};
