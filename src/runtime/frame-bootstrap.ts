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

installFrameRuntime({
  sessionId,
  nonce,
  parentOrigin,
  widgetScriptUrl,
  ...(adapterUrl ? {adapterUrl} : {}),
  ...(readySelector ? {readySelector} : {}),
  timeoutMs: Number.isFinite(parsedTimeout) ? parsedTimeout : 10_000
});
