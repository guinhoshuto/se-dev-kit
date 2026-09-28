/**
 * Screen Studio-style camera, pointer pulse, and caption placement for tutorial videos.
 *
 * DOM-free and stateless: the tutorial host measures the editor once in `setup()`, `planCamera`
 * turns those measurements and the timeline into camera keys, and every frame evaluates the plan
 * as a pure function of its time. A view is `(x, y, w)` in stage pixels with the camera at identity
 * ("world px"). The camera frames the exported window (the whole stage, or the scene crop), of size
 * `W×H`: a view's height is `w·H/W`, its zoom `W/w`, and it always lies inside that window. Every
 * frame is a convex combination of feasible goal views, so the linear guarantees of the goals
 * (inside the window, rectangles in view, room for the caption) hold for every frame in between.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A camera view in world px: the top-left corner and the width; the height follows the frame's aspect. */
export interface View {
  x: number;
  y: number;
  w: number;
}

export interface CameraMove {
  startMs: number;
  endMs: number;
  /** The pointer keeps working at the target until this time. */
  workEndMs: number;
  /** Where the pointer starts. */
  from: Point;
  /** Where it heads during the move: the target just before the click. */
  approach: Point;
  /** The target at `endMs`, after the click's own patch. */
  arrive: Point;
  /** The target when the next move starts (the end of a drag). */
  leave: Point;
}

export interface CameraCue {
  kind: "popup" | "toast" | "reveal" | "typing";
  startMs: number;
  endMs: number;
  /** World px. `obstacle` rects also push the caption clear of them. */
  rects: {rect: Rect; obstacle: boolean}[];
}

/** The exported window in stage px: the scene crop, or the whole stage. */
export interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CameraInput {
  /** Stage size in px. */
  width: number;
  height: number;
  /** The window the video exports (the scene crop); the whole stage when omitted. */
  frame?: Frame;
  uiScale: number;
  /** The close-up zoom, or null for a camera that stays on the full editor. */
  zoom: number | null;
  endMs: number;
  home: Point;
  moves: CameraMove[];
  cues: CameraCue[];
  /** HUD px heights, one entry per caption window. */
  captions: {startMs: number; endMs: number; height: number}[];
}

export interface CameraKey {
  t: number;
  view: View;
  kind: "idle" | "zoom-in" | "pan" | "bridge" | "settle" | "popup" | "toast" | "reveal";
}

/** A rectangle that stays fully in view on [startMs, endMs); `top`/`bottom` reserve a caption band (view fractions). */
export interface CameraHold {
  rect: Rect;
  startMs: number;
  endMs: number;
  top: number;
  bottom: number;
}

export interface CaptionObstacle {
  rect: Rect;
  startMs: number;
  endMs: number;
  side: "below" | "above" | null;
  popup: boolean;
}

export interface CameraPlan {
  width: number;
  height: number;
  /** The window the camera frames; its full view is the camera at identity. */
  frame: Frame;
  uiScale: number;
  keys: CameraKey[];
  holds: CameraHold[];
  obstacles: CaptionObstacle[];
  /** Moves whose goals had to contain their whole path after verification. */
  repairedMoves: number[];
  /** Every move became strict because the repairs did not converge. */
  fallback: boolean;
}

export const CAMERA = {
  /** Length of every camera move and the stiffness of its critically damped curve. */
  TRANSITION_MS: 1000,
  CURVE_K: 7,
  /** A zoom-in starts this long after the pointer starts moving; moves up to LAG_SPAN_MAX_MS keep the lag exemption. */
  LAG_MS: 150,
  LAG_SPAN_MAX_MS: 700,
  /** A pan lands this long before the click and starts at least LEAD_MIN_MS before the pointer. */
  LEAD_SETTLE_MS: 100,
  LEAD_MIN_MS: 200,
  /** Back to the full editor IDLE_OUT_DELAY_MS after activity, when the next one is at least IDLE_MS later. */
  IDLE_OUT_DELAY_MS: 500,
  IDLE_MS: 1500,
  REVEAL_HOLD_MS: 1200,
  REVEAL_MIN_MS: 600,
  REVEAL_ZOOM_MAX: 1.5,
  POPUP_ZOOM_MAX: 1.6,
  TOAST_SETTLE_MS: 1100,
  /** Popup hold margin and caption slide duration. */
  CAPTION_SLIDE_MS: 200,
  /** Inner box of the dead zone: the view inset by this fraction per side. */
  DEAD_ZONE: 0.15,
  /** "Zoomed" means z ≥ SETTLE_ZOOM_RATIO·zoom; a bridge settles back after a rest of SETTLE_MIN_REST_MS. */
  SETTLE_ZOOM_RATIO: 0.9,
  SETTLE_MIN_REST_MS: 1300,
  SETTLE_DELAY_MS: 100,
  MIN_KEY_GAP_MS: 500,
  /** Framings below this zoom become the full view. */
  ZOOM_SNAP: 1.15,
  /** Editor px kept around every framed rect. */
  PAD: 24,
  /** Editor px around the pointer tip for planning: the 28 px arrow and the move arc. */
  CURSOR_BOX: {left: 16, top: 56, right: 28, bottom: 30},
  /** Editor px around the pointer tip that is verified to be in frame. */
  CURSOR_VISIBLE: {left: 13, top: 13, right: 24, bottom: 27},
  CAPTION_GAP: 20,
  CAPTION_EDGE: 8,
  CAPTION_TOP_LIMIT: 60,
  CAPTION_BOTTOM: 104,
  CHECK_STEP_MS: 10,
  REPAIR_PASSES: 3
} as const;

/* Pointer pulse: shrink to MIN in PRESS_MS, hold while the press lasts, spring back (ζ = 0.5) over SPRING_MS. */
const PULSE = {MIN: 0.8, PRESS_MS: 70, SPRING_MS: 450, DECAY: 13, OMEGA: 22.517} as const;
const RIPPLE = {MS: 520, FADE_IN_MS: 60, OPACITY: 0.85, FROM: 0.3, GROWTH: 0.95} as const;

const PRIORITY = {idle: 1, soft: 2, shot: 3} as const;

/* ------------------------------------------------------------------ transition curve and evaluation */

/** Critically damped step response: zero start velocity, no overshoot. */
const raw = (x: number): number => 1 - (1 + x) * Math.exp(-x);
const RAW_END = raw(CAMERA.CURVE_K);

/** The camera's move curve: 0 before the key, exactly 1 from TRANSITION_MS on, monotone in between. */
export function transition(tauMs: number): number {
  if (tauMs <= 0) return 0;
  if (tauMs >= CAMERA.TRANSITION_MS) return 1;
  return raw((CAMERA.CURVE_K * tauMs) / CAMERA.TRANSITION_MS) / RAW_END;
}

/**
 * The view at `timeMs`. It starts from the last goal that has fully landed, so a settled camera is
 * exactly its goal, and adds the active transitions in key order: the same float operations at any
 * frame rate and seek order.
 */
export function cameraAt(plan: Pick<CameraPlan, "frame" | "keys">, timeMs: number): View {
  const keys = plan.keys;
  let landed = -1;
  for (let index = 0; index < keys.length; index += 1) {
    if (keys[index]!.t + CAMERA.TRANSITION_MS <= timeMs) landed = index;
    else break;
  }
  const base = landed < 0 ? {x: plan.frame.x, y: plan.frame.y, w: plan.frame.width} : keys[landed]!.view;
  let x = base.x;
  let y = base.y;
  let w = base.w;
  let previous = base;
  for (let index = landed + 1; index < keys.length && keys[index]!.t < timeMs; index += 1) {
    const key = keys[index]!;
    const progress = transition(timeMs - key.t);
    x += (key.view.x - previous.x) * progress;
    y += (key.view.y - previous.y) * progress;
    w += (key.view.w - previous.w) * progress;
    previous = key.view;
  }
  return {x, y, w};
}

/** The camera as drawn: a CSS transform on the editor layer (transform-origin 0 0). */
export interface CameraTransform {
  zoom: number;
  tx: number;
  ty: number;
  /** `translate(tx, ty) scale(zoom)`, or "none" at identity. */
  css: string;
  /** The view this transform draws, for the caption rule: a stage point p lands at frame origin + (p − view)·zoom. */
  view: View;
}

/**
 * The camera transform at `timeMs`. The view fills the frame (the crop, or the whole stage), so a
 * stage point p is drawn at frame origin + (p − view)·zoom. Values are rounded for stable CSS, and
 * the rounding is clamped so the frame never shows anything outside itself.
 */
export function cameraTransform(plan: Pick<CameraPlan, "frame" | "keys">, timeMs: number): CameraTransform {
  const frame = plan.frame;
  const view = cameraAt(plan, timeMs);
  const zoom = Math.max(1, Number((frame.width / view.w).toFixed(5)));
  const right = frame.x + frame.width;
  const bottom = frame.y + frame.height;
  const tx = Math.min(frame.x - frame.x * zoom, Math.max(right - right * zoom, Number((frame.x - view.x * zoom).toFixed(3))));
  const ty = Math.min(frame.y - frame.y * zoom, Math.max(bottom - bottom * zoom, Number((frame.y - view.y * zoom).toFixed(3))));
  return {
    zoom,
    tx,
    ty,
    css: zoom === 1 && tx === 0 && ty === 0 ? "none" : `translate(${tx}px, ${ty}px) scale(${zoom})`,
    view: {x: (frame.x - tx) / zoom, y: (frame.y - ty) / zoom, w: frame.width / zoom}
  };
}

/* ------------------------------------------------------------------ geometry */

interface Requirement {
  r: Rect;
  /** Fractions of the view height kept free above and below r. */
  top: number;
  bottom: number;
}

interface Margins {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const rect = (x0: number, y0: number, x1: number, y1: number): Rect => ({x0, y0, x1, y1});
const clampTo = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

function hull(...rects: Rect[]): Rect {
  let result = rects[0]!;
  for (const next of rects.slice(1)) {
    result = rect(Math.min(result.x0, next.x0), Math.min(result.y0, next.y0), Math.max(result.x1, next.x1), Math.max(result.y1, next.y1));
  }
  return result;
}

function within(inner: Rect, outer: Rect, tolerance = 1e-6): boolean {
  return inner.x0 >= outer.x0 - tolerance && inner.y0 >= outer.y0 - tolerance
    && inner.x1 <= outer.x1 + tolerance && inner.y1 <= outer.y1 + tolerance;
}

function nonEmpty(value: Rect): boolean {
  return value.x1 - value.x0 > 0 && value.y1 - value.y0 > 0;
}

function ease(progress: number): number {
  return progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
}

/** The scripted pointer between two points: eased, with a small upward arc. `u` is the editor's uiScale. */
export function cursorPoint(from: Point, to: Point, progress: number, u: number): Point {
  if (progress >= 1) return {...to};
  const eased = ease(progress);
  const arc = Math.sin(Math.PI * progress) * Math.min(40, Math.hypot(to.x - from.x, to.y - from.y) * 0.08);
  return {x: from.x + (to.x - from.x) * eased, y: from.y + (to.y - from.y) * eased - arc * u};
}

/** Where the camera may look: the frame's origin `(X0, Y0)` and size `W×H`, in stage px. */
class Geometry {
  readonly full: View;
  readonly X0: number;
  readonly Y0: number;
  readonly W: number;
  readonly H: number;

  constructor(readonly bounds: Frame, readonly stageHeight: number, readonly u: number) {
    this.X0 = bounds.x;
    this.Y0 = bounds.y;
    this.W = bounds.width;
    this.H = bounds.height;
    this.full = {x: this.X0, y: this.Y0, w: this.W};
  }

  heightOf(view: View): number {
    return (view.w * this.H) / this.W;
  }

  zoomOf(view: View): number {
    return this.W / view.w;
  }

  isFull(view: View): boolean {
    return view.w >= this.W - 1e-9;
  }

  viewRect(view: View): Rect {
    return rect(view.x, view.y, view.x + view.w, view.y + this.heightOf(view));
  }

  clip(value: Rect): Rect {
    const {X0, Y0, W, H} = this;
    return rect(clampTo(value.x0, X0, X0 + W), clampTo(value.y0, Y0, Y0 + H), clampTo(value.x1, X0, X0 + W), clampTo(value.y1, Y0, Y0 + H));
  }

  pad(value: Rect): Rect {
    const margin = CAMERA.PAD * this.u;
    return this.clip(rect(value.x0 - margin, value.y0 - margin, value.x1 + margin, value.y1 + margin));
  }

  box(point: Point, margins: Margins = CAMERA.CURSOR_BOX): Rect {
    const {u} = this;
    return this.clip(rect(point.x - margins.left * u, point.y - margins.top * u, point.x + margins.right * u, point.y + margins.bottom * u));
  }

  place(cx: number, cy: number, w: number): View {
    const h = (w * this.H) / this.W;
    return {x: clampTo(cx - w / 2, this.X0, this.X0 + this.W - w), y: clampTo(cy - h / 2, this.Y0, this.Y0 + this.H - h), w};
  }

  closeUp(point: Point, zoom: number): View {
    return this.place(point.x, point.y, this.W / zoom);
  }

  /** The view inset by the dead zone; a side at the frame edge keeps no inset, since a target there can never be centered. */
  inner(view: View): Rect {
    const bounds = this.viewRect(view);
    const dx = CAMERA.DEAD_ZONE * view.w;
    const dy = CAMERA.DEAD_ZONE * this.heightOf(view);
    return rect(
      bounds.x0 <= this.X0 + 0.5 ? bounds.x0 : bounds.x0 + dx,
      bounds.y0 <= this.Y0 + 0.5 ? bounds.y0 : bounds.y0 + dy,
      bounds.x1 >= this.X0 + this.W - 0.5 ? bounds.x1 : bounds.x1 - dx,
      bounds.y1 >= this.Y0 + this.H - 0.5 ? bounds.y1 : bounds.y1 - dy
    );
  }

  minWidth(requirements: Requirement[]): number {
    if (requirements.length === 0) return 0;
    let x0 = Infinity;
    let x1 = -Infinity;
    for (const requirement of requirements) {
      x0 = Math.min(x0, requirement.r.x0);
      x1 = Math.max(x1, requirement.r.x1);
    }
    let needHeight = 0;
    for (const a of requirements) {
      for (const b of requirements) {
        const room = 1 - a.bottom - b.top;
        if (room > 0) needHeight = Math.max(needHeight, (a.r.y1 - b.r.y0) / room);
      }
    }
    return Math.max(x1 - x0, (needHeight * this.W) / this.H);
  }

  intervals(requirements: Requirement[], w: number) {
    const {X0, Y0, W, H} = this;
    const h = (w * H) / W;
    if (requirements.length === 0) {
      return {xlo: X0, xhi: X0 + W - w, ylo: Y0, yhi: Y0 + H - h, xmid: X0 + (W - w) / 2, ymid: Y0 + (H - h) / 2};
    }
    let loX = -Infinity;
    let hiX = Infinity;
    let loY = -Infinity;
    let hiY = Infinity;
    for (const {r, top, bottom} of requirements) {
      loX = Math.max(loX, r.x1 - w);
      hiX = Math.min(hiX, r.x0);
      loY = Math.max(loY, r.y1 - (1 - bottom) * h);
      hiY = Math.min(hiY, r.y0 - top * h);
    }
    const xlo = Math.max(X0, loX);
    const xhi = Math.min(X0 + W - w, hiX);
    const ylo = Math.max(Y0, loY);
    const yhi = Math.min(Y0 + H - h, hiY);
    return {xlo, xhi, ylo, yhi, xmid: clampTo((loX + hiX) / 2, xlo, xhi), ymid: clampTo((loY + hiY) / 2, ylo, yhi)};
  }

  /**
   * The view nearest to `preferred` that meets every requirement with zoom ≤ cap: a minimal pan
   * at the preferred size when it fits, else the minimal zoom-out centered on the requirements.
   */
  frame(preferred: View | null, requirements: Requirement[], cap: number): View {
    const wmin = Math.min(this.W, Math.max(this.minWidth(requirements), this.W / cap));
    const feasible = (range: ReturnType<Geometry["intervals"]>) => range.xlo <= range.xhi + 1e-6 && range.ylo <= range.yhi + 1e-6;
    if (preferred && preferred.w >= wmin - 1e-9) {
      const range = this.intervals(requirements, preferred.w);
      if (feasible(range)) {
        return {x: clampTo(preferred.x, range.xlo, range.xhi), y: clampTo(preferred.y, range.ylo, range.yhi), w: preferred.w};
      }
    }
    const range = this.intervals(requirements, wmin);
    if (!feasible(range)) return {...this.full};
    return {x: range.xmid, y: range.ymid, w: wmin};
  }
}

/* ------------------------------------------------------------------ caption side and band */

function captionHeightDuring(captions: CameraInput["captions"], startMs: number, endMs: number): number {
  let height = 0;
  for (const caption of captions) if (caption.startMs < endMs && caption.endMs > startMs) height = Math.max(height, caption.height);
  return height;
}

/**
 * Decides at plan time whether the caption passes below or above an obstacle, and the band that
 * keeps room for it inside the frame. The caption's default place is at the stage bottom (HUD).
 */
function captionSide(geometry: Geometry, r: Rect, captionHeight: number): {side: CaptionObstacle["side"]; top: number; bottom: number} {
  const {Y0, H, u} = geometry;
  const needBelow = (CAMERA.CAPTION_GAP + captionHeight + CAMERA.CAPTION_EDGE) * u;
  const needAbove = (CAMERA.CAPTION_TOP_LIMIT + captionHeight + CAMERA.CAPTION_GAP) * u;
  const defaultTop = geometry.stageHeight - (CAMERA.CAPTION_BOTTOM + captionHeight) * u;
  const belowOk = r.y1 <= Y0 + H - needBelow;
  const aboveOk = r.y0 - Y0 >= needAbove;
  const down = Math.max(0, r.y1 + CAMERA.CAPTION_GAP * u - defaultTop);
  const up = Math.max(0, defaultTop + captionHeight * u - (r.y0 - CAMERA.CAPTION_GAP * u));
  if (belowOk && (!aboveOk || down <= up)) return {side: "below", top: 0, bottom: needBelow / H};
  if (aboveOk) return {side: "above", top: needAbove / H, bottom: 0};
  return {side: null, top: 0, bottom: 0};
}

/* ------------------------------------------------------------------ planner */

interface PlanKey {
  t: number;
  view: View;
  /** The view the planner wanted; growth only widens or pans it to meet containment. */
  pref: View;
  kind: CameraKey["kind"];
  priority: number;
  role: "lag" | "lead" | null;
  move: number;
}

interface Shot extends PlanKey {
  busyEnd: number;
}

interface Segment {
  a: number;
  b: number;
  r: Rect;
  move: number;
  /** For a move segment: the boxes of its start and of its target. */
  from?: Rect;
  to?: Rect;
}

interface PointerState {
  point: Point;
  /** Index of the current move, -1 before the first. */
  move: number;
  dwell: boolean;
}

function pointerState(moves: CameraMove[], home: Point, timeMs: number, u: number): PointerState {
  let index = -1;
  for (let candidate = 0; candidate < moves.length; candidate += 1) {
    if (moves[candidate]!.startMs <= timeMs) index = candidate;
    else break;
  }
  if (index < 0) return {point: home, move: -1, dwell: true};
  const move = moves[index]!;
  const span = move.endMs - move.startMs;
  if (span > 0 && timeMs < move.endMs) {
    return {point: cursorPoint(move.from, move.approach, (timeMs - move.startMs) / span, u), move: index, dwell: false};
  }
  const next = moves[index + 1]?.startMs;
  const q = next === undefined || next <= move.endMs ? 0 : Math.min(1, (timeMs - move.endMs) / (next - move.endMs));
  return {
    point: {x: move.arrive.x + (move.leave.x - move.arrive.x) * q, y: move.arrive.y + (move.leave.y - move.arrive.y) * q},
    move: index,
    dwell: true
  };
}

/**
 * The pointer proxy the planner verifies, which is what the host draws: moving from `from` toward
 * `approach`, then dwelling on a straight line from `arrive` to `leave` until the next move.
 */
export function cursorAt(moves: CameraMove[], home: Point, timeMs: number, u: number): Point {
  return pointerState(moves, home, timeMs, u).point;
}

/** The exported window clipped to the stage; the whole stage when it is missing or empty. */
function frameOf(input: CameraInput): Frame {
  const stage = {x: 0, y: 0, width: input.width, height: input.height};
  const frame = input.frame;
  if (!frame) return stage;
  const x = clampTo(frame.x, 0, input.width);
  const y = clampTo(frame.y, 0, input.height);
  const width = Math.min(frame.width, input.width - x);
  const height = Math.min(frame.height, input.height - y);
  return width > 0 && height > 0 ? {x, y, width, height} : stage;
}

export function planCamera(input: CameraInput): CameraPlan {
  const frame = frameOf(input);
  const geometry = new Geometry(frame, input.height, input.uiScale);
  const {full} = geometry;
  const zoom = input.zoom;
  const D = CAMERA.TRANSITION_MS;
  const holds: CameraHold[] = [];
  const obstacles: CaptionObstacle[] = [];
  const shots: Shot[] = [];

  // S1. Cues into holds, obstacles and shots.
  const shotTimes = input.cues.flatMap((cue) =>
    cue.kind === "popup" ? [cue.startMs - CAMERA.CAPTION_SLIDE_MS - D]
      : cue.kind === "toast" ? [cue.startMs + CAMERA.TOAST_SETTLE_MS - D]
        : cue.kind === "reveal" ? [cue.startMs - D]
          : []);
  for (const cue of input.cues) {
    let hold: [number, number];
    let window: [number, number];
    let key: number | null = null;
    let cap = 1;
    if (cue.kind === "popup") {
      hold = [cue.startMs - CAMERA.CAPTION_SLIDE_MS, cue.endMs + CAMERA.CAPTION_SLIDE_MS];
      window = hold;
      key = hold[0] - D;
      cap = Math.min(zoom ?? 1, CAMERA.POPUP_ZOOM_MAX);
    } else if (cue.kind === "toast") {
      hold = [cue.startMs + CAMERA.TOAST_SETTLE_MS, cue.endMs];
      window = [cue.startMs, cue.endMs + CAMERA.CAPTION_SLIDE_MS];
      key = hold[0] - D;
      cap = 1;
    } else if (cue.kind === "reveal") {
      const nextShot = Math.min(Infinity, ...shotTimes.filter((time) => time > cue.startMs));
      const length = Math.min(CAMERA.REVEAL_HOLD_MS, Math.max(CAMERA.REVEAL_MIN_MS, nextShot - cue.startMs));
      hold = [cue.startMs, cue.startMs + length];
      window = hold;
      key = cue.startMs - D;
      cap = Math.min(zoom ?? 1, CAMERA.REVEAL_ZOOM_MAX);
    } else {
      hold = [cue.startMs, cue.endMs];
      window = hold;
    }
    const captionHeight = captionHeightDuring(input.captions, window[0], window[1]);
    const requirements: Requirement[] = [];
    for (const {rect: measured, obstacle} of cue.rects) {
      const r = geometry.clip(measured);
      if (!nonEmpty(r)) continue;
      const band = obstacle && captionHeight > 0 ? captionSide(geometry, r, captionHeight) : {side: null, top: 0, bottom: 0};
      holds.push({rect: r, startMs: hold[0], endMs: hold[1], top: band.top, bottom: band.bottom});
      requirements.push({r: geometry.pad(r), top: 0, bottom: 0});
      if (band.side) requirements.push({r, top: band.top, bottom: band.bottom});
      if (obstacle) obstacles.push({rect: r, startMs: window[0], endMs: window[1], side: band.side, popup: cue.kind === "popup"});
    }
    if (key !== null && zoom !== null && requirements.length > 0) {
      const view = cap <= 1 ? {...full} : geometry.frame(null, requirements, cap);
      shots.push({t: key, view, pref: view, kind: cue.kind as CameraKey["kind"], priority: PRIORITY.shot, role: null, move: -1, busyEnd: hold[1]});
    }
  }
  const plan: CameraPlan = {
    width: input.width,
    height: input.height,
    frame,
    uiScale: input.uiScale,
    keys: [],
    holds,
    obstacles,
    repairedMoves: [],
    fallback: false
  };
  if (zoom === null) return plan;
  const moves = input.moves;

  // S2. Idle keys: back to the full editor after activity that is followed by a long enough pause.
  const activities = [
    ...moves.map((move) => [move.startMs, move.workEndMs] as [number, number]),
    ...shots.map((shot) => [shot.t, shot.busyEnd] as [number, number])
  ].sort((left, right) => left[0] - right[0]);
  const merged: [number, number][] = [];
  for (const [start, end] of activities) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  const idle: PlanKey[] = [];
  merged.forEach(([, end], index) => {
    const next = merged[index + 1]?.[0];
    if (next === undefined || next - end >= CAMERA.IDLE_MS) {
      idle.push({t: end + CAMERA.IDLE_OUT_DELAY_MS, view: full, pref: full, kind: "idle", priority: PRIORITY.idle, role: null, move: -1});
    }
  });

  // S3. Soft keys: zoom in on the pointer, pan lazily when the target leaves the dead zone.
  const soft: PlanKey[] = [];
  const goalAt = (time: number): View => {
    let best: PlanKey | null = null;
    for (const key of [...idle, ...shots, ...soft]) {
      if (key.t <= time && (!best || key.t > best.t || (key.t === best.t && key.priority > best.priority))) best = key;
    }
    return best ? best.view : full;
  };
  const busy = (time: number) => shots.some((shot) => time >= shot.t && time < shot.busyEnd);
  const add = (key: PlanKey) => {
    if (!busy(key.t)) soft.push(key);
  };
  const live = moves.flatMap((move, index) => (move.endMs > move.startMs ? [index] : []));
  live.forEach((index, order) => {
    const move = moves[index]!;
    const current = goalAt(move.startMs);
    const approachBox = geometry.box(move.approach);
    const arriveBox = geometry.box(move.arrive);
    // A target laid out outside the frame (off the stage, or cut by the crop) cannot be shown: no close-up on the frame's edge.
    if (!nonEmpty(approachBox) && !nonEmpty(arriveBox)) return;
    const target = hull(approachBox, arriveBox);
    const zoomed = geometry.zoomOf(current) >= CAMERA.SETTLE_ZOOM_RATIO * zoom;
    if (zoomed && within(target, geometry.inner(current))) return;
    if (!zoomed) {
      const view = geometry.frame(geometry.closeUp(move.approach, zoom), [{r: geometry.pad(target), top: 0, bottom: 0}], zoom);
      add({
        t: move.startMs + CAMERA.LAG_MS,
        view,
        pref: view,
        kind: "zoom-in",
        priority: PRIORITY.soft,
        role: move.endMs - move.startMs <= CAMERA.LAG_SPAN_MAX_MS ? "lag" : null,
        move: index
      });
      return;
    }
    // Pan at the current zoom, centered on the target as far as keeping the pointer's start in view allows.
    const currentZoom = geometry.zoomOf(current);
    const aim = geometry.closeUp({x: (target.x0 + target.x1) / 2, y: (target.y0 + target.y1) / 2}, currentZoom);
    const view = geometry.frame(aim, [{r: geometry.pad(hull(geometry.box(move.from), target)), top: 0, bottom: 0}], currentZoom);
    const bridge = geometry.zoomOf(view) < CAMERA.SETTLE_ZOOM_RATIO * zoom;
    add({
      t: Math.min(move.endMs - D - CAMERA.LEAD_SETTLE_MS, move.startMs - CAMERA.LEAD_MIN_MS),
      view,
      pref: view,
      kind: bridge ? "bridge" : "pan",
      priority: PRIORITY.soft,
      role: "lead",
      move: index
    });
    const nextStart = order + 1 < live.length ? moves[live[order + 1]!]!.startMs : Infinity;
    if (bridge && nextStart - move.endMs >= CAMERA.SETTLE_MIN_REST_MS) {
      const settle = geometry.frame(geometry.closeUp(move.arrive, zoom), [{r: geometry.pad(geometry.box(move.arrive)), top: 0, bottom: 0}], zoom);
      add({t: move.endMs + CAMERA.SETTLE_DELAY_MS, view: settle, pref: settle, kind: "settle", priority: PRIORITY.soft, role: null, move: index});
    }
  });

  // S4. Thinning: keys at least MIN_KEY_GAP_MS apart; the higher priority wins a conflict.
  const candidates = [...idle, ...shots, ...soft]
    .map((key): PlanKey => ({t: key.t, view: key.view, pref: key.pref, kind: key.kind, priority: key.priority, role: key.role, move: key.move}))
    .sort((left, right) => left.t - right.t || right.priority - left.priority);
  const keys: PlanKey[] = [];
  for (const key of candidates) {
    if (key.t < 0) {
      key.t = 0;
      key.role = null;
    }
    const last = keys.at(-1);
    if (last && key.t - last.t < CAMERA.MIN_KEY_GAP_MS) {
      if (key.priority >= last.priority) keys[keys.length - 1] = key;
      continue;
    }
    keys.push(key);
  }

  // S5 and S6. Grow the goals to contain the pointer and the holds, verify, and repair.
  const segments = pointerSegments(geometry, moves, input.home);
  const strict = new Set<number>();
  grow(geometry, keys, holds, segments, strict);
  const verifyPlan = () => pointerFailures(geometry, keys, input);
  for (let pass = 0; pass < CAMERA.REPAIR_PASSES; pass += 1) {
    const failing = verifyPlan().filter((failure) => failure.move >= 0);
    if (failing.length === 0) break;
    for (const failure of failing) strict.add(failure.move);
    grow(geometry, keys, holds, segments, strict);
  }
  if (verifyPlan().length > 0) {
    moves.forEach((_, index) => strict.add(index));
    grow(geometry, keys, holds, segments, strict);
    plan.fallback = true;
  }
  plan.keys = keys.map((key) => ({t: key.t, view: key.view, kind: key.kind}));
  plan.repairedMoves = [...strict].sort((left, right) => left - right);
  return plan;
}

function pointerSegments(geometry: Geometry, moves: CameraMove[], home: Point): Segment[] {
  const segments: Segment[] = [{a: -Infinity, b: moves[0]?.startMs ?? Infinity, r: geometry.box(home), move: -1}];
  moves.forEach((move, index) => {
    if (move.endMs > move.startMs) {
      const from = geometry.box(move.from);
      const to = geometry.box(move.approach);
      segments.push({a: move.startMs, b: move.endMs, r: hull(from, to), from, to, move: index});
    }
    segments.push({
      a: move.endMs,
      b: moves[index + 1]?.startMs ?? Infinity,
      r: hull(geometry.box(move.arrive), geometry.box(move.leave)),
      move: -1
    });
  });
  return segments;
}

/**
 * S5: widens or pans each goal so it contains every pointer segment and hold its influence meets.
 * Before a move's lead key only the move's start must be in view, and a lag key needs only the
 * target; a strict move needs its whole path. Key times never change, so this is idempotent.
 */
function grow(geometry: Geometry, keys: PlanKey[], holds: CameraHold[], segments: Segment[], strict: Set<number>): void {
  const leadOf = new Map<number, number>();
  const lagOf = new Map<number, number>();
  keys.forEach((key, index) => {
    if (key.role === "lead") leadOf.set(key.move, index);
    if (key.role === "lag") lagOf.set(key.move, index);
  });
  keys.forEach((key, index) => {
    if (geometry.isFull(key.pref)) {
      key.view = {...geometry.full};
      return;
    }
    const a = key.t;
    const b = (keys[index + 1]?.t ?? Infinity) + CAMERA.TRANSITION_MS;
    const requirements: Requirement[] = [];
    for (const segment of segments) {
      if (!(segment.a < b && segment.b > a)) continue;
      let r = segment.r;
      if (segment.from && segment.to && !strict.has(segment.move)) {
        const lead = leadOf.get(segment.move);
        const lag = lagOf.get(segment.move);
        if (lead !== undefined && index < lead) r = segment.from;
        else if (lag !== undefined && index === lag) r = segment.to;
      }
      // A pointer entirely outside the frame is invisible anyway; it must not pull the view to the frame's edge.
      if (!nonEmpty(r)) continue;
      requirements.push({r: geometry.pad(r), top: 0, bottom: 0});
    }
    for (const hold of holds) {
      if (!(hold.startMs < b && hold.endMs > a)) continue;
      requirements.push({r: geometry.pad(hold.rect), top: 0, bottom: 0});
      if (hold.top > 0 || hold.bottom > 0) requirements.push({r: hold.rect, top: hold.top, bottom: hold.bottom});
    }
    const view = geometry.frame(key.pref, requirements, geometry.zoomOf(key.pref));
    key.view = geometry.zoomOf(view) < CAMERA.ZOOM_SNAP ? {...geometry.full} : view;
  });
}

/**
 * S6: frames where the pointer proxy leaves the view, on a 10 ms grid; `move` is the moving
 * pointer's move, -1 while it dwells. Only the part of the pointer inside the frame counts: a
 * target laid out off the frame cannot be shown. Frame bounds and holds need no check here: every
 * goal is feasible and meets the holds its influence reaches, so every blend does too.
 */
function pointerFailures(geometry: Geometry, keys: PlanKey[], input: CameraInput): {t: number; move: number}[] {
  const failures: {t: number; move: number}[] = [];
  const plan = {frame: geometry.bounds, keys};
  for (let time = 0; time <= input.endMs; time += CAMERA.CHECK_STEP_MS) {
    const bounds = geometry.viewRect(cameraAt(plan, time));
    const pointer = pointerState(input.moves, input.home, time, geometry.u);
    const visible = geometry.box(pointer.point, CAMERA.CURSOR_VISIBLE);
    if (nonEmpty(visible) && !within(visible, bounds, 0.5)) failures.push({t: time, move: pointer.dwell ? -1 : pointer.move});
  }
  return failures;
}

/* ------------------------------------------------------------------ caption rule */

const smooth = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

type CaptionBox = {left: number; top: number; width: number; height: number};

/** How far an obstacle's slide has come: 0 outside its window, 1 inside it, smooth over CAPTION_SLIDE_MS at both ends. */
function slideWeight(obstacle: CaptionObstacle, timeMs: number): number {
  return Math.min(
    smooth((timeMs - obstacle.startMs) / CAMERA.CAPTION_SLIDE_MS),
    smooth((obstacle.endMs - timeMs) / CAMERA.CAPTION_SLIDE_MS)
  );
}

/** A world rect as drawn through the camera, in HUD px: stage px = frame origin + (world − view)·zoom. */
function toHud(plan: CameraPlan, view: View, value: Rect): Rect {
  const u = plan.uiScale;
  const zoom = plan.frame.width / view.w;
  return {
    x0: (plan.frame.x + (value.x0 - view.x) * zoom) / u,
    y0: (plan.frame.y + (value.y0 - view.y) * zoom) / u,
    x1: (plan.frame.x + (value.x1 - view.x) * zoom) / u,
    y1: (plan.frame.y + (value.y1 - view.y) * zoom) / u
  };
}

/** 1 when `p` overlaps the box (or comes within CAPTION_GAP of it) on that axis, falling to 0 at the gap. */
function nearness(p0: number, p1: number, low: number, high: number): number {
  const gap = CAMERA.CAPTION_GAP;
  return clampTo((Math.min(p1, high) - Math.max(p0, low) + gap) / gap, 0, 1);
}

/**
 * The caption's top in HUD px at `timeMs`. `caption` is its default box as laid out without any
 * shift. Popups push it first; the reacting widget and typed text push it only as popups fade out.
 * Obstacles slide it over CAPTION_SLIDE_MS inside their windows, so it never jumps. `view` is the
 * camera as drawn in this frame.
 */
export function captionTop(plan: CameraPlan, view: View, timeMs: number, caption: CaptionBox, editorHeight: number): number {
  const gap = CAMERA.CAPTION_GAP;
  const left = caption.left;
  const right = caption.left + caption.width;
  const top = caption.top;
  const bottom = caption.top + caption.height;
  const down = [0, 0];
  const up = [0, 0];
  let popupWeight = 0;
  for (const obstacle of plan.obstacles) {
    const weight = slideWeight(obstacle, timeMs);
    if (weight <= 0 || !obstacle.side) continue;
    const tier = obstacle.popup ? 0 : 1;
    if (obstacle.popup) popupWeight = Math.max(popupWeight, weight);
    const p = toHud(plan, view, obstacle.rect);
    const fx = nearness(p.x0, p.x1, left, right);
    const fy = nearness(p.y0, p.y1, top, bottom);
    const factor = weight * fx * fy;
    if (obstacle.side === "below") down[tier] = Math.max(down[tier]!, factor * Math.max(0, p.y1 + gap - top));
    else up[tier] = Math.min(up[tier]!, factor * Math.min(0, p.y0 - gap - caption.height - top));
  }
  const shift = down[0]! + up[0]! + (1 - popupWeight) * (down[1]! + up[1]!);
  return Math.min(editorHeight - CAMERA.CAPTION_EDGE - caption.height, Math.max(CAMERA.CAPTION_TOP_LIMIT, top + shift));
}

/**
 * The caption's opacity at `timeMs`. `caption` is its box as placed by `captionTop` (HUD px). A popup
 * that leaves no room for the caption above or below it (a short or very wide editor, or a long
 * caption) fades the caption out where they would meet, over CAPTION_SLIDE_MS before the popup
 * opens, and back in after it closes: captions sit above the camera, and the popup stays whole.
 */
export function captionOpacity(plan: CameraPlan, view: View, timeMs: number, caption: CaptionBox): number {
  let fade = 0;
  for (const obstacle of plan.obstacles) {
    if (!obstacle.popup || obstacle.side) continue;
    const weight = slideWeight(obstacle, timeMs);
    if (weight <= 0) continue;
    const p = toHud(plan, view, obstacle.rect);
    fade = Math.max(fade, weight * nearness(p.x0, p.x1, caption.left, caption.left + caption.width)
      * nearness(p.y0, p.y1, caption.top, caption.top + caption.height));
  }
  return 1 - fade;
}

/* ------------------------------------------------------------------ pointer pulse and ripple */

type Press = {downMs: number; upMs: number};

function latestPress(presses: Press[], timeMs: number): number {
  let index = -1;
  for (let candidate = 0; candidate < presses.length; candidate += 1) {
    if (presses[candidate]!.downMs <= timeMs) index = candidate;
    else break;
  }
  return index;
}

function pulseOf(press: Press, timeMs: number, startScale: number): number {
  const since = timeMs - press.downMs;
  if (since < 0) return 1;
  if (since < PULSE.PRESS_MS) {
    const remaining = 1 - since / PULSE.PRESS_MS;
    return startScale - (startScale - PULSE.MIN) * (1 - remaining * remaining);
  }
  const releaseMs = Math.max(press.upMs, press.downMs + PULSE.PRESS_MS);
  if (timeMs < releaseMs) return PULSE.MIN;
  if (timeMs - releaseMs >= PULSE.SPRING_MS) return 1;
  const tau = (timeMs - releaseMs) / 1000;
  return 1 - (1 - PULSE.MIN) * Math.exp(-PULSE.DECAY * tau)
    * (Math.cos(PULSE.OMEGA * tau) + (PULSE.DECAY / PULSE.OMEGA) * Math.sin(PULSE.OMEGA * tau));
}

/**
 * The pointer's own click pulse: it shrinks to 0.80 in 70 ms, holds while a drag lasts, and springs
 * back with a small overshoot, exactly 1 again 450 ms after the release. A press during the previous
 * spring starts from that spring's value, so the scale never jumps.
 */
export function pointerScale(presses: Press[], timeMs: number): number {
  const index = latestPress(presses, timeMs);
  if (index < 0) return 1;
  const startScale = index > 0 ? pulseOf(presses[index - 1]!, presses[index]!.downMs, 1) : 1;
  return pulseOf(presses[index]!, timeMs, startScale);
}

/** The click ripple: fades in over 60 ms while it grows, then eases out; null once it is gone. */
export function ripple(presses: Press[], timeMs: number): {scale: number; opacity: number} | null {
  const index = latestPress(presses, timeMs);
  if (index < 0) return null;
  const since = timeMs - presses[index]!.downMs;
  if (since >= RIPPLE.MS) return null;
  const progress = since / RIPPLE.MS;
  return {
    scale: RIPPLE.FROM + RIPPLE.GROWTH * (1 - (1 - progress) ** 3),
    opacity: RIPPLE.OPACITY * Math.min(1, since / RIPPLE.FADE_IN_MS) * (1 - progress) ** 2
  };
}

/** The pointer glyph: its size in editor px and its hotspot on the 24-unit SVG grid. */
export interface PointerGlyph {
  size: number;
  hotspot: Point;
}

/** CSS for the pointer and its ripple in one frame, in stage px. */
export interface PointerStyle {
  /** Width and height of the pointer: its editor size × uiScale × zoom, so it scales with the camera. */
  size: number;
  /** The pointer's transform-origin: its hotspot, so the pulse shrinks toward the tip. */
  origin: string;
  /** Puts the hotspot on the tip and applies the click pulse. */
  transform: string;
  /** The ripple, centered on the tip and scaled with the camera; null when there is none. */
  ripple: {opacity: number; transform: string} | null;
}

/**
 * How the pointer is drawn at `timeMs`: `tip` is the hotspot in stage px after the camera, `zoom` the
 * camera's zoom. The pointer scales with the camera, as the recorded pointer does in Screen Studio,
 * and pulses on every press (see `pointerScale`).
 */
export function pointerStyle(glyph: PointerGlyph, tip: Point, uiScale: number, zoom: number, presses: Press[], timeMs: number): PointerStyle {
  const size = glyph.size * uiScale * zoom;
  const hotspotX = (glyph.hotspot.x * size) / 24;
  const hotspotY = (glyph.hotspot.y * size) / 24;
  const wave = ripple(presses, timeMs);
  return {
    size,
    origin: `${hotspotX}px ${hotspotY}px`,
    transform: `translate(${tip.x - hotspotX}px, ${tip.y - hotspotY}px) scale(${pointerScale(presses, timeMs)})`,
    ripple: wave ? {opacity: wave.opacity, transform: `translate(${tip.x}px, ${tip.y}px) scale(${wave.scale * uiScale * zoom})`} : null
  };
}
