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
  #pending = new Map<string, {type: string; resolve: () => void; reject: (reason: Error) => void; timer: number}>();
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

  start(timeoutMs = 12_000): Promise<void> {
    const source = new URL(`/__sws/frame/${this.sessionId}`, this.frameOrigin);
    source.searchParams.set("nonce", this.nonce);
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

  #command(type: string, acknowledgement: string, payload: Record<string, unknown>, timeoutMs = 10_000): Promise<void> {
    const requestId = `${this.sessionId}-${++this.#requestSequence}`;
    return new Promise<void>((resolve, reject) => {
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

  dispatch(listener: string, event: unknown): Promise<void> {
    return this.#command("host:emit", "frame:event-dispatched", {listener, event});
  }

  updateFields(fieldData: Record<string, unknown>): Promise<void> {
    this.#state.fieldData = {...this.#state.fieldData, ...structuredClone(fieldData)};
    return this.#command("host:update-fields", "frame:fields-updated", {fieldData});
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
          pending.resolve();
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
