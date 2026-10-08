import type {FontFallbackReason, FontReport, FontReportEntry, JsonObject, JsonValue, RuntimeState} from "../types.js";
import {BRIDGE_PROTOCOL, BRIDGE_VERSION} from "../version.js";
import {canonicalGoogleFontsUrl, familiesFromUrl, isGoogleFontsHost} from "./google-fonts-url.js";

declare global {
  interface Window {
    SE_API: unknown;
    __SE_WIDGET_STUDIO__: {
      getState: () => RuntimeState | null;
      emit: (listener: string, event: JsonValue) => void;
      settle: () => Promise<FontReport>;
      /** What a settle is waiting for right now; captures read it to explain FONT_SETTLE_TIMEOUT. */
      fontState: () => FontWaitState;
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
  /** Absolute base such as `http://127.0.0.1:1234/__sws/sample/`; sample references map below it. */
  sampleMediaBaseUrl?: string;
  /**
   * Hosted editor preview: Google Fonts stylesheets a widget links at runtime are held back, resolved
   * by the editor through `frame:font-request`, and applied as `data:` CSS. Captures never set it.
   */
  fontBroker?: boolean;
}

/**
 * Mirrors SAMPLE_REFERENCE_PATTERN in studio-ui/sample-media.ts. The runtime is served on its own,
 * so it cannot import that module; a unit test keeps both sources identical.
 */
export const FRAME_SAMPLE_REFERENCE_PATTERN = /^sws-sample:([a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*\.(?:jpg|png|webp|gif|webm))$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Replaces exact asset strings, and sample references when a base URL is configured, inside
 * arrays and plain objects. Anything else, including Date or Map instances from adapters, is
 * returned by identity, and unchanged containers keep their identity.
 */
export function mapRuntimeAssets<T>(value: T, assetMap?: Record<string, string>, sampleMediaBaseUrl?: string): T {
  if (!assetMap && !sampleMediaBaseUrl) return value;
  const rewrite = (input: unknown): unknown => {
    if (typeof input === "string") {
      if (assetMap && Object.hasOwn(assetMap, input)) return assetMap[input];
      if (sampleMediaBaseUrl) {
        const file = FRAME_SAMPLE_REFERENCE_PATTERN.exec(input)?.[1];
        if (file) return `${sampleMediaBaseUrl}${file}`;
      }
      return input;
    }
    if (Array.isArray(input)) {
      let changed = false;
      const next = input.map((item) => {
        const mapped = rewrite(item);
        if (mapped !== item) changed = true;
        return mapped;
      });
      return changed ? next : input;
    }
    if (isPlainObject(input)) {
      let changed = false;
      const entries = Object.entries(input).map(([key, item]) => {
        const mapped = rewrite(item);
        if (mapped !== item) changed = true;
        return [key, mapped] as const;
      });
      return changed ? Object.fromEntries(entries) : input;
    }
    return input;
  };
  return rewrite(value) as T;
}

/** The editor preview's font wait, below the default 10 s readiness timeout. */
const PREVIEW_FONT_BUDGET_MS = 6_000;

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
  // JSON.stringify turns an Error into "{}", which would drop a rejection's message.
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value) ?? String(value);
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

// ---------------------------------------------------------------------------------------------
// Stylesheet and font readiness.
//
// Native accessors are saved when this module is evaluated, before any widget code runs and
// before any shim replaces them (the preview broker planned for Google Fonts patches `href`).
// Nothing here yields through timers or requestAnimationFrame: captures pause the clock, so
// waits use MessageChannel tasks, which the virtual clock does not control.
// ---------------------------------------------------------------------------------------------

function nativeGetter<Receiver, Value>(prototype: object | undefined, property: string): ((this: Receiver) => Value) | undefined {
  if (!prototype) return undefined;
  return Object.getOwnPropertyDescriptor(prototype, property)?.get as ((this: Receiver) => Value) | undefined;
}

const nativeLinkHref = nativeGetter<HTMLLinkElement, string>(
  typeof HTMLLinkElement === "undefined" ? undefined : HTMLLinkElement.prototype,
  "href"
);
const nativeLinkSheet = nativeGetter<HTMLLinkElement, CSSStyleSheet | null>(
  typeof HTMLLinkElement === "undefined" ? undefined : HTMLLinkElement.prototype,
  "sheet"
);
const nativeSheetHref = nativeGetter<StyleSheet, string | null>(
  typeof StyleSheet === "undefined" ? undefined : StyleSheet.prototype,
  "href"
);
const NativeMessageChannel = typeof MessageChannel === "undefined" ? undefined : MessageChannel;
const nativeGetAttribute = typeof Element === "undefined" ? undefined : Element.prototype.getAttribute;
const hrefAttribute = (link: HTMLLinkElement): string | null => (nativeGetAttribute ? nativeGetAttribute.call(link, "href") : link.getAttribute("href"));

const linkHref = (link: HTMLLinkElement): string => (nativeLinkHref ? nativeLinkHref.call(link) : link.href);
const linkSheet = (link: HTMLLinkElement): CSSStyleSheet | null => (nativeLinkSheet ? nativeLinkSheet.call(link) : link.sheet);
const sheetHref = (sheet: StyleSheet): string | null => (nativeSheetHref ? nativeSheetHref.call(sheet) : sheet.href);

/** Resolves on the next task, outside the virtual clock. */
function nextTask(): Promise<void> {
  if (!NativeMessageChannel) return Promise.resolve();
  return new Promise((resolve) => {
    const channel = new NativeMessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

function isGoogleFontsUrl(href: string): boolean {
  try {
    return isGoogleFontsHost(new URL(href, document.baseURI).hostname);
  } catch {
    return false;
  }
}

interface StylesheetLoad {
  href: string;
  promise: Promise<void>;
  /** Ends the wait as if the element fired `load` or `error`; `superseded` when a newer href replaces it. */
  settle: (outcome: "load" | "error" | "superseded") => void;
  /** A Google Fonts stylesheet the preview broker holds back until the editor answers. */
  broker?: BrokeredLink;
  /** The wait has not ended yet; ended waits stay in the map, so a timeout names only these. */
  pending: boolean;
}

/**
 * A `<link>` whose Google Fonts `href` the preview broker took over. `raw` is what the widget wrote
 * (returned by `getAttribute`), `original` its absolute form (returned by `href` and used in the font
 * report), `dataUrl` the CSS actually applied through the native setter.
 */
interface BrokeredLink {
  raw: string;
  original: string;
  url: string;
  state: "pending" | "applied" | "failed";
  dataUrl?: string;
}
const brokeredLinks = new WeakMap<HTMLLinkElement, BrokeredLink>();

interface FontBroker {
  /** Takes over a Google Fonts stylesheet the widget linked without the shimmed setters (parser, `innerHTML`). */
  adopt: (link: HTMLLinkElement, raw: string) => boolean;
  /** Asks for the subsets that cover text outside what a partial stylesheet already covers; undefined when none. */
  topUp: (wanted: Map<string, WantedFace>) => Promise<void> | undefined;
  receive: (payload: unknown) => void;
}
let fontBroker: FontBroker | undefined;

/** The href the font report uses for a link: the widget's Google URL when the broker applied it as data: CSS. */
function reportedHref(link: HTMLLinkElement, href: string): string {
  const entry = brokeredLinks.get(link);
  return entry && entry.dataUrl === href ? entry.original : href;
}

const stylesheetLoads = new Map<HTMLLinkElement, StylesheetLoad>();

function addStylesheetLoad(link: HTMLLinkElement, load: Omit<StylesheetLoad, "pending">): void {
  const entry: StylesheetLoad = {...load, pending: true};
  const ended = () => {
    entry.pending = false;
  };
  entry.promise.then(ended, ended);
  stylesheetLoads.set(link, entry);
}

/*
 * StreamElements session data: what the Session Dashboard shows, delivered to a custom widget as
 * `obj.detail.session.data` in onWidgetLoad and as `obj.detail.session` in onSessionUpdate. Keys and
 * fields follow the Session Data Reference (https://docs.streamelements.com/overlays/session-data,
 * Twitch and common keys, read 2026-10-07). The reference does not say how an event changes the
 * data; the rules in SessionTracker.apply are the Studio's reading of it, listed in docs/RUNTIME.md.
 */

/** How many entries a `*-recent` list keeps; the newest comes first. */
export const SESSION_RECENT_LIMIT = 25;

const SESSION_PERIODS = ["session", "week", "month", "total"] as const;
const TOP_PERIODS = ["session", "weekly", "monthly", "alltime"] as const;

/** Every documented Twitch and common key, empty: names "", counts and amounts 0, lists []. */
export function defaultSessionData(): JsonObject {
  const latest = {name: "", amount: 0, message: ""};
  const data: JsonObject = {
    "follower-latest": {name: ""},
    "follower-goal": {amount: 0},
    "follower-recent": [],
    "subscriber-latest": {name: "", amount: 0, tier: "1000", message: "", sender: "", gifted: false},
    "subscriber-new-latest": {...latest},
    "subscriber-resub-latest": {...latest},
    "subscriber-new-session": {count: 0},
    "subscriber-resub-session": {count: 0},
    "subscriber-goal": {amount: 0},
    "subscriber-gifted-latest": {name: "", amount: 0},
    "subscriber-alltime-gifter": {name: "", amount: 0},
    "subscriber-gifted-session": {count: 0},
    "subscriber-points": {amount: 0},
    "subscriber-recent": [],
    "host-latest": {name: "", amount: 0},
    "host-recent": [],
    "raid-latest": {name: "", amount: 0},
    "raid-recent": [],
    "cheer-latest": {...latest},
    "cheer-count": {count: 0},
    "cheer-goal": {amount: 0},
    "cheer-recent": [],
    "tip-latest": {...latest},
    "tip-count": {count: 0},
    "tip-goal": {amount: 0},
    "tip-recent": [],
    "merch-latest": {name: "", amount: 0, items: []},
    "merch-goal-items": {amount: 0},
    "merch-goal-orders": {amount: 0},
    "merch-goal-total": {amount: 0},
    "merch-recent": []
  };
  for (const period of SESSION_PERIODS) {
    data[`follower-${period}`] = {count: 0};
    data[`subscriber-${period}`] = {count: 0};
    data[`cheer-${period}`] = {amount: 0};
    data[`tip-${period}`] = {amount: 0};
  }
  for (const kind of ["tip", "cheer"]) {
    for (const period of TOP_PERIODS) {
      data[`${kind}-${period}-top-donation`] = {name: "", amount: 0};
      data[`${kind}-${period}-top-donator`] = {name: "", amount: 0};
    }
  }
  return data;
}

function sessionNumber(value: unknown): number {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : 0;
}

function sessionText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * The session data of one widget frame. It starts from the defaults with the scene's `session`
 * merged key by key, and `apply` changes it for each event the Session Dashboard counts.
 */
export class SessionTracker {
  readonly data: JsonObject;
  /** Per tip and cheer period: each name's sum so far, seeded with the period's top donator. */
  readonly #donators = new Map<string, Map<string, number>>();

  constructor(initial: JsonObject = {}) {
    this.data = defaultSessionData();
    for (const [key, value] of Object.entries(initial)) {
      const base = this.data[key];
      this.data[key] = isPlainObject(base) && isPlainObject(value) ? {...base, ...structuredClone(value)} as JsonObject : structuredClone(value);
    }
    for (const kind of ["tip", "cheer"]) {
      for (const period of TOP_PERIODS) {
        const top = this.#entry(`${kind}-${period}-top-donator`);
        const sums = new Map<string, number>();
        if (sessionText(top.name)) sums.set(sessionText(top.name), sessionNumber(top.amount));
        this.#donators.set(`${kind}-${period}`, sums);
      }
    }
  }

  #entry(key: string): JsonObject {
    const value = this.data[key];
    if (isPlainObject(value)) return value as JsonObject;
    const replaced: JsonObject = {};
    this.data[key] = replaced;
    return replaced;
  }

  #add(key: string, field: "count" | "amount", by: number): void {
    const entry = this.#entry(key);
    entry[field] = sessionNumber(entry[field]) + by;
  }

  #recent(key: string, item: JsonObject): void {
    const list = Array.isArray(this.data[key]) ? (this.data[key] as JsonValue[]) : [];
    this.data[key] = [item, ...list].slice(0, SESSION_RECENT_LIMIT);
  }

  /** Tips and cheers: totals, count, goal, the biggest single one, and the biggest sum per name, in every period. */
  #donation(kind: "tip" | "cheer", name: string, amount: number, message: string, createdAt: string): void {
    this.data[`${kind}-latest`] = {name, amount, message};
    for (const period of SESSION_PERIODS) this.#add(`${kind}-${period}`, "amount", amount);
    this.#add(`${kind}-count`, "count", 1);
    this.#add(`${kind}-goal`, "amount", amount);
    for (const period of TOP_PERIODS) {
      const donation = this.#entry(`${kind}-${period}-top-donation`);
      if (amount > sessionNumber(donation.amount)) this.data[`${kind}-${period}-top-donation`] = {name, amount};
      const sums = this.#donators.get(`${kind}-${period}`)!;
      const sum = (sums.get(name) ?? 0) + amount;
      sums.set(name, sum);
      if (sum > sessionNumber(this.#entry(`${kind}-${period}-top-donator`).amount)) this.data[`${kind}-${period}-top-donator`] = {name, amount: sum};
    }
    this.#recent(`${kind}-recent`, {name, amount, createdAt, type: kind});
  }

  /**
   * Changes the data for an event; returns false, with the data unchanged, for a listener the
   * Session Dashboard does not count (chat messages, redemptions, widget buttons, and others).
   */
  apply(listener: string, event: unknown, createdAt: string): boolean {
    const payload = isPlainObject(event) ? event : {};
    const name = sessionText(payload.name);
    const amount = sessionNumber(payload.amount);
    const message = sessionText(payload.message);
    switch (listener) {
      case "follower-latest":
        this.data["follower-latest"] = {name};
        for (const period of SESSION_PERIODS) this.#add(`follower-${period}`, "count", 1);
        this.#add("follower-goal", "amount", 1);
        this.#recent("follower-recent", {name, createdAt, type: "follower"});
        return true;
      case "subscriber-latest": {
        const tier = sessionText(payload.tier) || "1000";
        const sender = sessionText(payload.sender);
        if (payload.bulkGifted === true) {
          // A community gift announces the gifts; each gifted sub then arrives as its own event.
          this.data["subscriber-gifted-latest"] = {name: sender || name, amount};
          return true;
        }
        const gifted = payload.gifted === true;
        this.data["subscriber-latest"] = {name, amount, tier, message, sender, gifted};
        for (const period of SESSION_PERIODS) this.#add(`subscriber-${period}`, "count", 1);
        this.#add("subscriber-goal", "amount", 1);
        const kind = amount > 1 ? "resub" : "new";
        this.data[`subscriber-${kind}-latest`] = {name, amount, message};
        this.#add(`subscriber-${kind}-session`, "count", 1);
        if (gifted) {
          this.data["subscriber-gifted-latest"] = {name: sender, amount: 1};
          this.#add("subscriber-gifted-session", "count", 1);
        }
        this.#recent("subscriber-recent", {name, amount, tier, createdAt, type: "subscriber"});
        return true;
      }
      case "tip-latest":
        this.#donation("tip", name, amount, message, createdAt);
        return true;
      case "cheer-latest":
        this.#donation("cheer", name, amount, message, createdAt);
        return true;
      case "raid-latest":
      case "host-latest": {
        const kind = listener.slice(0, -"-latest".length);
        this.data[listener] = {name, amount};
        this.#recent(`${kind}-recent`, {name, amount, createdAt, type: kind});
        return true;
      }
      case "merch-latest": {
        const items = Array.isArray(payload.items) ? structuredClone(payload.items as JsonValue[]) : [];
        this.data["merch-latest"] = {name, amount, items};
        this.#add("merch-goal-orders", "amount", 1);
        this.#add("merch-goal-items", "amount", items.reduce<number>((sum, item) => sum + (isPlainObject(item) ? sessionNumber(item.quantity) : 0), 0));
        this.#add("merch-goal-total", "amount", amount);
        this.#recent("merch-recent", {name, amount, createdAt, type: "merch"});
        return true;
      }
      default:
        return false;
    }
  }
}

/** A snapshot of what settle() waits on, for timeout messages. */
export interface FontWaitState {
  phase: string;
  pendingStylesheets: string[];
  fontsStatus: string;
  loadingFaces: string[];
  /** The faces of `document.fonts` by status. */
  faces: Record<FontFaceLoadStatus, number>;
}
let settlePhase = "idle";

export function fontWaitState(): FontWaitState {
  const loadingFaces: string[] = [];
  const faces: Record<FontFaceLoadStatus, number> = {unloaded: 0, loading: 0, loaded: 0, error: 0};
  if (document.fonts) {
    for (const face of document.fonts) {
      faces[face.status] += 1;
      if (face.status === "loading" && loadingFaces.length < 20) loadingFaces.push(`${unquoteFamily(face.family)} ${face.weight} ${face.style}`);
    }
  }
  return {
    phase: settlePhase,
    pendingStylesheets: Array.from(stylesheetLoads.values())
      .filter((load) => load.pending)
      .map((load) => load.href)
      .slice(0, 20),
    fontsStatus: document.fonts?.status ?? "unsupported",
    loadingFaces,
    faces
  };
}

/**
 * Resource Timing entries seen per URL. A Google Fonts stylesheet whose fetch has finished but whose
 * element never fires `load` or `error` (engines differ on 4xx and non-CSS answers under request
 * interception) must not hold settle() forever: a few tasks after its entry, the wait ends as
 * `settled`, and the capture's request log decides whether it failed, as for a static link.
 */
/** Resource Timing entries seen per URL: each finished fetch adds one. */
const finishedFetches = new Map<string, number>();
const fetchWaiters = new Map<string, Set<{after: number; wake: () => void}>>();
const FETCH_EVENT_GRACE_TASKS = 64;

function watchFinishedFetches(): void {
  if (typeof PerformanceObserver === "undefined") return;
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const count = (finishedFetches.get(entry.name) ?? 0) + 1;
        finishedFetches.set(entry.name, count);
        for (const waiter of Array.from(fetchWaiters.get(entry.name) ?? [])) {
          if (count <= waiter.after) continue;
          fetchWaiters.get(entry.name)?.delete(waiter);
          waiter.wake();
        }
      }
    }).observe({type: "resource", buffered: true});
  } catch {
    // No Resource Timing: element events only.
  }
}

/** Calls `wake` once a fetch of `href` that finishes after this call is recorded (a new one, not an earlier fetch of the same URL). */
function whenFetchFinished(href: string, wake: () => void): () => void {
  let waiters = fetchWaiters.get(href);
  if (!waiters) fetchWaiters.set(href, (waiters = new Set()));
  const waiter = {after: finishedFetches.get(href) ?? 0, wake};
  waiters.add(waiter);
  return () => waiters!.delete(waiter);
}
/**
 * Every Google Fonts stylesheet the frame has seen, and how it ended. `settled`: it finished before
 * the runtime watched it, with an outcome the frame cannot read (Chromium gives failed and
 * cross-origin links the same opaque sheet).
 */
const googleStylesheets = new Map<string, {state: "pending" | "settled" | "loaded" | "failed"; reason?: FontFallbackReason}>();
/** A synthetic event for a re-assigned href, and whether it was already dispatched. */
const syntheticLoads = new WeakMap<HTMLLinkElement, {href: string; type: "load" | "error"; dispatched: boolean}>();
/** The last native `load` or `error` of each link, and for which href. */
const linkOutcomes = new WeakMap<HTMLLinkElement, {href: string; type: "load" | "error"}>();
const fontIssues: string[] = [];
let watchingStylesheets = false;

function noteFontIssue(message: string): void {
  if (fontIssues.length < 20 && !fontIssues.includes(message)) fontIssues.push(message);
}

function markGoogleStylesheet(href: string, state: "pending" | "settled" | "loaded" | "failed", reason?: FontFallbackReason): void {
  if (!isGoogleFontsUrl(href)) return;
  const known = googleStylesheets.get(href);
  if (state === "pending" && known && known.state !== "pending") return;
  googleStylesheets.set(href, reason ? {state, reason} : {state});
}

function isStylesheetLink(node: Node): node is HTMLLinkElement {
  return (
    node instanceof HTMLLinkElement &&
    /(?:^|\s)stylesheet(?:\s|$)/i.test(node.rel) &&
    Boolean(hrefAttribute(node)) &&
    !node.disabled &&
    (!node.type || /^text\/css$/i.test(node.type))
  );
}

/**
 * Re-assigning the URL of the sheet that is already applied fires `load` in a plain browser, but
 * not under request interception (Playwright routes). The runtime dispatches one synthetic event
 * (the link's last outcome for that href, `load` when unknown) in a later task instead, and
 * `dedupeNativeLoad` drops a native one that arrives afterwards, so the widget sees exactly one
 * event either way.
 */
function queueSyntheticLoad(link: HTMLLinkElement, href: string): void {
  const last = linkOutcomes.get(link);
  const entry = {href, type: last?.href === href ? last.type : ("load" as const), dispatched: false};
  syntheticLoads.set(link, entry);
  void nextTask().then(() => {
    if (syntheticLoads.get(link) !== entry) return;
    entry.dispatched = true;
    link.dispatchEvent(new Event(entry.type));
  });
}

function dedupeNativeLoad(event: Event): void {
  const link = event.target;
  if (!event.isTrusted || !(link instanceof HTMLLinkElement)) return;
  const href = linkHref(link);
  linkOutcomes.set(link, {href, type: event.type === "error" ? "error" : "load"});
  const entry = syntheticLoads.get(link);
  if (!entry) return;
  syntheticLoads.delete(link);
  // A native event before the synthetic one cancels it; one after it is the duplicate.
  if (entry.dispatched && entry.href === href) event.stopImmediatePropagation();
}

function forgetStylesheet(link: HTMLLinkElement): void {
  stylesheetLoads.get(link)?.settle("superseded");
  stylesheetLoads.delete(link);
}

// A replaced href keeps the previous sheet until the new one loads, so `link.sheet` cannot reveal a
// pending swap (for example a widget switching Google Fonts at runtime). Track each swap until its
// load or error event instead; a newer href supersedes an older pending one on the same element.
function trackStylesheet(link: HTMLLinkElement, reassigned = false): void {
  syntheticLoads.delete(link);
  const brokered = brokeredLinks.get(link);
  if (brokered?.state === "pending") {
    if (link.isConnected && isStylesheetRel(link)) holdForBroker(link, brokered);
    else forgetStylesheet(link);
    return;
  }
  if (!isStylesheetLink(link)) {
    forgetStylesheet(link);
    return;
  }
  // A Google Fonts link the parser or `innerHTML` created: the page CSP refuses it first, then the
  // broker loads it through the editor.
  if (fontBroker && !brokered) {
    const raw = hrefAttribute(link);
    if (raw && fontBroker.adopt(link, raw)) return;
  }
  stylesheetLoads.get(link)?.settle("superseded");
  const href = linkHref(link);
  const reported = reportedHref(link, href);
  const sheet = linkSheet(link);
  // Only a re-assignment can leave the current sheet in place: an inserted link always loads, and
  // Chromium attaches a sheet with the link's href at once, even to one that is about to fail.
  if (reassigned && sheet && sheetHref(sheet) === href) {
    stylesheetLoads.delete(link);
    if (reassigned) queueSyntheticLoad(link, href);
    return;
  }
  markGoogleStylesheet(reported, "pending");
  let settle: StylesheetLoad["settle"] = () => undefined;
  const promise = new Promise<void>((resolve, reject) => {
    let stopWatchingFetch = () => undefined as void;
    let finished = false;
    const cleanup = () => {
      finished = true;
      stopWatchingFetch();
      link.removeEventListener("load", loaded);
      link.removeEventListener("error", failed);
    };
    const finish = (outcome: "load" | "error" | "superseded" | "settled") => {
      if (finished) return;
      cleanup();
      if (outcome === "settled") {
        markGoogleStylesheet(reported, "settled");
        resolve();
        return;
      }
      if (outcome === "error") {
        // A Google Fonts stylesheet that fails leaves its families in fallback, which settle() reports.
        if (isGoogleFontsUrl(reported)) {
          markGoogleStylesheet(reported, "failed", "stylesheet-blocked");
          resolve();
        } else {
          reject(new Error(`Stylesheet failed to load: ${href}`));
        }
        return;
      }
      if (outcome === "load") markGoogleStylesheet(reported, "loaded");
      resolve();
    };
    const loaded = () => {
      // A late load event can belong to a superseded href (its sheet is still the old one); keep
      // waiting for the current one. A load without any sheet has nothing older to belong to.
      const current = linkSheet(link);
      if (current && sheetHref(current) !== href) return;
      finish("load");
    };
    const failed = () => finish("error");
    settle = finish;
    link.addEventListener("load", loaded);
    link.addEventListener("error", failed);
    if (isGoogleFontsUrl(href)) {
      stopWatchingFetch = whenFetchFinished(href, () => {
        void (async () => {
          for (let task = 0; task < FETCH_EVENT_GRACE_TASKS && !finished; task += 1) await nextTask();
          finish("settled");
        })();
      });
    }
  });
  promise.catch(() => undefined);
  addStylesheetLoad(link, {href, promise, settle});
}

function isStylesheetRel(link: HTMLLinkElement): boolean {
  return /(?:^|\s)stylesheet(?:\s|$)/i.test(link.rel);
}

/** Makes settle() wait for a stylesheet the broker holds back; the applied data: CSS supersedes it. */
function holdForBroker(link: HTMLLinkElement, entry: BrokeredLink): void {
  const existing = stylesheetLoads.get(link);
  if (existing?.broker === entry) return;
  existing?.settle("superseded");
  markGoogleStylesheet(entry.original, "pending");
  let settle: StylesheetLoad["settle"] = () => undefined;
  const promise = new Promise<void>((resolve) => {
    settle = () => resolve();
  });
  addStylesheetLoad(link, {href: entry.original, promise, settle, broker: entry});
}

function releaseBrokerHold(link: HTMLLinkElement, entry: BrokeredLink): void {
  const existing = stylesheetLoads.get(link);
  if (existing?.broker !== entry) return;
  existing.settle("superseded");
  stylesheetLoads.delete(link);
}

/**
 * Ends the tracked wait for `link` from outside its own events, for a runtime that loads the sheet
 * on the widget's behalf (the Google Fonts preview broker).
 */
export function settleTrackedStylesheet(link: HTMLLinkElement, outcome: "load" | "error"): void {
  stylesheetLoads.get(link)?.settle(outcome);
}

export function watchStylesheets(): void {
  if (watchingStylesheets) return;
  watchingStylesheets = true;
  watchFinishedFetches();
  document.addEventListener("load", dedupeNativeLoad, true);
  document.addEventListener("error", dedupeNativeLoad, true);
  watchFontErrors();
  for (const link of Array.from(document.querySelectorAll("link"))) {
    if (brokeredLinks.get(link)?.state === "pending") continue;
    if (!isStylesheetLink(link)) continue;
    // Parser-inserted stylesheets whose media matches block module scripts, and this runtime runs as
    // a module after them, so they have finished; whether they failed is not readable here (the
    // capture's request log has it). A link that did not block scripts may still be loading.
    if (!link.media || matchMedia(link.media).matches) markGoogleStylesheet(reportedHref(link, linkHref(link)), "settled");
    else trackStylesheet(link);
  }
  const linksIn = (node: Node): HTMLLinkElement[] =>
    node instanceof HTMLLinkElement ? [node] : node instanceof Element ? Array.from(node.querySelectorAll("link")) : [];
  new MutationObserver((records) => {
    const inserted = new Set(records.flatMap((record) => Array.from(record.addedNodes).flatMap(linksIn)));
    for (const record of records) {
      if (record.type === "attributes" && record.target instanceof HTMLLinkElement) trackStylesheet(record.target, !inserted.has(record.target));
      for (const node of Array.from(record.removedNodes)) {
        if (node instanceof HTMLLinkElement) forgetStylesheet(node);
        else if (node instanceof Element) for (const link of Array.from(node.querySelectorAll("link"))) forgetStylesheet(link);
      }
      for (const node of Array.from(record.addedNodes)) {
        if (node instanceof HTMLLinkElement) trackStylesheet(node);
        else if (node instanceof Element) for (const link of Array.from(node.querySelectorAll("link"))) trackStylesheet(link);
      }
    }
  }).observe(document.documentElement, {subtree: true, childList: true, attributes: true, attributeFilter: ["href", "rel"]});
}

export async function waitForStylesheets(): Promise<void> {
  let awaited: Promise<void>[] = [];
  do {
    awaited = Array.from(stylesheetLoads.values(), (load) => load.promise);
    await Promise.all(awaited);
  } while (Array.from(stylesheetLoads.values()).some((load) => !awaited.includes(load.promise)));
}

function forceLayout(): void {
  // Web fonts from a just-loaded sheet only start loading once layout uses them.
  void document.body?.offsetHeight;
}

type PostTask = (callback: () => void, options: {delay: number}) => Promise<void>;
// The capture clock fakes timers, requestAnimationFrame, performance and Event.timeStamp, but not
// scheduler.postTask: its delay is the frame's only real-time wait.
const nativePostTask = ((): PostTask | undefined => {
  const scheduler = (globalThis as {scheduler?: {postTask?: PostTask}}).scheduler;
  return scheduler?.postTask ? scheduler.postTask.bind(scheduler) : undefined;
})();

/** Waits `ms` of real time, or one task where the browser has no scheduler.postTask. */
function realTimeDelay(ms: number): Promise<void> {
  if (!nativePostTask) return nextTask();
  return nativePostTask(() => undefined, {delay: ms}).catch(() => undefined);
}

/** Real time the browser gets to resolve document.fonts.ready by itself once no face is loading. */
const READY_GRACE_MS = 250;
/** Layouts settle() forces before it stops waiting for a document.fonts.ready that nothing is left to resolve. */
const READY_FORCED_LAYOUTS = 2;
/** How the current settle got past document.fonts.ready when the browser did not resolve it by itself. */
let readyStall: FontReport["readyStall"];

/**
 * `document.fonts.ready`, also in a frame the browser does not render. Chrome resolves it only after a
 * layout that follows the last font load, which such a frame never runs by itself; its status stays
 * "loading" with no face loading. Once no face is loading and the grace has passed, force the
 * layout; after a few, stop waiting, since nothing is left to load.
 */
async function fontsReady(): Promise<void> {
  const fonts = document.fonts;
  if (!fonts) return;
  let resolved = false;
  const ready = fonts.ready.then(() => {
    resolved = true;
  });
  let forced = 0;
  for (;;) {
    await Promise.race([ready, nextTask()]);
    if (resolved) break;
    const loading = Array.from(fonts).filter((face) => face.status === "loading");
    if (loading.length > 0) {
      await Promise.race([ready, Promise.allSettled(loading.map((face) => face.loaded))]);
      continue;
    }
    await Promise.race([ready, realTimeDelay(READY_GRACE_MS)]);
    if (resolved) break;
    if (forced === READY_FORCED_LAYOUTS) {
      readyStall = "abandoned";
      return;
    }
    forceLayout();
    forced += 1;
  }
  if (forced > 0 && readyStall !== "abandoned") readyStall = "forced";
}

const MAX_SAMPLE_CHARACTERS = 200;
const MAX_TEXT_NODES = 2000;
const MAX_REPORTED_FACES = 64;
const DEFAULT_SAMPLE_TEXT = "BESbswy";
const GENERIC_FAMILIES = new Set([
  "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif",
  "ui-monospace", "ui-rounded", "math", "emoji", "fangsong", "inherit", "initial", "unset", "revert"
]);

function mergeSample(current: string, text: string): string {
  let merged = current;
  for (const character of text) {
    if (merged.length >= MAX_SAMPLE_CHARACTERS) break;
    if (character.trim() !== "" && !merged.includes(character)) merged += character;
  }
  return merged;
}

function unquoteFamily(name: string): string {
  const trimmed = name.trim();
  return /^(["']).*\1$/.test(trimmed) ? trimmed.slice(1, -1).replace(/\\(.)/g, "$1") : trimmed.replace(/\s+/g, " ");
}

function familyList(value: string): string[] {
  const families: string[] = [];
  let current = "";
  let quote = "";
  for (const character of value) {
    if (quote) {
      current += character;
      if (character === quote) quote = "";
    } else if (character === '"' || character === "'") {
      current += character;
      quote = character;
    } else if (character === ",") {
      families.push(unquoteFamily(current));
      current = "";
    } else {
      current += character;
    }
  }
  if (current.trim() !== "") families.push(unquoteFamily(current));
  return families.filter((family) => family !== "");
}

function normalizedWeight(value: string): string {
  if (value === "bold" || value === "bolder") return "700";
  if (value === "normal" || value === "lighter" || value === "") return "400";
  return /^\d+(?:\.\d+)?$/.test(value) ? String(Math.round(Number(value))) : "400";
}

function normalizedStyle(value: string): "normal" | "italic" {
  return /^(?:italic|oblique)/.test(value) ? "italic" : "normal";
}

/** Splits a canvas `ctx.font` value into its family list, weight and style. */
function parseCanvasFont(font: string): {families: string[]; weight: string; style: "normal" | "italic"} | undefined {
  const match = /^(.*?)(?:^|\s)(\d*\.?\d+)(?:px|pt|em|rem|%)(?:\/\S+)?\s+(.+)$/.exec(font.trim());
  if (!match) return undefined;
  const tokens = (match[1] ?? "").split(/\s+/).filter(Boolean);
  const weight = tokens.find((token) => /^(?:bold|bolder|lighter|\d{3})$/.test(token)) ?? "400";
  const style = tokens.some((token) => token === "italic" || token === "oblique") ? "italic" : "normal";
  return {families: familyList(match[3] ?? ""), weight: normalizedWeight(weight), style};
}

function quoteFamily(family: string): string {
  return `"${family.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function faceFont(family: string, weight: string, style: string): string {
  return `${style} ${weight} 16px ${quoteFamily(family)}`;
}

function declaredFaces(family: string): FontFace[] {
  const wanted = family.toLowerCase();
  const faces: FontFace[] = [];
  if (document.fonts) for (const face of document.fonts) if (unquoteFamily(face.family).toLowerCase() === wanted) faces.push(face);
  return faces;
}

function checkFont(font: string, text: string): boolean {
  try {
    return !document.fonts || document.fonts.check(font, text || DEFAULT_SAMPLE_TEXT);
  } catch {
    return true;
  }
}

/** Families requested by the Google Fonts stylesheets the frame has seen, with the URL of each. */
function googleFamilies(): Map<string, {name: string; url: string; variants: {weight: string; style: "normal" | "italic"}[]}> {
  const families = new Map<string, {name: string; url: string; variants: {weight: string; style: "normal" | "italic"}[]}>();
  for (const href of googleStylesheets.keys()) {
    for (const family of familiesFromUrl(href)) {
      const key = family.name.toLowerCase();
      if (families.has(key) || family.name === "") continue;
      families.set(key, {
        name: family.name,
        url: href,
        variants: family.variants.map((variant) => {
          const [low, high] = variant.weight;
          return {weight: String(low <= 400 && 400 <= high ? 400 : Math.round(low)), style: variant.italic ? "italic" : "normal"};
        })
      });
    }
  }
  return families;
}

let webFamilyCache: {key: string; names: Set<string>} | undefined;

/** Lowercased names of every web font family: declared faces and Google Fonts URL families. */
function webFamilyNames(): Set<string> {
  const key = `${document.fonts?.size ?? 0}|${googleStylesheets.size}`;
  if (webFamilyCache?.key === key) return webFamilyCache.names;
  const names = new Set<string>(googleFamilies().keys());
  if (document.fonts) for (const face of document.fonts) names.add(unquoteFamily(face.family).toLowerCase());
  webFamilyCache = {key, names};
  return names;
}

/** Google Fonts stylesheets pulled in through `@import` in readable sheets. */
function noteImportedGoogleStylesheets(): void {
  const visit = (sheet: CSSStyleSheet, depth: number) => {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      return;
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSImportRule)) continue;
      markGoogleStylesheet(new URL(rule.href, sheet.href ?? document.baseURI).href, "pending");
      if (rule.styleSheet && depth < 4) visit(rule.styleSheet, depth + 1);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) visit(sheet, 0);
}

/** Google Fonts stylesheets the document references now, through links and readable `@import`s. */
function referencedGoogleStylesheets(): string[] {
  const referenced = new Set<string>();
  const note = (href: string) => {
    if (isGoogleFontsUrl(href)) referenced.add(href);
  };
  for (const link of Array.from(document.querySelectorAll("link"))) {
    const brokered = brokeredLinks.get(link);
    if (brokered?.state === "pending" && link.isConnected && isStylesheetRel(link)) note(brokered.original);
    else if (isStylesheetLink(link)) note(reportedHref(link, linkHref(link)));
  }
  const visit = (sheet: CSSStyleSheet, depth: number) => {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      return;
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSImportRule)) continue;
      note(new URL(rule.href, sheet.href ?? document.baseURI).href);
      if (rule.styleSheet && depth < 4) visit(rule.styleSheet, depth + 1);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) visit(sheet, 0);
  return Array.from(referenced).sort();
}

interface CanvasFontUse {
  text: string;
  /** Once a web font face is ready for this font, draws stop checking. */
  ready: boolean;
  /** The last draw with this font happened before a web font face was ready for it. */
  staleDraw: boolean;
}

const canvasFonts = new Map<string, CanvasFontUse>();

/**
 * Whether the web font face behind a canvas `font` is ready for `text`; `undefined` when no family
 * in it is a known web font (yet: its stylesheet may still be on its way).
 */
function canvasWebFontReady(font: string, text: string): boolean | undefined {
  const parsed = parseCanvasFont(font);
  if (!parsed) return undefined;
  const known = webFamilyNames();
  const family = parsed.families.find((name) => !GENERIC_FAMILIES.has(name.toLowerCase()) && known.has(name.toLowerCase()));
  if (!family) return undefined;
  // A Google family whose stylesheet has not arrived has no faces, and check() would call it ready.
  if (declaredFaces(family).length === 0) return false;
  return checkFont(font, text);
}

function recordCanvasText(font: unknown, text: unknown, drawn: boolean): void {
  if (typeof font !== "string") return;
  let use = canvasFonts.get(font);
  if (!use) {
    if (canvasFonts.size >= 256) return;
    use = {text: "", ready: false, staleDraw: false};
    canvasFonts.set(font, use);
  }
  use.text = mergeSample(use.text, String(text));
  if (!drawn) return;
  if (!use.ready) use.ready = canvasWebFontReady(font, use.text) === true;
  use.staleDraw = !use.ready;
}

let canvasWrapped = false;

/** Records `(ctx.font, text)` for every canvas text call, so settle() can load those faces too. */
function wrapCanvasText(): void {
  if (canvasWrapped) return;
  canvasWrapped = true;
  const prototypes = [
    typeof CanvasRenderingContext2D === "undefined" ? undefined : CanvasRenderingContext2D.prototype,
    typeof OffscreenCanvasRenderingContext2D === "undefined" ? undefined : OffscreenCanvasRenderingContext2D.prototype
  ];
  for (const prototype of prototypes) {
    if (!prototype) continue;
    for (const name of ["fillText", "strokeText", "measureText"] as const) {
      const native = (prototype as unknown as Record<string, unknown>)[name];
      if (typeof native !== "function") continue;
      const drawn = name !== "measureText";
      Object.defineProperty(prototype, name, {
        configurable: true,
        writable: true,
        value: function (this: {font: string}, ...args: unknown[]) {
          try {
            recordCanvasText(this.font, args[0], drawn);
          } catch {
            // Recording never changes what the widget draws.
          }
          return Reflect.apply(native as (...values: unknown[]) => unknown, this, args);
        }
      });
    }
  }
}

interface WantedFace {
  family: string;
  weight: string;
  style: "normal" | "italic";
  text: string;
  sources: Set<"dom" | "canvas" | "google">;
  url?: string;
}

function collectWantedFaces(sampleText: string): Map<string, WantedFace> {
  noteImportedGoogleStylesheets();
  const google = googleFamilies();
  const known = webFamilyNames();
  const wanted = new Map<string, WantedFace>();
  const want = (families: string[], weight: string, style: "normal" | "italic", text: string, source: "dom" | "canvas" | "google") => {
    const family = families.find((name) => !GENERIC_FAMILIES.has(name.toLowerCase()) && known.has(name.toLowerCase()));
    if (!family || wanted.size >= MAX_REPORTED_FACES) return;
    const key = `${family.toLowerCase()}|${weight}|${style}`;
    const face = wanted.get(key) ?? {family, weight, style, text: "", sources: new Set()};
    face.text = mergeSample(face.text, text);
    face.sources.add(source);
    const url = google.get(family.toLowerCase())?.url;
    if (url) face.url = url;
    wanted.set(key, face);
  };
  const useStyle = (style: CSSStyleDeclaration, text: string) =>
    want(familyList(style.fontFamily), normalizedWeight(style.fontWeight), normalizedStyle(style.fontStyle), text, "dom");

  let budget = MAX_TEXT_NODES;
  const visit = (root: Node) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node && budget > 0; node = walker.nextNode()) {
      budget -= 1;
      if (node.nodeType === Node.TEXT_NODE) {
        const parent = node.parentElement;
        const text = (node as Text).data;
        if (parent && text.trim() !== "" && !/^(?:SCRIPT|STYLE|TEMPLATE|NOSCRIPT)$/.test(parent.tagName)) useStyle(getComputedStyle(parent), text);
        continue;
      }
      const element = node as Element;
      for (const pseudo of ["::before", "::after"]) {
        const style = getComputedStyle(element, pseudo);
        const content = style.content;
        if (!content || content === "none" || content === "normal") continue;
        const text = Array.from(content.matchAll(/"((?:[^"\\]|\\.)*)"/g), (match) => match[1] ?? "").join("");
        if (text.trim() !== "") useStyle(style, text);
      }
      if ((element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) && element.value.trim() !== "") {
        useStyle(getComputedStyle(element), element.value);
      }
      if (element.shadowRoot) visit(element.shadowRoot);
    }
  };
  if (document.documentElement) visit(document.documentElement);

  for (const [font, use] of canvasFonts) {
    const parsed = parseCanvasFont(font);
    if (parsed) want(parsed.families, parsed.weight, parsed.style, use.text, "canvas");
  }
  // Families a Google Fonts URL requests are loaded ahead of use: a canvas widget may draw them
  // in its next frame, after calling fonts.load before the stylesheet arrived.
  let domText = "";
  for (const face of wanted.values()) domText = mergeSample(domText, face.text);
  const text = mergeSample(mergeSample(sampleText, domText), DEFAULT_SAMPLE_TEXT);
  for (const family of google.values()) for (const variant of family.variants) want([family.name], variant.weight, variant.style, text, "google");
  return wanted;
}

async function loadWantedFace(face: WantedFace): Promise<void> {
  if (!document.fonts) return;
  try {
    await document.fonts.load(faceFont(face.family, face.weight, face.style), face.text || DEFAULT_SAMPLE_TEXT);
  } catch {
    // A failed face is reported from its status.
  }
}

function faceEntry(face: WantedFace, complete: boolean): FontReportEntry {
  const base = {
    family: face.family,
    weight: face.weight,
    style: face.style,
    sources: Array.from(face.sources).sort(),
    ...(face.url ? {url: face.url} : {})
  };
  const faces = declaredFaces(face.family);
  if (faces.length === 0) {
    const stylesheet = face.url ? googleStylesheets.get(face.url) : undefined;
    const reason: FontFallbackReason = stylesheet?.state === "pending" && !complete ? "timeout" : stylesheet?.reason ?? "stylesheet-blocked";
    return {...base, status: "fallback", reason};
  }
  const anyLoaded = faces.some((item) => item.status === "loaded");
  const anyError = faces.some((item) => item.status === "error");
  if (checkFont(faceFont(face.family, face.weight, face.style), face.text) && (anyLoaded || !anyError)) return {...base, status: "loaded"};
  return {...base, status: "fallback", reason: anyError ? "face-error" : "timeout"};
}

function fontReport(wanted: Map<string, WantedFace>, complete: boolean): FontReport {
  const families = Array.from(wanted.values(), (face) => faceEntry(face, complete)).sort((left, right) =>
    `${left.family}|${left.weight}|${left.style}`.localeCompare(`${right.family}|${right.weight}|${right.style}`)
  );
  let redrawNeeded = false;
  for (const [font, use] of canvasFonts) if (use.staleDraw && canvasWebFontReady(font, use.text) === true) redrawNeeded = true;
  const failedStylesheets = Array.from(googleStylesheets, ([href, state]) => ({href, state}))
    .filter(({state}) => state.state === "failed")
    .map(({href, state}) => ({href, reason: state.reason ?? "stylesheet-blocked"}));
  return {
    families,
    redrawNeeded,
    failedStylesheets,
    issues: [...fontIssues],
    referencedStylesheets: referencedGoogleStylesheets(),
    complete,
    ...(readyStall ? {readyStall} : {})
  };
}

export interface SettleOptions {
  /** Stylesheets, layout and `document.fonts.ready` only, without collecting families. */
  light?: boolean;
  /** Text to load Google Fonts families with, besides the text on the page (for example field values). */
  sampleText?: string;
  /** Real-time budget, for pages whose timers are real (the editor preview). Captures keep it in Node. */
  budgetMs?: number;
}

async function settleUntilQuiet(options: SettleOptions): Promise<FontReport> {
  let wanted = new Map<string, WantedFace>();
  readyStall = undefined;
  for (let round = 0; round < 8; round += 1) {
    const awaited = new Set(Array.from(stylesheetLoads.values(), (load) => load.promise));
    settlePhase = `round ${round + 1}: stylesheets`;
    await waitForStylesheets();
    forceLayout();
    settlePhase = `round ${round + 1}: document.fonts.ready`;
    await fontsReady();
    if (options.light) {
      settlePhase = "idle";
      return fontReport(wanted, true);
    }
    const previous = wanted.size;
    wanted = collectWantedFaces(options.sampleText ?? "");
    const topUp = fontBroker?.topUp(wanted);
    if (topUp) {
      settlePhase = `round ${round + 1}: Google Fonts subsets from the editor`;
      await topUp;
      forceLayout();
    }
    settlePhase = `round ${round + 1}: fonts.load (${Array.from(wanted.values(), (face) => `${face.family} ${face.weight} ${face.style}`).slice(0, 12).join(", ")})`;
    await Promise.all(Array.from(wanted.values(), loadWantedFace));
    await nextTask();
    forceLayout();
    settlePhase = `round ${round + 1}: document.fonts.ready after loads`;
    await fontsReady();
    const newStylesheet = Array.from(stylesheetLoads.values()).some((load) => !awaited.has(load.promise));
    // A face still loading, not document.fonts.status: that stays "loading" while ready waits for a layout.
    const fontsLoading = document.fonts ? Array.from(document.fonts).some((face) => face.status === "loading") : false;
    if (!newStylesheet && !fontsLoading && !topUp && round > 0 && wanted.size <= previous) break;
    if (!newStylesheet && !fontsLoading && !topUp && wanted.size === 0) break;
  }
  settlePhase = "idle";
  return fontReport(wanted, true);
}

/**
 * Waits until stylesheets, layout and fonts are quiet, loads every face the widget uses (DOM text,
 * canvas text and Google Fonts URLs), and reports each family as loaded or in fallback.
 */
export async function settle(options: SettleOptions = {}): Promise<FontReport> {
  const work = settleUntilQuiet(options);
  if (options.budgetMs === undefined) return work;
  let timer = 0;
  const expired = new Promise<"expired">((resolve) => {
    timer = window.setTimeout(() => resolve("expired"), options.budgetMs);
  });
  const result = await Promise.race([work, expired]).finally(() => window.clearTimeout(timer));
  if (result !== "expired") return result;
  work.catch(() => undefined);
  return fontReport(options.light ? new Map() : collectWantedFaces(options.sampleText ?? ""), false);
}

function watchFontErrors(): void {
  document.fonts?.addEventListener("loadingerror", (event) => {
    for (const face of (event as FontFaceSetLoadEvent).fontfaces) noteFontIssue(`Font face failed to load: ${unquoteFamily(face.family)} ${face.weight} ${face.style}`);
  });
  document.addEventListener("securitypolicyviolation", (event) => {
    const blocked = event.blockedURI;
    if (!isGoogleFontsUrl(blocked)) return;
    if (event.effectiveDirective.startsWith("style-src")) markGoogleStylesheet(blocked, "failed", "stylesheet-blocked");
    noteFontIssue(`Content security policy refused ${blocked} (${event.effectiveDirective}).`);
  });
}

async function waitForLoadedAssets(settleFonts: () => Promise<FontReport>): Promise<FontReport> {
  const report = await settleFonts();
  await (async () => {
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
  })();
  return report;
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


// ---------------------------------------------------------------------------------------------
// Google Fonts preview broker (hosted editor only).
//
// The preview iframe may not connect to Google (its CSP keeps `connect-src 'none'`), and the editor
// holds the API token, which never enters the iframe. So the runtime shims `href` and
// `setAttribute('href')` on links: a Google Fonts stylesheet URL is held back, the editor resolves it
// through the authenticated API, and the answer is applied as `data:` CSS through the native setter.
// The widget still reads its Google URL back. After a link's first answer the runtime never touches
// that link again: subsets for text that arrives later go into a runtime-owned `<style>`, so the
// widget's `load` handlers run once, as in StreamElements.
// ---------------------------------------------------------------------------------------------

type FontAnswer =
  | {status: "ok"; css: string; partial: boolean}
  | {status: "upstream-4xx" | "unavailable"; message: string};
type AppliedAnswer = {status: "ok"; dataUrl: string} | {status: "upstream-4xx" | "unavailable"; message: string};

/** How long the frame waits for the editor before treating a stylesheet as unavailable. */
const FONT_ANSWER_TIMEOUT_MS = 30_000;
const MAX_FONT_CSS_CHARACTERS = 2_000_000;

function coveredCharacters(text: string): Set<string> {
  const covered = new Set<string>();
  for (let code = 0x20; code <= 0x7e; code += 1) covered.add(String.fromCharCode(code));
  for (const character of text) covered.add(character);
  return covered;
}

function installFontBroker(send: (type: string, payload?: unknown) => void, sampleSource: () => string, afterAnswer: () => void): FontBroker | undefined {
  const prototype = typeof HTMLLinkElement === "undefined" ? undefined : HTMLLinkElement.prototype;
  const hrefDescriptor = prototype ? Object.getOwnPropertyDescriptor(prototype, "href") : undefined;
  if (!prototype || !hrefDescriptor?.get || !hrefDescriptor.set) return undefined;
  const nativeGet = hrefDescriptor.get;
  const nativeSet = hrefDescriptor.set;
  const nativeSetAttribute = Element.prototype.setAttribute;
  const nativeGetAttr = Element.prototype.getAttribute;
  const nativeRemoveAttribute = Element.prototype.removeAttribute;
  const pending = new Map<string, (answer: FontAnswer) => void>();
  const answers = new Map<string, Promise<AppliedAnswer>>();
  /** Partial stylesheets (canonical URL) and the characters their answers already cover. */
  const partialSheets = new Map<string, Set<string>>();
  let nextRequest = 0;

  const ask = (url: string, sampleText: string): Promise<FontAnswer> =>
    new Promise((resolve) => {
      nextRequest += 1;
      const requestId = `font-${nextRequest}`;
      const timer = window.setTimeout(() => {
        if (!pending.delete(requestId)) return;
        resolve({status: "unavailable", message: `The editor did not answer for ${url}.`});
      }, FONT_ANSWER_TIMEOUT_MS);
      pending.set(requestId, (answer) => {
        window.clearTimeout(timer);
        resolve(answer);
      });
      send("frame:font-request", {requestId, url, sampleText});
    });

  const pageSample = (): string => mergeSample(mergeSample("", sampleSource()), (document.body?.textContent ?? "").slice(0, 4000));

  const stylesheet = (url: string): Promise<AppliedAnswer> => {
    const known = answers.get(url);
    if (known) return known;
    const sample = pageSample();
    const answer = ask(url, sample).then((result): AppliedAnswer => {
      if (result.status !== "ok") return result;
      if (result.partial) partialSheets.set(url, coveredCharacters(sample));
      return {status: "ok", dataUrl: `data:text/css;charset=utf-8,${encodeURIComponent(result.css)}`};
    });
    answers.set(url, answer);
    return answer;
  };

  const apply = (link: HTMLLinkElement, entry: BrokeredLink, answer: AppliedAnswer): void => {
    if (brokeredLinks.get(link) !== entry || entry.state !== "pending") return;
    if (answer.status === "ok") {
      entry.state = "applied";
      entry.dataUrl = answer.dataUrl;
      // Without the stylesheet observer (not started yet, or a detached link) nothing supersedes the hold.
      if (!link.isConnected || !watchingStylesheets) releaseBrokerHold(link, entry);
      nativeSet.call(link, answer.dataUrl);
    } else {
      entry.state = "failed";
      releaseBrokerHold(link, entry);
      markGoogleStylesheet(entry.original, "failed", answer.status === "upstream-4xx" ? "upstream-4xx" : "not-in-cache");
      noteFontIssue(answer.message.slice(0, 300));
      // What a browser would fire for a stylesheet Google refused.
      link.dispatchEvent(new Event("error"));
    }
    afterAnswer();
  };

  const brokerHref = (link: HTMLLinkElement, raw: string): boolean => {
    let absolute: string;
    try {
      absolute = new URL(raw, document.baseURI).href;
    } catch {
      return false;
    }
    const canonical = canonicalGoogleFontsUrl(absolute);
    if (!canonical.ok || canonical.kind !== "css") return false;
    // The same stylesheet again resolves from the cached answer to the same data: URL, and the
    // runtime's same-href path gives the widget exactly one load.
    const entry: BrokeredLink = {raw, original: absolute, url: canonical.url, state: "pending"};
    brokeredLinks.set(link, entry);
    if (link.isConnected && isStylesheetRel(link)) holdForBroker(link, entry);
    void stylesheet(canonical.url).then((answer) => apply(link, entry, answer));
    return true;
  };

  const forget = (link: HTMLLinkElement): void => {
    const entry = brokeredLinks.get(link);
    if (!entry) return;
    brokeredLinks.delete(link);
    releaseBrokerHold(link, entry);
  };

  Object.defineProperty(prototype, "href", {
    configurable: true,
    enumerable: hrefDescriptor.enumerable ?? true,
    get(this: HTMLLinkElement) {
      const entry = brokeredLinks.get(this);
      return entry ? entry.original : nativeGet.call(this);
    },
    set(this: HTMLLinkElement, value: unknown) {
      if (brokerHref(this, String(value))) return;
      forget(this);
      nativeSet.call(this, value);
    }
  });
  Element.prototype.setAttribute = function setAttribute(this: Element, name: string, value: string): void {
    if (this instanceof HTMLLinkElement && String(name).toLowerCase() === "href") {
      if (brokerHref(this, String(value))) return;
      forget(this);
    }
    nativeSetAttribute.call(this, name, value);
  };
  Element.prototype.getAttribute = function getAttribute(this: Element, name: string): string | null {
    if (this instanceof HTMLLinkElement && String(name).toLowerCase() === "href") {
      const entry = brokeredLinks.get(this);
      if (entry) return entry.raw;
    }
    return nativeGetAttr.call(this, name);
  };
  Element.prototype.removeAttribute = function removeAttribute(this: Element, name: string): void {
    if (this instanceof HTMLLinkElement && String(name).toLowerCase() === "href") forget(this);
    nativeRemoveAttribute.call(this, name);
  };

  const broker: FontBroker = {
    adopt: brokerHref,
    topUp(wanted) {
      const extra = new Map<string, string>();
      for (const face of wanted.values()) {
        if (!face.url) continue;
        const canonical = canonicalGoogleFontsUrl(face.url);
        const covered = canonical.ok ? partialSheets.get(canonical.url) : undefined;
        if (!canonical.ok || !covered) continue;
        let text = extra.get(canonical.url) ?? "";
        for (const character of face.text) if (character.trim() !== "" && !covered.has(character) && !text.includes(character)) text += character;
        if (text) extra.set(canonical.url, text);
      }
      if (extra.size === 0) return undefined;
      return Promise.all(
        Array.from(extra, async ([url, text]) => {
          const covered = partialSheets.get(url);
          if (covered) for (const character of text) covered.add(character);
          const answer = await ask(url, text);
          if (answer.status !== "ok") return;
          if (!answer.partial) partialSheets.delete(url);
          const style = document.createElement("style");
          style.setAttribute("data-sws-font-subsets", url);
          style.textContent = answer.css;
          (document.head ?? document.documentElement).append(style);
        })
      ).then(() => undefined);
    },
    receive(payload) {
      const message = payload as {requestId?: unknown; status?: unknown; css?: unknown; partial?: unknown; message?: unknown} | undefined;
      if (!message || typeof message.requestId !== "string") return;
      const resolve = pending.get(message.requestId);
      if (!resolve) return;
      pending.delete(message.requestId);
      const text = typeof message.message === "string" ? message.message : "";
      if (message.status === "ok" && typeof message.css === "string" && message.css.length <= MAX_FONT_CSS_CHARACTERS) resolve({status: "ok", css: message.css, partial: message.partial === true});
      else if (message.status === "upstream-4xx") resolve({status: "upstream-4xx", message: text || "Google Fonts refused this stylesheet."});
      else resolve({status: "unavailable", message: text || "Google Fonts are unavailable in this preview."});
    }
  };

  // Links in the page source: the server already resolved most of them into data: CSS.
  for (const link of Array.from(document.querySelectorAll("link"))) {
    const original = nativeGetAttr.call(link, "data-sws-original-href");
    if (original) {
      let absolute: string;
      try {
        absolute = new URL(original, document.baseURI).href;
      } catch {
        continue;
      }
      const canonical = canonicalGoogleFontsUrl(absolute);
      if (!canonical.ok) continue;
      const dataUrl = nativeGet.call(link);
      brokeredLinks.set(link, {raw: original, original: absolute, url: canonical.url, state: "applied", dataUrl});
      if (!answers.has(canonical.url)) answers.set(canonical.url, Promise.resolve({status: "ok", dataUrl}));
      if (link.hasAttribute("data-sws-font-partial")) partialSheets.set(canonical.url, coveredCharacters(""));
      continue;
    }
    const raw = nativeGetAttr.call(link, "href");
    if (raw && isStylesheetRel(link)) brokerHref(link, raw);
  }
  return broker;
}

export function installFrameRuntime(options: FrameRuntimeOptions): void {
  let runtimeState: RuntimeState | null = null;
  /** The Session Dashboard data of this frame, from onWidgetLoad on. */
  let session: SessionTracker | undefined;
  let adapter: BrowserAdapter = {};
  let initialized = false;
  const mapAssets = <T>(value: T): T => mapRuntimeAssets(value, options.assetMap, options.sampleMediaBaseUrl);
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

  const emit = async (listener: string, event: JsonValue) => {
    const transformed = mapAssets(adapter.beforeDispatch ? await adapter.beforeDispatch({listener, event}) : event);
    window.dispatchEvent(
      new CustomEvent("onEventReceived", {
        detail: {listener, event: structuredClone(transformed)}
      })
    );
    // An event the Session Dashboard counts updates the session data, as in StreamElements.
    if (session?.apply(listener, transformed, new Date().toISOString())) {
      window.dispatchEvent(new CustomEvent("onSessionUpdate", {detail: {session: structuredClone(session.data)}}));
      // The host keeps it for the next frame: a reload for a field change starts from it, as the
      // reloaded widget in StreamElements receives the dashboard's data with the events so far.
      send("frame:session-updated", {data: structuredClone(session.data)});
    }
  };
  const emitAndAnnounce = (listener: string, event: JsonValue) => {
    void emit(listener, event).then(() => send("frame:event-dispatched", {listener}));
  };

  // Captures manage the clock and keep the settle deadline in Node; the editor preview has real
  // timers and its own font budget, below the widget's readiness timeout.
  let fontBudgetMs: number | undefined;
  const fontSampleText = () =>
    Object.values(runtimeState?.fieldData ?? {})
      .filter((value): value is string => typeof value === "string" && !/^(?:[a-z][a-z\d+.-]*:|\/)/i.test(value))
      .join(" ");
  const runSettle = async (light: boolean, requestId?: string): Promise<FontReport> => {
    if (!light) send("frame:settling", requestId ? {requestId} : undefined);
    const report = await settle({
      light,
      sampleText: fontSampleText(),
      ...(fontBudgetMs !== undefined ? {budgetMs: fontBudgetMs} : {})
    });
    if (!light || requestId) send("frame:fonts", {report, ...(requestId ? {requestId} : {})});
    return report;
  };

  wrapCanvasText();

  // After the editor answers a stylesheet that arrived past the first settle, report fonts again.
  let widgetReady = false;
  let refreshQueued = false;
  const refreshFonts = () => {
    if (!widgetReady || refreshQueued) return;
    refreshQueued = true;
    void nextTask().then(async () => {
      refreshQueued = false;
      try {
        await runSettle(false);
      } catch {
        // The next command reports it.
      }
    });
  };
  if (options.fontBroker) fontBroker = installFontBroker(send, fontSampleText, refreshFonts);

  window.SE_API = createSeApi(emitAndAnnounce);

  window.__SE_WIDGET_STUDIO__ = {
    getState: () => (runtimeState ? structuredClone(runtimeState) : null),
    emit: emitAndAnnounce,
    settle: () => runSettle(false),
    fontState: fontWaitState
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
    session = new SessionTracker(runtimeState.session ?? {});
    if (!clockManaged) {
      installFixedDate(runtimeState.fixedTime);
      fontBudgetMs = Math.max(0, Math.min(PREVIEW_FONT_BUDGET_MS, options.timeoutMs - 1_000));
    }
    await waitForDocument();
    watchStylesheets();
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
          recents: structuredClone(runtimeState.recents),
          session: {data: structuredClone(session.data)}
        }
      })
    );
    send("frame:widget-load-dispatched");
    if (adapter.afterLoad) await adapter.afterLoad({state: runtimeState});
    await withTimeout(waitForLoadedAssets(() => runSettle(false)), options.timeoutMs, "Asset readiness");
    send("frame:assets-ready");
    if (options.readySelector) await waitForSelector(options.readySelector, options.timeoutMs);
    send("frame:widget-ready");
    widgetReady = true;
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
            await emit(payload.listener, payload.event);
            // Acknowledged once fonts the handler asked for have settled, with the report.
            const fonts = await runSettle(false);
            send("frame:event-dispatched", {listener: payload.listener, fonts, ...(payload.requestId ? {requestId: payload.requestId} : {})});
            break;
          }
          case "host:update-fields": {
            if (!runtimeState) throw new Error("Widget frame is not initialized.");
            const payload = envelope.payload as {fieldData: JsonObject; requestId?: string};
            runtimeState.fieldData = {...runtimeState.fieldData, ...mapAssets(structuredClone(payload.fieldData))};
            window.dispatchEvent(
              new CustomEvent("onWidgetUpdate", {detail: {fieldData: structuredClone(runtimeState.fieldData)}})
            );
            const fonts = await runSettle(false);
            send("frame:fields-updated", {requestId: payload.requestId, fonts});
            break;
          }
          case "host:settle": {
            const payload = envelope.payload as {light?: boolean; requestId?: string} | undefined;
            await runSettle(payload?.light === true, typeof payload?.requestId === "string" ? payload.requestId : undefined);
            break;
          }
          case "host:font-response":
            fontBroker?.receive(envelope.payload);
            break;
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
