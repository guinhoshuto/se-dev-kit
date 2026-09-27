import type {FontReport} from "../types.js";

interface RuntimeState {
  sessionId: string;
  fieldData: Record<string, unknown>;
  channel: Record<string, unknown>;
  recents: Record<string, unknown>;
  seed: number;
  fixedTime: string;
}

interface BridgeEnvelope {
  protocol: "se-widget-studio";
  version: 1;
  sessionId: string;
  nonce: string;
  type: string;
  payload?: unknown;
}

function fontsOf(payload: unknown): FontReport | undefined {
  return (payload as {fonts?: FontReport} | undefined)?.fonts;
}

export interface FrameEvent {
  type: string;
  payload?: unknown;
}

function randomHex(bytes: number): string {
  const values = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(values, (value) => value.toString(16).padStart(2, "0")).join("");
}

function isEnvelope(value: unknown): value is BridgeEnvelope {
  if (!value || typeof value !== "object") return false;
  const envelope = value as Partial<BridgeEnvelope>;
  return envelope.protocol === "se-widget-studio" && envelope.version === 1 && typeof envelope.type === "string";
}

export class FrameBridge {
  readonly iframe: HTMLIFrameElement;
  readonly frameOrigin: string;
  readonly sessionId: string;
  readonly nonce: string;
  #state: RuntimeState;
  #clockManaged: boolean;
  #onEvent: (event: FrameEvent) => void;
  #resolveReady?: () => void;
  #rejectReady?: (reason: Error) => void;
  #readyPromise: Promise<void>;
  #readyTimer?: number;
  #requestSequence = 0;
  #pending = new Map<string, {type: string; resolve: (payload: unknown) => void; reject: (reason: Error) => void; timer: number}>();
  #messageHandler: (event: MessageEvent) => void;

  constructor(
    iframe: HTMLIFrameElement,
    frameOrigin: string,
    state: Omit<RuntimeState, "sessionId">,
    onEvent: (event: FrameEvent) => void = () => undefined,
    clockManaged = false
  ) {
    this.iframe = iframe;
    this.frameOrigin = frameOrigin;
    this.sessionId = randomHex(12);
    this.nonce = randomHex(16);
    this.#state = {...state, sessionId: this.sessionId};
    this.#clockManaged = clockManaged;
    this.#onEvent = onEvent;
    this.#readyPromise = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    this.#messageHandler = (event) => this.#receive(event);
    window.addEventListener("message", this.#messageHandler);
  }

  /** `docKey` selects the registered values the frame server substitutes into `{{field}}` placeholders. */
  start(timeoutMs = 12_000, docKey?: string): Promise<void> {
    const source = new URL(`/__sws/frame/${this.sessionId}`, this.frameOrigin);
    source.searchParams.set("nonce", this.nonce);
    if (docKey) source.searchParams.set("doc", docKey);
    this.iframe.src = source.href;
    this.#readyTimer = window.setTimeout(
      () => this.#rejectReady?.(new Error(`Widget bridge timed out after ${timeoutMs}ms.`)),
      timeoutMs
    );
    return this.#readyPromise;
  }

  destroy(): void {
    window.removeEventListener("message", this.#messageHandler);
    if (this.#readyTimer !== undefined) window.clearTimeout(this.#readyTimer);
    for (const pending of this.#pending.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(new Error("Widget bridge was destroyed before the command completed."));
    }
    this.#pending.clear();
    this.iframe.removeAttribute("src");
  }

  send(type: string, payload?: unknown): void {
    const target = this.iframe.contentWindow;
    if (!target) throw new Error("Widget frame is not available.");
    const envelope: BridgeEnvelope = {
      protocol: "se-widget-studio",
      version: 1,
      sessionId: this.sessionId,
      nonce: this.nonce,
      type
    };
    if (payload !== undefined) envelope.payload = payload;
    target.postMessage(envelope, this.frameOrigin);
  }

  /**
   * Sends a command and resolves with the acknowledgement's payload. The timeout uses this window's
   * timers, which a capture's paused clock never fires, so captures keep a real deadline in Node.
   */
  #command(type: string, acknowledgement: string, payload: Record<string, unknown>, timeoutMs = 10_000): Promise<unknown> {
    const requestId = `${this.sessionId}-${++this.#requestSequence}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error(`Widget command ${type} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      this.#pending.set(requestId, {type: acknowledgement, resolve, reject, timer});
      try {
        this.send(type, {...payload, requestId});
      } catch (error) {
        window.clearTimeout(timer);
        this.#pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Resolves once the frame dispatched the event and its fonts settled, with the frame's font report. */
  async dispatch(listener: string, event: unknown): Promise<FontReport | undefined> {
    return fontsOf(await this.#command("host:emit", "frame:event-dispatched", {listener, event}));
  }

  async updateFields(fieldData: Record<string, unknown>): Promise<FontReport | undefined> {
    this.#state.fieldData = {...this.#state.fieldData, ...structuredClone(fieldData)};
    return fontsOf(await this.#command("host:update-fields", "frame:fields-updated", {fieldData}));
  }

  /** Waits for stylesheets, layout and fonts in the frame (`light`: without collecting families) and returns the report. */
  async settle(light = false, timeoutMs = 10_000): Promise<FontReport> {
    const payload = await this.#command("host:settle", "frame:fonts", {light}, timeoutMs);
    const report = (payload as {report?: FontReport} | undefined)?.report;
    if (!report) throw new Error("Widget frame answered host:settle without a font report.");
    return report;
  }

  #receive(event: MessageEvent): void {
    if (event.origin !== this.frameOrigin || event.source !== this.iframe.contentWindow || !isEnvelope(event.data)) return;
    const envelope = event.data;
    if (envelope.sessionId !== this.sessionId || envelope.nonce !== this.nonce) return;
    this.#onEvent({type: envelope.type, ...(envelope.payload === undefined ? {} : {payload: envelope.payload})});
    const requestId = (envelope.payload as {requestId?: unknown} | undefined)?.requestId;
    if (typeof requestId === "string") {
      const pending = this.#pending.get(requestId);
      if (pending && (pending.type === envelope.type || envelope.type === "frame:error")) {
        window.clearTimeout(pending.timer);
        this.#pending.delete(requestId);
        if (envelope.type === "frame:error") {
          const message = (envelope.payload as {message?: string}).message ?? "Widget command failed.";
          pending.reject(new Error(message));
        } else {
          pending.resolve(envelope.payload);
        }
      }
    }
    if (envelope.type === "frame:booted") {
      this.send("host:init", {state: this.#state, clockManaged: this.#clockManaged});
    } else if (envelope.type === "frame:widget-ready") {
      if (this.#readyTimer !== undefined) window.clearTimeout(this.#readyTimer);
      this.#resolveReady?.();
    } else if (envelope.type === "frame:error") {
      const message = (envelope.payload as {message?: string} | undefined)?.message ?? "Widget frame failed.";
      if (this.#readyTimer !== undefined) window.clearTimeout(this.#readyTimer);
      this.#rejectReady?.(new Error(message));
    }
  }
}
