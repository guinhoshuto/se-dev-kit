/**
 * Drives the tutorial host in #host from a scrubber, without Playwright: loads a variant from
 * /__sws/api/tutorial-preview, runs the host's setup, and draws `render(timeMs)` at the scrubber's
 * time. Widget events and field changes are applied as the time passes them; a seek before an
 * applied one reloads the widget with the scene's values and replays up to the new time.
 */

interface PreviewIndex {
  recipes: {id: string; durationMs: number; fps: number; variants: string[]}[];
}

type PreviewEvent =
  | {atMs: number; kind: "dispatch"; listener: string; event: unknown}
  | {atMs: number; kind: "fields"; patch: Record<string, unknown>; fieldData: Record<string, unknown>; docKey?: string};

interface PreviewPayload {
  recipe: string;
  variant: string;
  variants: string[];
  durationMs: number;
  fps: number;
  fieldUpdate: "reload" | "event";
  crop: {x: number; y: number; width: number; height: number} | null;
  load: Parameters<Window["__SWS_CAPTURE__"]["load"]>[0];
  setup: Parameters<Window["__SWS_TUTORIAL__"]["setup"]>[0];
  events: PreviewEvent[];
}

/** The host page's window: its controllers are typed by capture-host.ts and tutorial-host.ts. */
type HostWindow = Window;

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Tutorial preview markup has no #${id}.`);
  return found as T;
}

const ui = {
  recipe: element<HTMLSelectElement>("recipe"),
  variant: element<HTMLSelectElement>("variant"),
  status: element<HTMLElement>("status"),
  viewer: element<HTMLElement>("viewer"),
  fit: element<HTMLElement>("fit"),
  host: element<HTMLIFrameElement>("host"),
  scrubber: element<HTMLInputElement>("scrubber"),
  cameraTicks: element<HTMLElement>("camera-ticks"),
  eventTicks: element<HTMLElement>("event-ticks"),
  play: element<HTMLButtonElement>("play"),
  back: element<HTMLButtonElement>("back"),
  forward: element<HTMLButtonElement>("forward"),
  time: element<HTMLOutputElement>("time"),
  full: element<HTMLInputElement>("full"),
  copy: element<HTMLButtonElement>("copy")
};

const state = {
  index: undefined as PreviewIndex | undefined,
  payload: undefined as PreviewPayload | undefined,
  host: undefined as HostWindow | undefined,
  timeMs: 0,
  playing: false,
  playFrom: {timeMs: 0, at: 0},
  /** How many of payload.events the widget has received. */
  applied: 0,
  widget: Promise.resolve(),
  /** Bumped on every load, so work of a replaced variant stops. */
  generation: 0
};

function setStatus(text: string, kind: "info" | "error" = "info"): void {
  ui.status.textContent = text;
  ui.status.dataset.kind = kind;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {cache: "no-store"});
  const body = await response.json() as T & {message?: string; hint?: string};
  if (!response.ok) throw new Error([body.message ?? `${url} answered ${response.status}.`, body.hint].filter(Boolean).join(" "));
  return body;
}

/** Loads a fresh tutorial host page and resolves once its controllers exist. */
function freshHost(): Promise<HostWindow> {
  return new Promise((resolve, reject) => {
    ui.host.addEventListener("load", () => {
      const host = ui.host.contentWindow as Partial<HostWindow> | null;
      if (host?.__SWS_CAPTURE__ && host.__SWS_TUTORIAL__) resolve(host as HostWindow);
      else reject(new Error("The tutorial host page loaded without its controllers."));
    }, {once: true});
    ui.host.src = `/__sws/tutorial?preview=${Date.now()}`;
  });
}

function frameMs(): number {
  return 1000 / (state.payload?.fps ?? 30);
}

function clampTime(timeMs: number): number {
  const duration = state.payload?.durationMs ?? 0;
  return Math.min(Math.max(0, Math.round(timeMs)), Math.max(0, duration - 1));
}

/** Scales the host to fit the viewer; with a crop, only the cropped region shows, as in the render. */
function layout(): void {
  const payload = state.payload;
  if (!payload) return;
  const {width, height} = payload.load.output;
  const crop = payload.crop ?? {x: 0, y: 0, width, height};
  ui.host.style.width = `${width}px`;
  ui.host.style.height = `${height}px`;
  ui.host.style.left = `${-crop.x}px`;
  ui.host.style.top = `${-crop.y}px`;
  ui.fit.style.width = `${crop.width}px`;
  ui.fit.style.height = `${crop.height}px`;
  const box = ui.viewer.getBoundingClientRect();
  const scale = Math.min((box.width - 32) / crop.width, (box.height - 32) / crop.height, 1);
  ui.fit.style.transform = `scale(${scale}) translate(-50%, -50%)`;
}

function ticks(container: HTMLElement, times: number[], label: (timeMs: number) => string): void {
  const duration = state.payload?.durationMs ?? 1;
  container.replaceChildren(...times.map((timeMs) => {
    const tick = document.createElement("i");
    tick.style.left = `${(timeMs / duration) * 100}%`;
    tick.title = label(timeMs);
    return tick;
  }));
}

function draw(): void {
  const payload = state.payload;
  if (!payload || !state.host) return;
  state.host.__SWS_TUTORIAL__.render(state.timeMs, {full: ui.full.checked});
  ui.scrubber.value = String(state.timeMs);
  const frame = Math.floor(state.timeMs / frameMs());
  const frames = Math.round((payload.durationMs * payload.fps) / 1000);
  ui.time.value = `${state.timeMs} ms · frame ${frame} of ${frames}`;
}

/** Replaces the widget frame with one that loads `fieldData`, as the editor does on a field change. */
async function reloadWidget(
  host: HostWindow,
  payload: PreviewPayload,
  fieldData: Record<string, unknown>,
  docKey: string | undefined,
  resetSession = false
): Promise<void> {
  const {readyTimeoutMs} = payload.load;
  host.__SWS_CAPTURE__.reload({
    fieldData,
    ...(readyTimeoutMs !== undefined ? {readyTimeoutMs} : {}),
    ...(docKey ? {docKey} : {}),
    ...(resetSession ? {resetSession} : {})
  });
  await host.__SWS_CAPTURE__.reloaded();
}

async function applyEvent(host: HostWindow, payload: PreviewPayload, event: PreviewEvent): Promise<void> {
  const capture = host.__SWS_CAPTURE__;
  if (event.kind === "dispatch") {
    await capture.dispatch(event.listener, event.event);
  } else if (event.docKey) {
    await reloadWidget(host, payload, event.fieldData, event.docKey);
  } else {
    await capture.updateFields(event.patch);
  }
}

/** Brings the widget to `timeMs`: one queue, so events never overlap and always land in order. */
function syncWidget(timeMs: number): Promise<void> {
  const generation = state.generation;
  state.widget = state.widget.then(async () => {
    const {payload, host} = state;
    if (!payload || !host || generation !== state.generation) return;
    if (state.applied > 0 && payload.events[state.applied - 1]!.atMs > timeMs) {
      // A seek back starts over from the scene, session data included.
      await reloadWidget(host, payload, payload.load.state.fieldData, payload.load.docKey, true);
      state.applied = 0;
    }
    while (generation === state.generation && state.applied < payload.events.length && payload.events[state.applied]!.atMs <= timeMs) {
      await applyEvent(host, payload, payload.events[state.applied]!);
      state.applied += 1;
    }
  }).catch((error: unknown) => setStatus(`Widget event failed: ${error instanceof Error ? error.message : String(error)}`, "error"));
  return state.widget;
}

function seek(timeMs: number): void {
  state.timeMs = clampTime(timeMs);
  if (state.playing) state.playFrom = {timeMs: state.timeMs, at: performance.now()};
  void syncWidget(state.timeMs);
  draw();
}

function setPlaying(playing: boolean): void {
  state.playing = playing && Boolean(state.payload);
  ui.play.textContent = state.playing ? "Pause" : "Play";
  ui.play.setAttribute("aria-label", state.playing ? "Pause" : "Play");
  if (!state.playing) return;
  if (state.timeMs >= clampTime(Number.POSITIVE_INFINITY)) state.timeMs = 0;
  state.playFrom = {timeMs: state.timeMs, at: performance.now()};
  const tick = () => {
    if (!state.playing) return;
    const next = state.playFrom.timeMs + (performance.now() - state.playFrom.at);
    const end = clampTime(Number.POSITIVE_INFINITY);
    state.timeMs = clampTime(next);
    void syncWidget(state.timeMs);
    draw();
    if (next >= end) setPlaying(false);
    else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function fillSelect(select: HTMLSelectElement, values: string[], selected: string): void {
  select.replaceChildren(...values.map((value) => new Option(value, value, value === selected, value === selected)));
}

async function loadVariant(recipe: string, variant: string | undefined, keepTimeMs: number): Promise<void> {
  const generation = ++state.generation;
  setPlaying(false);
  setStatus(`Loading ${recipe}…`);
  try {
    const query = new URLSearchParams({recipe, ...(variant ? {variant} : {})});
    const payload = await getJson<PreviewPayload>(`/__sws/api/tutorial-preview?${query}`);
    const host = await freshHost();
    if (generation !== state.generation) return;
    await host.__SWS_CAPTURE__.load(payload.load);
    const plan = await host.__SWS_TUTORIAL__.setup(payload.setup);
    if (generation !== state.generation) return;
    Object.assign(state, {payload, host, applied: 0, widget: Promise.resolve()});
    fillSelect(ui.recipe, state.index?.recipes.map((item) => item.id) ?? [payload.recipe], payload.recipe);
    fillSelect(ui.variant, payload.variants, payload.variant);
    ui.scrubber.max = String(payload.durationMs - 1);
    ui.scrubber.step = "1";
    history.replaceState(null, "", `?${new URLSearchParams({recipe: payload.recipe, variant: payload.variant})}`);
    layout();
    ticks(ui.cameraTicks, plan.camera.keys.map((key) => key.t), (timeMs) => `camera key at ${Math.round(timeMs)} ms`);
    ticks(ui.eventTicks, payload.events.map((event) => event.atMs), (timeMs) => `widget event at ${timeMs} ms`);
    seek(keepTimeMs);
    await state.widget;
    if (generation === state.generation && ui.status.dataset.kind !== "error") {
      setStatus(`${payload.recipe} · ${payload.variant} · ${payload.durationMs} ms at ${payload.fps} fps · script ends at ${Math.round(plan.endMs)} ms`);
    }
    document.body.dataset.ready = "true";
  } catch (error) {
    if (generation === state.generation) setStatus(error instanceof Error ? error.message : String(error), "error");
  }
}

async function boot(): Promise<void> {
  try {
    state.index = await getJson<PreviewIndex>("/__sws/api/tutorial-preview");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), "error");
    return;
  }
  if (state.index.recipes.length === 0) {
    setStatus("This widget has no recipe with a tutorial video (outputs.video.mode \"tutorial\").", "error");
    return;
  }
  const params = new URLSearchParams(location.search);
  const recipe = state.index.recipes.find((item) => item.id === params.get("recipe"))?.id ?? state.index.recipes[0]!.id;
  await loadVariant(recipe, params.get("variant") ?? undefined, Number(params.get("t") ?? 0) || 0);
  // The dev server reports widget and recipe edits; reload the variant and keep the time.
  new EventSource("/__sws/events").addEventListener("change", () => {
    if (state.payload) void loadVariant(state.payload.recipe, state.payload.variant, state.timeMs);
  });
}

ui.recipe.addEventListener("change", () => void loadVariant(ui.recipe.value, undefined, 0));
ui.variant.addEventListener("change", () => void loadVariant(ui.recipe.value, ui.variant.value, state.timeMs));
ui.scrubber.addEventListener("input", () => seek(Number(ui.scrubber.value)));
ui.play.addEventListener("click", () => setPlaying(!state.playing));
ui.back.addEventListener("click", () => seek(Math.ceil(state.timeMs / frameMs() - 1) * frameMs()));
ui.forward.addEventListener("click", () => seek(Math.floor(state.timeMs / frameMs() + 1) * frameMs()));
ui.full.addEventListener("change", draw);
ui.copy.addEventListener("click", () => {
  const text = `--sheet-at ${state.timeMs}`;
  void navigator.clipboard.writeText(text).then(
    () => setStatus(`Copied "${text}".`),
    () => setStatus(`Copy failed; the flag is ${text}.`, "error")
  );
});
window.addEventListener("resize", layout);
window.addEventListener("keydown", (event) => {
  if (event.target instanceof HTMLSelectElement) return;
  const step = event.shiftKey ? 1000 : frameMs();
  if (event.key === " ") {
    event.preventDefault();
    setPlaying(!state.playing);
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    seek(event.shiftKey ? state.timeMs - step : Math.ceil(state.timeMs / step - 1) * step);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    seek(event.shiftKey ? state.timeMs + step : Math.floor(state.timeMs / step + 1) * step);
  } else if (event.key === "Home") {
    seek(0);
  } else if (event.key === "End") {
    seek(Number.POSITIVE_INFINITY);
  } else if (event.key === "f" || event.key === "F") {
    ui.full.checked = !ui.full.checked;
    draw();
  }
});

void boot();

export {};
