import {randomBytes} from "node:crypto";
import {createServer, type IncomingMessage, type Server, type ServerResponse} from "node:http";
import {readFile} from "node:fs/promises";
import {basename, dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import chokidar, {type FSWatcher} from "chokidar";
import type {AddressInfo} from "node:net";
import type {JsonObject, JsonValue, ResolvedProject} from "../types.js";
import {StudioError, toErrorMessage} from "../shared/errors.js";
import {buildAssetMap, lookupAsset, type AssetEntry} from "./assets.js";
import {renderCapturePage} from "./capture-page.js";
import {renderTutorialPage} from "./tutorial-page.js";
import {renderFrameDocument} from "./html.js";
import {loadProject} from "../config/load.js";
import {assertPublicSafeProject} from "../validation/privacy.js";
import {loadSampleMediaCatalog, requireSampleMedia, sampleMediaSummaries, type SampleMediaCatalog} from "../config/sample-media.js";
import {SAMPLE_MEDIA_ROUTE, SAMPLE_REFERENCE_PATTERN, sampleMediaFile, type SampleMediaSummary} from "../studio-ui/sample-media.js";
import {missingPlaceholderWarning, substitutePlaceholders} from "../config/placeholders.js";

export interface StartServerOptions {
  host?: string;
  port?: number;
  allowRemote?: boolean;
  watch?: boolean;
  onLog?: (message: string) => void;
}

export interface StudioServer {
  host: string;
  port: number;
  framePort: number;
  origin: string;
  frameOrigin: string;
  /** Absolute frame-origin URL of a built-in sample; fails with SAMPLE_MEDIA_NOT_FOUND for unknown references. */
  sampleMediaUrl: (reference: string) => Promise<string>;
  /**
   * Registers the effective `fieldData` of one scene and returns the key the frame URL carries as
   * `doc=<key>`. The frame document, the configured CSS and the configured JS are then served with
   * `{{field}}` placeholders substituted from these values. Without a key, the defaults apply.
   * Fails with PLACEHOLDER_UNSAFE_HTML when a value would add refused HTML.
   */
  registerFrameDocument: (fieldData: JsonObject) => Promise<string>;
  close: () => Promise<void>;
}

const MAX_FRAME_DOCUMENTS = 256;

/** The compiled frame runtime modules the frame server serves; never a whole directory. */
const FRAME_RUNTIME_FILES = new Map([
  ["/__sws/runtime/frame-bootstrap.js", "frame-bootstrap.js"],
  ["/__sws/runtime/frame.js", "frame.js"],
  ["/__sws/runtime/google-fonts-url.js", "google-fonts-url.js"]
]);

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const distributionRoot = resolve(moduleDirectory, "..");
const uiAssets = new Map([
  ["styles.css", resolve(distributionRoot, "studio-ui/styles.css")],
  ["app.js", resolve(distributionRoot, "studio-ui/app.js")],
  ["bridge.js", resolve(distributionRoot, "studio-ui/bridge.js")],
  ["capture-host.js", resolve(distributionRoot, "studio-ui/capture-host.js")],
  ["tutorial-host.js", resolve(distributionRoot, "studio-ui/tutorial-host.js")],
  ["sample-media.js", resolve(distributionRoot, "studio-ui/sample-media.js")]
]);

function commonHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
}

function send(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string | Buffer,
  headers: Record<string, string> = {}
): void {
  commonHeaders(response);
  response.statusCode = status;
  response.setHeader("Content-Type", contentType);
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(request.method === "HEAD" ? undefined : body);
}

function sendJson(request: IncomingMessage, response: ServerResponse, status: number, value: unknown): void {
  send(request, response, status, "application/json; charset=utf-8", `${JSON.stringify(value, null, 2)}\n`);
}

function validateRequest(request: IncomingMessage, response: ServerResponse, expectedHost: string): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") {
    send(request, response, 405, "text/plain; charset=utf-8", "Method Not Allowed\n", {Allow: "GET, HEAD"});
    return false;
  }
  if (request.headers.host !== expectedHost || !request.url?.startsWith("/")) {
    send(request, response, 400, "text/plain; charset=utf-8", "Bad Request\n");
    return false;
  }
  return true;
}

function publicProject(
  project: ResolvedProject,
  origin: string,
  frameOrigin: string,
  sampleMedia: {items: SampleMediaSummary[]; error?: string}
) {
  const catalog = <T extends {id: string; name: string}>(items: {value: T}[]) => items.map(({value}) => value);
  return {
    studio: {version: project.packageVersion, origin, frameOrigin},
    widget: {
      name: basename(project.widgetRoot),
      files: project.relativeFiles,
      viewport: project.config.widget.viewport ?? {width: 430, height: 640, deviceScaleFactor: 1},
      ready: project.config.widget.ready ?? {timeoutMs: 10_000}
    },
    channel: project.config.channel ?? {username: "streamer"},
    fields: project.fields,
    fieldDefaults: project.fieldDefaults,
    rawFields: project.rawFields,
    themes: catalog(project.themes),
    fixtures: catalog(project.fixtures),
    scenarios: catalog(project.scenarios),
    scenes: catalog(project.scenes),
    recipes: catalog(project.recipes),
    sampleMedia: sampleMedia.items,
    ...(sampleMedia.error ? {sampleMediaError: sampleMedia.error} : {}),
    limitations: [
      "This is an essential local StreamElements simulation, not full platform parity.",
      "Only documented Studio bridge events and the explicitly listed SE_API methods are simulated."
    ]
  };
}

/** Placeholder values as the frame sees them: sample references become frame-origin URLs, as the runtime maps them. */
function frameFieldValues(fieldData: JsonObject, frameOrigin: string): JsonObject {
  const mapped: JsonObject = {};
  for (const [key, value] of Object.entries(fieldData)) {
    const file = typeof value === "string" ? sampleMediaFile(value) : undefined;
    mapped[key] = file ? `${frameOrigin}${SAMPLE_MEDIA_ROUTE}${file}` : (value as JsonValue);
  }
  return mapped;
}

async function listen(server: Server, port: number, host: string): Promise<number> {
  await new Promise<void>((resolvePromise, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolvePromise();
    });
  });
  return (server.address() as AddressInfo).port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolvePromise, reject) =>
    server.close((error) => (error ? reject(error) : resolvePromise()))
  );
}

/**
 * A protocol-relative `//fonts.googleapis.com/…` in a frame served over loopback HTTP becomes
 * `http:`. The CSP lets exactly those two hosts through so the request reaches the route, which
 * answers it from the job's font package (or blocks it); nothing is fetched over plain HTTP.
 */
const GOOGLE_FONTS_HTTP_SOURCES = "http://fonts.googleapis.com http://fonts.gstatic.com";

function frameContentSecurityPolicy(controlOrigin: string): string {
  return [
    "default-src 'self' data: blob: https:",
    "script-src 'self' 'unsafe-inline' https:",
    `style-src 'self' 'unsafe-inline' https: ${GOOGLE_FONTS_HTTP_SOURCES}`,
    "img-src 'self' data: blob: https:",
    `font-src 'self' data: https: ${GOOGLE_FONTS_HTTP_SOURCES}`,
    "media-src 'self' data: blob: https:",
    "connect-src 'self' https:",
    `frame-ancestors ${controlOrigin}`,
    "object-src 'none'",
    "base-uri 'self'"
  ].join("; ");
}

function controlContentSecurityPolicy(frameOrigin: string): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${frameOrigin}`,
    `frame-src ${frameOrigin}`,
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'"
  ].join("; ");
}

export async function startStudioServer(
  project: ResolvedProject,
  options: StartServerOptions = {}
): Promise<StudioServer> {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost" && !options.allowRemote) {
    throw new StudioError(
      "REMOTE_BIND_REQUIRES_OPT_IN",
      `Refusing to bind to ${host} without --allow-remote. The default is 127.0.0.1.`
    );
  }
  assertPublicSafeProject(project);
  let activeProject = project;
  let assetMap = await buildAssetMap(activeProject);
  let controlOrigin = "";
  let frameOrigin = "";
  let controlHostHeader = "";
  let frameHostHeader = "";
  const sseClients = new Set<ServerResponse>();
  let watcher: FSWatcher | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  // Loaded on first use so widgets without sample references never depend on sample-media/.
  const sampleMedia = (): Promise<SampleMediaCatalog> => loadSampleMediaCatalog();
  // In-memory only; oldest keys are dropped first. Values never leave this process except as page content.
  const frameDocuments = new Map<string, JsonObject>();
  /** `undefined` for an unknown key; the defaults when no key is given (the local dev UI). */
  const frameValues = (docKey: string | null): JsonObject | undefined => {
    if (docKey === null) return frameFieldValues(activeProject.fieldDefaults, frameOrigin);
    return /^[a-f0-9]{32}$/.test(docKey) ? frameDocuments.get(docKey) : undefined;
  };

  const frameServer = createServer((request, response) => {
    void (async () => {
      if (!validateRequest(request, response, frameHostHeader)) return;
      const requestUrl = new URL(request.url ?? "/", frameOrigin);
      const pathname = requestUrl.pathname;
      const frameHeaders = {"Content-Security-Policy": frameContentSecurityPolicy(controlOrigin)};

      if (pathname === "/__sws/health") {
        sendJson(request, response, 200, {status: "ok", role: "frame"});
        return;
      }
      if (pathname.startsWith("/__sws/frame/")) {
        const sessionId = pathname.slice("/__sws/frame/".length);
        const nonce = requestUrl.searchParams.get("nonce") ?? "";
        if (!/^[a-f0-9]{24}$/.test(sessionId) || !/^[a-f0-9]{32}$/.test(nonce)) {
          send(request, response, 404, "text/plain; charset=utf-8", "Not Found\n", frameHeaders);
          return;
        }
        const docKey = requestUrl.searchParams.get("doc");
        const fieldData = frameValues(docKey);
        if (!fieldData) {
          send(request, response, 404, "text/plain; charset=utf-8", "Not Found\n", frameHeaders);
          return;
        }
        let html: string;
        try {
          html = await renderFrameDocument(activeProject, {frameOrigin, controlOrigin, sessionId, nonce, fieldData, ...(docKey ? {docKey} : {})});
        } catch (error) {
          if (!(error instanceof StudioError)) throw error;
          send(request, response, 422, "text/plain; charset=utf-8", `${error.message}\n`, frameHeaders);
          return;
        }
        send(request, response, 200, "text/html; charset=utf-8", html, frameHeaders);
        return;
      }
      const runtimeFile = FRAME_RUNTIME_FILES.get(pathname);
      if (runtimeFile) {
        const source = await readFile(resolve(distributionRoot, "runtime", runtimeFile));
        send(request, response, 200, "text/javascript; charset=utf-8", source, frameHeaders);
        return;
      }
      if (pathname === "/__sws/version.js") {
        const source = await readFile(resolve(distributionRoot, "version.js"));
        send(request, response, 200, "text/javascript; charset=utf-8", source, frameHeaders);
        return;
      }
      if (pathname.startsWith("/__sws/sample/")) {
        // Exact lookup in the verified manifest; the widget asset allowlist is never consulted.
        let reference = "";
        try {
          reference = `sws-sample:${decodeURIComponent(pathname.slice("/__sws/sample/".length))}`;
        } catch {
          reference = "";
        }
        if (!SAMPLE_REFERENCE_PATTERN.test(reference)) {
          send(request, response, 404, "text/plain; charset=utf-8", "Not Found\n", frameHeaders);
          return;
        }
        const catalog = await sampleMedia();
        const entry = catalog.entry(reference);
        if (!entry) {
          send(request, response, 404, "text/plain; charset=utf-8", "Not Found\n", frameHeaders);
          return;
        }
        send(request, response, 200, entry.contentType, catalog.body(reference), frameHeaders);
        return;
      }
      if (pathname.startsWith("/__sws/widget/")) {
        let asset: AssetEntry;
        try {
          asset = lookupAsset(assetMap, pathname.slice("/__sws/widget/".length));
        } catch {
          send(request, response, 404, "text/plain; charset=utf-8", "Not Found\n", frameHeaders);
          return;
        }
        const source = await readFile(asset.filePath);
        // Only the widget's own CSS and JS carry placeholders, as in StreamElements; same path, so relative url() still resolves.
        if (asset.key === activeProject.relativeFiles.css || asset.key === activeProject.relativeFiles.js) {
          const fieldData = frameValues(requestUrl.searchParams.get("doc"));
          if (!fieldData) {
            send(request, response, 404, "text/plain; charset=utf-8", "Not Found\n", frameHeaders);
            return;
          }
          send(request, response, 200, asset.contentType, substitutePlaceholders(source.toString("utf8"), fieldData).text, frameHeaders);
          return;
        }
        send(request, response, 200, asset.contentType, source, frameHeaders);
        return;
      }
      send(request, response, 404, "text/plain; charset=utf-8", "Not Found\n", frameHeaders);
    })().catch((error) => {
      options.onLog?.(`Frame server error: ${toErrorMessage(error)}`);
      if (!response.headersSent) send(request, response, 500, "text/plain; charset=utf-8", "Internal Server Error\n");
      else response.destroy();
    });
  });

  const framePort = await listen(frameServer, 0, host);
  frameOrigin = `http://${host}:${framePort}`;
  frameHostHeader = `${host}:${framePort}`;

  const controlServer = createServer((request, response) => {
    void (async () => {
      if (!validateRequest(request, response, controlHostHeader)) return;
      const requestUrl = new URL(request.url ?? "/", controlOrigin);
      const pathname = requestUrl.pathname;
      const controlHeaders = {"Content-Security-Policy": controlContentSecurityPolicy(frameOrigin)};

      if (pathname === "/__sws/health") {
        sendJson(request, response, 200, {status: "ok", role: "control", frameOrigin});
        return;
      }
      if (pathname === "/__sws/api/project") {
        const samples = await sampleMedia().then(
          (catalog) => ({items: sampleMediaSummaries(catalog, frameOrigin)}),
          (error: unknown) => {
            options.onLog?.(`Sample media unavailable: ${toErrorMessage(error)}`);
            return {items: [], error: toErrorMessage(error)};
          }
        );
        sendJson(request, response, 200, publicProject(activeProject, controlOrigin, frameOrigin, samples));
        return;
      }
      if (pathname === "/__sws/events") {
        commonHeaders(response);
        response.statusCode = 200;
        response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        response.setHeader("Connection", "keep-alive");
        response.write("event: connected\ndata: {}\n\n");
        sseClients.add(response);
        request.on("close", () => sseClients.delete(response));
        return;
      }
      if (pathname === "/__sws/capture") {
        send(request, response, 200, "text/html; charset=utf-8", renderCapturePage(frameOrigin), controlHeaders);
        return;
      }
      if (pathname === "/__sws/tutorial") {
        send(request, response, 200, "text/html; charset=utf-8", renderTutorialPage(frameOrigin), controlHeaders);
        return;
      }
      if (pathname.startsWith("/__sws/ui/")) {
        const name = pathname.slice("/__sws/ui/".length);
        const filePath = uiAssets.get(name);
        if (!filePath) {
          send(request, response, 404, "text/plain; charset=utf-8", "Not Found\n", controlHeaders);
          return;
        }
        const extension = name.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8";
        send(request, response, 200, extension, await readFile(filePath), controlHeaders);
        return;
      }
      if (pathname === "/" || pathname === "/gallery") {
        send(
          request,
          response,
          200,
          "text/html; charset=utf-8",
          await readFile(resolve(distributionRoot, "studio-ui/index.html")),
          controlHeaders
        );
        return;
      }
      send(request, response, 404, "text/plain; charset=utf-8", "Not Found\n", controlHeaders);
    })().catch((error) => {
      options.onLog?.(`Control server error: ${toErrorMessage(error)}`);
      if (!response.headersSent) send(request, response, 500, "text/plain; charset=utf-8", "Internal Server Error\n");
      else response.destroy();
    });
  });

  const port = await listen(controlServer, options.port ?? 4173, host).catch(async (error) => {
    await closeServer(frameServer);
    throw error;
  });
  controlOrigin = `http://${host}:${port}`;
  controlHostHeader = `${host}:${port}`;

  if (options.watch !== false) {
    watcher = chokidar.watch([...new Set([project.widgetRoot, ...(project.configPath ? [project.configPath] : [])])], {
      ignored: [project.outputRoot, resolve(project.widgetRoot, ".git"), resolve(project.widgetRoot, "node_modules")],
      ignoreInitial: true,
      persistent: true,
      followSymlinks: false
    });
    watcher.on("all", (_event, changedPath) => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        void (async () => {
          const nextProject = await loadProject({
            inputDirectory: project.inputDirectory,
            ...(project.configPath ? {configPath: project.configPath} : {})
          });
          if (nextProject.widgetRoot !== project.widgetRoot) {
            throw new StudioError(
              "WATCH_ROOT_CHANGED",
              "widget.root changed while the Studio was running; restart dev to watch the new root."
            );
          }
          assertPublicSafeProject(nextProject);
          const nextAssets = await buildAssetMap(nextProject);
          activeProject = nextProject;
          assetMap = nextAssets;
          const payload = JSON.stringify({file: basename(changedPath)});
          for (const client of sseClients) client.write(`event: change\ndata: ${payload}\n\n`);
        })().catch((error) => options.onLog?.(`Project refresh failed: ${toErrorMessage(error)}`));
      }, 100);
    });
  }

  let closed = false;
  return {
    host,
    port,
    framePort,
    origin: controlOrigin,
    frameOrigin,
    sampleMediaUrl: async (reference) => {
      const entry = requireSampleMedia(await sampleMedia(), reference);
      return `${frameOrigin}/__sws/sample/${entry.file}`;
    },
    registerFrameDocument: async (fieldData) => {
      const values = frameFieldValues(fieldData, frameOrigin);
      const project = activeProject;
      const [html, css, js] = await Promise.all([project.files.html, project.files.css, project.files.js].map((file) => readFile(file, "utf8")));
      // Build once so unsafe values fail here, with a clear error, instead of as a frame that never boots.
      await renderFrameDocument(project, {frameOrigin, controlOrigin, sessionId: "0".repeat(24), nonce: "0".repeat(32), fieldData: values});
      const relative = [project.relativeFiles.html, project.relativeFiles.css, project.relativeFiles.js];
      [html, css, js].forEach((text, index) => {
        const missing = substitutePlaceholders(text ?? "", values).missing;
        if (missing.length > 0) options.onLog?.(missingPlaceholderWarning(relative[index] ?? "widget", missing));
      });
      const key = randomBytes(16).toString("hex");
      frameDocuments.set(key, values);
      while (frameDocuments.size > MAX_FRAME_DOCUMENTS) {
        const oldest = frameDocuments.keys().next().value;
        if (oldest === undefined) break;
        frameDocuments.delete(oldest);
      }
      return key;
    },
    close: async () => {
      if (closed) return;
      closed = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      for (const client of sseClients) client.end();
      sseClients.clear();
      await watcher?.close();
      await Promise.all([closeServer(controlServer), closeServer(frameServer)]);
    }
  };
}
