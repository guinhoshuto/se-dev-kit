import {FrameBridge, type FrameEvent} from "./bridge.js";
import type {FontReport} from "../types.js";

interface CaptureState {
  fieldData: Record<string, unknown>;
  channel: Record<string, unknown>;
  recents: Record<string, unknown>;
  session?: Record<string, unknown>;
  seed: number;
  fixedTime: string;
}

interface CaptureLoadOptions {
  state: CaptureState;
  viewport: {width: number; height: number};
  output: {width: number; height: number};
  camera: {scale: number; x: number; y: number; origin?: string};
  background: {color?: string; image?: string; checkerboard?: boolean};
  readyTimeoutMs?: number;
  /** Key from StudioServer.registerFrameDocument for this scene's placeholder values. */
  docKey?: string;
}

interface CaptureReloadOptions {
  /** The complete field values of the new frame, not a patch. */
  fieldData: Record<string, unknown>;
  readyTimeoutMs?: number;
  /** Key from StudioServer.registerFrameDocument for these values. */
  docKey?: string;
}

declare global {
  interface Window {
    __SWS_CAPTURE__: CaptureController;
  }
}

class CaptureController {
  readonly stage: HTMLElement;
  readonly wrap: HTMLElement;
  readonly iframe: HTMLIFrameElement;
  readonly frameOrigin: string;
  bridge?: FrameBridge;
  events: FrameEvent[] = [];
  #state?: CaptureState;
  /** Index in `events` where the current frame's load began. */
  #loadStart = 0;
  #reloading?: Promise<void>;

  constructor() {
    const stage = document.querySelector<HTMLElement>("#capture-stage");
    const wrap = document.querySelector<HTMLElement>("#widget-wrap");
    const iframe = document.querySelector<HTMLIFrameElement>("#widget-frame");
    const frameOrigin = document.body.dataset.frameOrigin;
    if (!stage || !wrap || !iframe || !frameOrigin) throw new Error("Capture host markup is incomplete.");
    this.stage = stage;
    this.wrap = wrap;
    this.iframe = iframe;
    this.frameOrigin = frameOrigin;
  }

  async load(options: CaptureLoadOptions): Promise<void> {
    this.bridge?.destroy();
    this.events = [];
    this.#loadStart = 0;
    this.stage.style.width = `${options.output.width}px`;
    this.stage.style.height = `${options.output.height}px`;
    this.stage.style.backgroundColor = options.background.color ?? "transparent";
    this.stage.style.backgroundImage = options.background.image
      ? `url("${options.background.image.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}")`
      : options.background.checkerboard
        ? "linear-gradient(45deg,#d7d9de 25%,transparent 25%),linear-gradient(-45deg,#d7d9de 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#d7d9de 75%),linear-gradient(-45deg,transparent 75%,#d7d9de 75%)"
        : "none";
    this.stage.style.backgroundSize = options.background.image ? "cover" : options.background.checkerboard ? "24px 24px" : "auto";
    this.stage.style.backgroundPosition = options.background.image
      ? "center"
      : options.background.checkerboard
        ? "0 0,0 12px,12px -12px,-12px 0"
        : "center";
    if (options.background.image) {
      const background = new Image();
      background.src = options.background.image;
      try {
        await background.decode();
      } catch {
        throw new Error(`Background image could not be loaded: ${options.background.image}`);
      }
    }
    this.wrap.style.width = `${options.viewport.width}px`;
    this.wrap.style.height = `${options.viewport.height}px`;
    this.wrap.style.transformOrigin = options.camera.origin ?? "center center";
    this.wrap.style.transform = `translate(-50%, -50%) translate(${options.camera.x}px, ${options.camera.y}px) scale(${options.camera.scale})`;
    this.#state = structuredClone(options.state);
    this.bridge = this.#bridgeFor(this.#state);
    await this.bridge.start((options.readyTimeoutMs ?? 10_000) + 2_000, options.docKey);
  }

  /**
   * Starts replacing the widget frame with one that loads `fieldData`, as the StreamElements editor
   * does when a field changes; `reloaded()` settles when the new frame is ready. It returns before
   * the load, so `getLoadEvents()` already covers only the new frame when the caller polls it. The
   * stage keeps its size, background and camera, and `events` keeps what the replaced frame
   * reported, so its runtime errors still count.
   */
  reload(options: CaptureReloadOptions): void {
    if (!this.bridge || !this.#state) throw new Error("Capture host is not loaded.");
    this.bridge.destroy();
    this.#state = {...this.#state, fieldData: structuredClone(options.fieldData)};
    this.#loadStart = this.events.length;
    this.bridge = this.#bridgeFor(this.#state);
    this.#reloading = this.bridge.start((options.readyTimeoutMs ?? 10_000) + 2_000, options.docKey);
    // Handled here too, so a failure before reloaded() is awaited is not an unhandled rejection.
    this.#reloading.catch(() => undefined);
  }

  reloaded(): Promise<void> {
    if (!this.#reloading) throw new Error("Capture host is not reloading.");
    return this.#reloading;
  }

  #bridgeFor(state: CaptureState): FrameBridge {
    return new FrameBridge(
      this.iframe,
      this.frameOrigin,
      state,
      (event) => {
        // Command acknowledgements for host:settle run once per video frame; their reports return to the caller.
        if ((event.type === "frame:fonts" || event.type === "frame:settling") && typeof (event.payload as {requestId?: unknown} | undefined)?.requestId === "string") return;
        this.events.push(event);
      },
      true
    );
  }

  dispatch(listener: string, event: unknown): Promise<FontReport | undefined> {
    if (!this.bridge) throw new Error("Capture host is not loaded.");
    return this.bridge.dispatch(listener, event);
  }

  updateFields(fieldData: Record<string, unknown>): Promise<FontReport | undefined> {
    if (!this.bridge) throw new Error("Capture host is not loaded.");
    return this.bridge.updateFields(fieldData);
  }

  /** The Node caller keeps the real deadline; this window's timers stop while the clock is paused. */
  settle(light = false): Promise<FontReport> {
    if (!this.bridge) throw new Error("Capture host is not loaded.");
    return this.bridge.settle(light, 3_600_000);
  }

  getEvents(): FrameEvent[] {
    return structuredClone(this.events);
  }

  /** The events of the current frame only, from its load or last reload on. */
  getLoadEvents(): FrameEvent[] {
    return structuredClone(this.events.slice(this.#loadStart));
  }
}

window.__SWS_CAPTURE__ = new CaptureController();
