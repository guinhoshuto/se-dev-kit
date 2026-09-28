import {installFrameRuntime} from "./frame.js";

const parameters = new URL(import.meta.url).searchParams;
const sessionId = parameters.get("session");
const nonce = parameters.get("nonce");
const parentOrigin = parameters.get("parentOrigin");
const widgetScriptUrl = parameters.get("script");

if (!sessionId || !nonce || !parentOrigin || !widgetScriptUrl) {
  throw new Error("SE Widget Studio frame bootstrap is missing required parameters.");
}

const adapterUrl = parameters.get("adapter") ?? undefined;
const readySelector = parameters.get("ready") ?? undefined;
const parsedTimeout = Number(parameters.get("timeout") ?? 10_000);

/**
 * The widget's files by widget-relative key, as absolute URLs of this frame origin, so a field value
 * such as `studio/media/a.jpg` reaches the widget as a URL it can load. The host sends `host:init`
 * only after `frame:booted`, so this runs before any state arrives.
 */
async function widgetAssetMap(): Promise<{assetMap?: Record<string, string>; error?: string}> {
  try {
    const response = await fetch(new URL("/__sws/asset-map.json", import.meta.url), {signal: AbortSignal.timeout(5_000)});
    if (!response.ok) return {error: `HTTP ${response.status}`};
    return {assetMap: (await response.json()) as Record<string, string>};
  } catch (error) {
    return {error: error instanceof Error ? error.message : String(error)};
  }
}
const assets = await widgetAssetMap();

installFrameRuntime({
  sessionId,
  nonce,
  parentOrigin,
  widgetScriptUrl,
  ...(adapterUrl ? {adapterUrl} : {}),
  ...(readySelector ? {readySelector} : {}),
  timeoutMs: Number.isFinite(parsedTimeout) ? parsedTimeout : 10_000,
  ...(assets.assetMap ? {assetMap: assets.assetMap} : {}),
  // Built-in samples are served by the same frame origin, outside the widget allowlist.
  sampleMediaBaseUrl: new URL("/__sws/sample/", import.meta.url).href
});
// After installation, so the host receives it as `frame:console`.
if (assets.error) console.warn(`SE Widget Studio could not load the widget asset map (${assets.error}); field values that name widget files stay relative.`);
