import {FrameBridge, type FrameEvent} from "./bridge.js";

interface CaptureLoadOptions {
  state: {
    fieldData: Record<string, unknown>;
    channel: Record<string, unknown>;
    recents: Record<string, unknown>;
    seed: number;
    fixedTime: string;
  };
  viewport: {width: number; height: number};
  output: {width: number; height: number};
  camera: {scale: number; x: number; y: number; origin?: string};
  background: {color?: string; image?: string; checkerboard?: boolean};
  readyTimeoutMs?: number;
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
    this.bridge = new FrameBridge(
      this.iframe,
      this.frameOrigin,
      options.state,
      (event) => this.events.push(event),
      true
    );
    await this.bridge.start((options.readyTimeoutMs ?? 10_000) + 2_000);
  }

  dispatch(listener: string, event: unknown): Promise<void> {
    if (!this.bridge) throw new Error("Capture host is not loaded.");
    return this.bridge.dispatch(listener, event);
  }

  updateFields(fieldData: Record<string, unknown>): Promise<void> {
    if (!this.bridge) throw new Error("Capture host is not loaded.");
    return this.bridge.updateFields(fieldData);
  }

  getEvents(): FrameEvent[] {
    return structuredClone(this.events);
  }
}

window.__SWS_CAPTURE__ = new CaptureController();
