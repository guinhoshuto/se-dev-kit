import {createServer, type IncomingMessage, type Server, type ServerResponse} from "node:http";
import {readFile} from "node:fs/promises";
import {basename, dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import chokidar, {type FSWatcher} from "chokidar";
import type {AddressInfo} from "node:net";
import type {ResolvedProject} from "../types.js";
import {StudioError, toErrorMessage} from "../shared/errors.js";
import {buildAssetMap, lookupAsset, type AssetEntry} from "./assets.js";
import {renderCapturePage} from "./capture-page.js";
import {renderFrameDocument} from "./html.js";
import {loadProject} from "../config/load.js";
import {assertPublicSafeProject} from "../validation/privacy.js";

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
  close: () => Promise<void>;
}

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const distributionRoot = resolve(moduleDirectory, "..");
const uiAssets = new Map([
  ["styles.css", resolve(distributionRoot, "studio-ui/styles.css")],
  ["app.js", resolve(distributionRoot, "studio-ui/app.js")],
  ["bridge.js", resolve(distributionRoot, "studio-ui/bridge.js")],
  ["capture-host.js", resolve(distributionRoot, "studio-ui/capture-host.js")]
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

function publicProject(project: ResolvedProject, origin: string, frameOrigin: string) {
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
    limitations: [
      "This is an essential local StreamElements simulation, not full platform parity.",
      "Only documented Studio bridge events and the explicitly listed SE_API methods are simulated."
    ]
  };
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

function frameContentSecurityPolicy(controlOrigin: string): string {
  return [
    "default-src 'self' data: blob: https:",
    "script-src 'self' 'unsafe-inline' https:",
    "style-src 'self' 'unsafe-inline' https:",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https:",
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
        const html = await renderFrameDocument(activeProject, {frameOrigin, controlOrigin, sessionId, nonce});
        send(request, response, 200, "text/html; charset=utf-8", html, frameHeaders);
        return;
      }
      if (pathname === "/__sws/runtime/frame-bootstrap.js" || pathname === "/__sws/runtime/frame.js") {
        const fileName = pathname.endsWith("frame-bootstrap.js") ? "frame-bootstrap.js" : "frame.js";
        const source = await readFile(resolve(distributionRoot, "runtime", fileName));
        send(request, response, 200, "text/javascript; charset=utf-8", source, frameHeaders);
        return;
      }
      if (pathname === "/__sws/version.js") {
        const source = await readFile(resolve(distributionRoot, "version.js"));
        send(request, response, 200, "text/javascript; charset=utf-8", source, frameHeaders);
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
        sendJson(request, response, 200, publicProject(activeProject, controlOrigin, frameOrigin));
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
