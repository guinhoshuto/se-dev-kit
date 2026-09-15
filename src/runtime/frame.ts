import type {JsonObject, JsonValue, RuntimeState} from "../types.js";
import {BRIDGE_PROTOCOL, BRIDGE_VERSION} from "../version.js";

declare global {
  interface Window {
    SE_API: unknown;
    __SE_WIDGET_STUDIO__: {
      getState: () => RuntimeState | null;
      emit: (listener: string, event: JsonValue) => void;
    };
  }
}

interface FrameRuntimeOptions {
  sessionId: string;
  nonce: string;
  parentOrigin: string;
  widgetScriptUrl: string;
  adapterUrl?: string;
  readySelector?: string;
  timeoutMs: number;
  assetMap?: Record<string, string>;
}

interface BridgeEnvelope {
  protocol: typeof BRIDGE_PROTOCOL;
  version: typeof BRIDGE_VERSION;
  sessionId: string;
  nonce: string;
  type: string;
  payload?: unknown;
}

interface BrowserAdapter {
  beforeLoad?: (state: RuntimeState) => RuntimeState | Promise<RuntimeState>;
  afterLoad?: (context: {state: RuntimeState}) => void | Promise<void>;
  beforeDispatch?: (context: {listener: string; event: JsonValue}) => JsonValue | Promise<JsonValue>;
}

function isEnvelope(value: unknown): value is BridgeEnvelope {
  if (!value || typeof value !== "object") return false;
  const envelope = value as Partial<BridgeEnvelope>;
  return (
    envelope.protocol === BRIDGE_PROTOCOL &&
    envelope.version === BRIDGE_VERSION &&
    typeof envelope.sessionId === "string" &&
    typeof envelope.nonce === "string" &&
    typeof envelope.type === "string"
  );
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function printable(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function createSeApi(onStoreUpdate: (listener: string, event: JsonValue) => void) {
  const store = new Map<string, JsonValue>();
  const counters = new Map<string, number>();
  const unsupported = (path: string): unknown =>
    new Proxy(
      function unsupportedApi() {},
      {
        get: (_target, property) => unsupported(`${path}.${String(property)}`),
        apply: () =>
          Promise.reject(
            Object.assign(new Error(`SE_API method is not simulated: ${path}`), {code: "SWS_UNSUPPORTED_API"})
          )
      }
    );
  const namespace = <T extends object>(path: string, target: T): T =>
    new Proxy(target, {
      get(value, property, receiver) {
        if (Reflect.has(value, property)) return Reflect.get(value, property, receiver);
        return unsupported(`${path}.${String(property)}`);
      }
    });

  return new Proxy(
    {
      store: namespace("SE_API.store", {
        async get(key: string) {
          return structuredClone(store.get(key) ?? null);
        },
        async set(key: string, value: JsonValue): Promise<void> {
          if (!/^[a-z0-9]+$/i.test(key)) {
            throw Object.assign(new Error("SE_API.store keys must be alphanumeric."), {code: "SWS_INVALID_STORE_KEY"});
          }
          if (!value || typeof value !== "object" || Array.isArray(value)) {
            throw Object.assign(new Error("SE_API.store values must be JSON objects."), {code: "SWS_INVALID_STORE_VALUE"});
          }
          store.set(key, structuredClone(value));
          onStoreUpdate("kvstore:update", {
            data: {key: `customWidget.${key}`, value: structuredClone(value)}
          });
        }
      }),
      counters: namespace("SE_API.counters", {
        async get(key: string) {
          return {id: key, count: counters.get(key) ?? 0};
        }
      }),
      async getOverlayStatus() {
        return {isEditorMode: true, muted: false};
      }
    },
    {
      get(target, property, receiver) {
        if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
        return unsupported(`SE_API.${String(property)}`);
      }
    }
  );
}

async function waitForDocument(): Promise<void> {
  if (document.readyState !== "loading") return;
  await new Promise<void>((resolve) => document.addEventListener("DOMContentLoaded", () => resolve(), {once: true}));
}

async function waitForLoadedAssets(): Promise<void> {
  await (async () => {
    if (document.fonts) await document.fonts.ready;
    await Promise.all(
      Array.from(document.images).map(async (image) => {
        if (image.complete) {
          if (image.src && image.naturalWidth === 0) throw new Error("Image failed to decode.");
          if (image.src && typeof image.decode === "function") await image.decode();
          return;
        }
        await new Promise<void>((resolve, reject) => {
          image.addEventListener("load", () => resolve(), {once: true});
          image.addEventListener("error", () => reject(new Error(`Image failed to load: ${image.currentSrc || image.src}`)), {
            once: true
          });
        });
      })
    );
    await Promise.all(
      Array.from(document.querySelectorAll("video")).map(async (video) => {
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA || (!video.currentSrc && !video.src && !video.querySelector("source"))) return;
        await new Promise<void>((resolve, reject) => {
          video.addEventListener("loadeddata", () => resolve(), {once: true});
          video.addEventListener("error", () => reject(new Error(`Video failed to load: ${video.currentSrc}`)), {once: true});
        });
      })
    );
    const backgrounds = new Set<string>();
    for (const element of Array.from(document.querySelectorAll("*"))) {
      for (const pseudo of [null, "::before", "::after"]) {
        const value = getComputedStyle(element, pseudo).backgroundImage;
        for (const match of value.matchAll(/url\(["']?([^"')]+)["']?\)/g)) if (match[1]) backgrounds.add(match[1]);
      }
    }
    await Promise.all(Array.from(backgrounds, (url) => new Promise<void>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("CSS background image failed to load."));
      image.src = url;
    })));
    if (document.fonts) for (const face of document.fonts) if (face.status === "error") throw new Error("A font failed to load.");
  })();
}

async function waitForSelector(selector: string, timeoutMs: number): Promise<void> {
  if (document.querySelector(selector)) return;
  const wait = new Promise<void>((resolve) => {
    const observer = new MutationObserver(() => {
      if (!document.querySelector(selector)) return;
      observer.disconnect();
      resolve();
    });
    observer.observe(document.documentElement, {childList: true, subtree: true, attributes: true});
  });

  let timeoutId = 0;
  await Promise.race([
    wait,
    new Promise<never>((_resolve, reject) => {
      timeoutId = window.setTimeout(() => reject(new Error(`Widget readiness timed out after ${timeoutMs}ms.`)), timeoutMs);
    })
  ]).finally(() => window.clearTimeout(timeoutId));
}

function installFixedDate(fixedTime: string): void {
  const NativeDate = Date;
  const fixedMilliseconds = NativeDate.parse(fixedTime);
  if (!Number.isFinite(fixedMilliseconds)) throw new Error(`Invalid fixed runtime time: ${fixedTime}`);
  const FixedDate = function (this: Date, ...values: unknown[]): string | Date {
    if (!new.target) return new NativeDate(fixedMilliseconds).toString();
    return Reflect.construct(NativeDate, values.length > 0 ? values : [fixedMilliseconds], new.target) as Date;
  } as unknown as DateConstructor;
  Object.setPrototypeOf(FixedDate, NativeDate);
  Object.defineProperty(FixedDate, "prototype", {value: NativeDate.prototype});
  FixedDate.now = () => fixedMilliseconds;
  FixedDate.parse = NativeDate.parse;
  FixedDate.UTC = NativeDate.UTC;
  globalThis.Date = FixedDate;
}

function loadClassicScript(source: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = source;
    script.async = false;
    script.addEventListener("load", () => resolve(), {once: true});
    script.addEventListener("error", () => reject(new Error(`Widget script failed to load: ${source}`)), {once: true});
    document.body.append(script);
  });
}

function withTimeout<T>(task: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer = 0;
  return Promise.race([task, new Promise<never>((_resolve, reject) => { timer = window.setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs); })]).finally(() => window.clearTimeout(timer));
}

export function installFrameRuntime(options: FrameRuntimeOptions): void {
  let runtimeState: RuntimeState | null = null;
  let adapter: BrowserAdapter = {};
  let initialized = false;
  const mapAssets = <T>(value: T): T => {
    if (!options.assetMap) return value;
    const rewrite = (input: unknown): unknown => {
      if (typeof input === "string") return options.assetMap?.[input] ?? input;
      if (Array.isArray(input)) return input.map(rewrite);
      if (input && typeof input === "object") return Object.fromEntries(Object.entries(input).map(([key, nested]) => [key, rewrite(nested)]));
      return input;
    };
    return rewrite(value) as T;
  };
  const nativeConsole = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
  };

  const send = (type: string, payload?: unknown) => {
    const envelope: BridgeEnvelope = {
      protocol: BRIDGE_PROTOCOL,
      version: BRIDGE_VERSION,
      sessionId: options.sessionId,
      nonce: options.nonce,
      type
    };
    if (payload !== undefined) envelope.payload = payload;
    window.parent.postMessage(envelope, options.parentOrigin);
  };

  for (const level of ["log", "info", "warn", "error"] as const) {
    console[level] = (...args: unknown[]) => {
      nativeConsole[level](...args);
      send("frame:console", {level, message: args.map(printable).join(" ")});
    };
  }
  window.addEventListener("error", (event) => {
    send("frame:error", {message: event.message, source: event.filename.split("/").at(-1) ?? "widget", line: event.lineno});
  });
  window.addEventListener("unhandledrejection", (event) => {
    send("frame:unhandled-rejection", {message: printable(event.reason)});
  });

  const emit = async (listener: string, event: JsonValue, requestId?: string) => {
    const transformed = mapAssets(adapter.beforeDispatch ? await adapter.beforeDispatch({listener, event}) : event);
    window.dispatchEvent(
      new CustomEvent("onEventReceived", {
        detail: {listener, event: structuredClone(transformed)}
      })
    );
    send("frame:event-dispatched", {listener, ...(requestId ? {requestId} : {})});
  };

  window.SE_API = createSeApi((listener, event) => void emit(listener, event));

  window.__SE_WIDGET_STUDIO__ = {
    getState: () => (runtimeState ? structuredClone(runtimeState) : null),
    emit: (listener, event) => void emit(listener, event)
  };

  const initialize = async (state: RuntimeState, clockManaged: boolean) => {
    if (initialized) throw new Error("Widget frame is already initialized. Reload it for a clean state.");
    initialized = true;
    Math.random = seededRandom(state.seed);
    runtimeState = mapAssets(structuredClone(state));
    if (options.adapterUrl) {
      const imported = (await import(options.adapterUrl)) as {default?: BrowserAdapter};
      adapter = imported.default ?? {};
    }
    if (adapter.beforeLoad) runtimeState = await adapter.beforeLoad(runtimeState);
    if (!clockManaged) installFixedDate(runtimeState.fixedTime);
    await waitForDocument();
    for (const script of Array.from(document.querySelectorAll<HTMLScriptElement>('script[type="application/x-sws-classic"]'))) {
      if (script.dataset.swsSrc) await withTimeout(loadClassicScript(script.dataset.swsSrc), options.timeoutMs, "Dependency script");
      else {
        const executable = document.createElement("script");
        executable.nonce = options.nonce;
        executable.textContent = script.textContent;
        document.body.append(executable);
      }
    }
    await withTimeout(loadClassicScript(options.widgetScriptUrl), options.timeoutMs, "Widget script");
    window.dispatchEvent(
      new CustomEvent("onWidgetLoad", {
        detail: {
          fieldData: structuredClone(runtimeState.fieldData),
          channel: structuredClone(runtimeState.channel),
          recents: structuredClone(runtimeState.recents)
        }
      })
    );
    send("frame:widget-load-dispatched");
    if (adapter.afterLoad) await adapter.afterLoad({state: runtimeState});
    await withTimeout(waitForLoadedAssets(), options.timeoutMs, "Asset readiness");
    send("frame:assets-ready");
    if (options.readySelector) await waitForSelector(options.readySelector, options.timeoutMs);
    send("frame:widget-ready");
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || event.origin !== options.parentOrigin || !isEnvelope(event.data)) return;
    const envelope = event.data;
    if (envelope.sessionId !== options.sessionId || envelope.nonce !== options.nonce) return;
    void (async () => {
      try {
        switch (envelope.type) {
          case "host:init":
            await initialize(
              (envelope.payload as {state: RuntimeState}).state,
              (envelope.payload as {clockManaged?: boolean}).clockManaged === true
            );
            break;
          case "host:emit": {
            const payload = envelope.payload as {listener: string; event: JsonValue; requestId?: string};
            await emit(payload.listener, payload.event, payload.requestId);
            break;
          }
          case "host:update-fields": {
            if (!runtimeState) throw new Error("Widget frame is not initialized.");
            const payload = envelope.payload as {fieldData: JsonObject; requestId?: string};
            runtimeState.fieldData = {...runtimeState.fieldData, ...mapAssets(structuredClone(payload.fieldData))};
            window.dispatchEvent(
              new CustomEvent("onWidgetUpdate", {detail: {fieldData: structuredClone(runtimeState.fieldData)}})
            );
            send("frame:fields-updated", {requestId: payload.requestId});
            break;
          }
          case "host:ping":
            send("frame:pong");
            break;
          default:
            throw new Error(`Unknown bridge command: ${envelope.type}`);
        }
      } catch (error) {
        const requestId = (envelope.payload as {requestId?: unknown} | undefined)?.requestId;
        send("frame:error", {
          message: error instanceof Error ? error.message : String(error),
          ...(typeof requestId === "string" ? {requestId} : {})
        });
      }
    })();
  });

  send("frame:booted");
}
