import {readFile} from "node:fs/promises";
import {posix} from "node:path";
import type {ResolvedProject} from "../types.js";
import {assetUrlPath} from "./assets.js";

interface FrameDocumentOptions {
  frameOrigin: string;
  controlOrigin: string;
  sessionId: string;
  nonce: string;
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function normalizedReference(reference: string, htmlDirectory: string): string {
  const clean = reference.split(/[?#]/, 1)[0] ?? reference;
  return posix.normalize(posix.join(htmlDirectory, clean.replace(/^\.\//, "")));
}

function stripConfiguredScript(html: string, htmlDirectory: string, scriptPath: string): string {
  return html.replace(/<script\b([^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*)>\s*<\/script\s*>/gi, (tag, _attrs, src) =>
    normalizedReference(String(src), htmlDirectory) === scriptPath ? "" : String(tag)
  );
}

function hasConfiguredStylesheet(html: string, htmlDirectory: string, cssPath: string): boolean {
  const pattern = /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    const href = match[1];
    if (href && normalizedReference(href, htmlDirectory) === cssPath) return true;
  }
  return false;
}

function injectIntoHead(html: string, injection: string): string {
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (head) => `${head}\n${injection}`);
  if (/<html\b[^>]*>/i.test(html)) return html.replace(/<html\b[^>]*>/i, (tag) => `${tag}\n<head>${injection}</head>`);
  return `${injection}\n${html}`;
}

function injectBeforeBodyEnd(html: string, injection: string): string {
  if (/<\/body\s*>/i.test(html)) return html.replace(/<\/body\s*>/i, `${injection}\n</body>`);
  return `${html}\n${injection}`;
}

export async function renderFrameDocument(project: ResolvedProject, options: FrameDocumentOptions): Promise<string> {
  const source = await readFile(project.files.html, "utf8");
  const htmlPath = project.relativeFiles.html;
  const htmlDirectory = posix.dirname(htmlPath);
  const baseDirectory = htmlDirectory === "." ? "" : `${htmlDirectory}/`;
  const cssPath = project.relativeFiles.css;
  const scriptPath = project.relativeFiles.js;
  const cssUrl = `${options.frameOrigin}${assetUrlPath(cssPath)}`;
  const scriptUrl = `${options.frameOrigin}${assetUrlPath(scriptPath)}`;
  const adapterUrl = project.adapterPath
    ? `${options.frameOrigin}${assetUrlPath(posix.normalize(project.config.widget.adapter ?? ""))}`
    : undefined;
  const ready = project.config.widget.ready;
  const bootstrapParameters = new URLSearchParams({
    session: options.sessionId,
    nonce: options.nonce,
    parentOrigin: options.controlOrigin,
    script: scriptUrl,
    timeout: String(ready?.timeoutMs ?? 10_000)
  });
  if (adapterUrl) bootstrapParameters.set("adapter", adapterUrl);
  if (ready?.selector) bootstrapParameters.set("ready", ready.selector);
  const bootstrapUrl = `${options.frameOrigin}/__sws/runtime/frame-bootstrap.js?${bootstrapParameters.toString()}`;
  const baseTag = `<base href="${escapeAttribute(`${options.frameOrigin}${assetUrlPath(baseDirectory)}`.replace(/%2F$/i, "/"))}">`;
  const cssTag = `<link rel="stylesheet" href="${escapeAttribute(cssUrl)}">`;
  const bootstrapTag = `<script type="module" src="${escapeAttribute(bootstrapUrl)}"></script>`;
  const isDocument = /<!doctype\s+html|<html\b|<head\b|<body\b/i.test(source);
  const sourceWithoutConfiguredScript = stripConfiguredScript(source, htmlDirectory, scriptPath);

  if (!isDocument) {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${baseTag}
  ${cssTag}
</head>
<body>
${sourceWithoutConfiguredScript}
${bootstrapTag}
</body>
</html>`;
  }

  let document = sourceWithoutConfiguredScript;
  const headTags = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    baseTag,
    ...(hasConfiguredStylesheet(document, htmlDirectory, cssPath) ? [] : [cssTag])
  ].join("\n");
  document = injectIntoHead(document, headTags);
  document = injectBeforeBodyEnd(document, bootstrapTag);
  return document;
}
