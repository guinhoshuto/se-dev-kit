import {readFile} from "node:fs/promises";
import {posix} from "node:path";
import type {JsonObject, ResolvedProject} from "../types.js";
import {StudioError} from "../shared/errors.js";
import {introducedHtmlRefusals, substitutePlaceholders, substitutedHtmlError} from "../config/placeholders.js";
import {assetUrlPath} from "./assets.js";

interface FrameDocumentOptions {
  frameOrigin: string;
  controlOrigin: string;
  sessionId: string;
  nonce: string;
  /** Values for `{{field}}` placeholders, already mapped for the frame (samples as frame URLs). */
  fieldData: JsonObject;
  /** Registered document key; the configured CSS and JS are then requested with `?doc=<key>`. */
  docKey?: string;
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function normalizedReference(reference: string, htmlDirectory: string): string {
  const clean = reference.split(/[?#]/, 1)[0] ?? reference;
  return posix.normalize(posix.join(htmlDirectory, clean.replace(/^\.\//, "")));
}

function stripConfiguredScript(html: string, htmlDirectory: string, scriptPath: string): string {
  return html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi, (tag: string, attrs: string, body: string) => {
    const type = /\btype\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1]?.toLowerCase();
    if (type && !["text/javascript", "application/javascript"].includes(type)) return tag;
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    if (src && normalizedReference(src, htmlDirectory) === scriptPath) return "";
    return `<script type="application/x-sws-classic"${src ? ` data-sws-src="${escapeAttribute(src)}"` : ""}>${body}</script>`;
  });
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

/** Configured CSS or JS URL, at its usual path so relative `url()` keeps resolving; `doc` selects the values. */
export function substitutedFileUrl(frameOrigin: string, path: string, docKey?: string): string {
  return `${frameOrigin}${assetUrlPath(path)}${docKey ? `?doc=${docKey}` : ""}`;
}

/**
 * Points the widget's own link to the configured stylesheet at the substituted copy, and drops
 * external links that are not stylesheets (`preconnect`, `dns-prefetch`, `preload`): they open
 * sockets outside request routing. Hosted import drops them too.
 */
function rewriteLinks(html: string, htmlDirectory: string, cssPath: string, cssUrl: string, docKey: string | undefined): string {
  return html.replace(/<link\b[^>]*>/gi, (tag: string) => {
    const rel = /\brel\s*=\s*["']?([^"'>\s]+)/i.exec(tag)?.[1]?.toLowerCase();
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (rel !== "stylesheet") return href && /^(?:[a-z][a-z\d+.-]*:)?\/\//i.test(href.trim()) ? "" : tag;
    if (docKey && href && normalizedReference(href, htmlDirectory) === cssPath) {
      return tag.replace(/\bhref\s*=\s*["'][^"']+["']/i, `href="${escapeAttribute(cssUrl)}"`);
    }
    return tag;
  });
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
  const raw = await readFile(project.files.html, "utf8");
  const source = substitutePlaceholders(raw, options.fieldData).text;
  const introduced = introducedHtmlRefusals(raw, source);
  if (introduced.length > 0) throw new StudioError("PLACEHOLDER_UNSAFE_HTML", substitutedHtmlError(introduced));
  const htmlPath = project.relativeFiles.html;
  const htmlDirectory = posix.dirname(htmlPath);
  const baseDirectory = htmlDirectory === "." ? "" : `${htmlDirectory}/`;
  const cssPath = project.relativeFiles.css;
  const scriptPath = project.relativeFiles.js;
  const cssUrl = substitutedFileUrl(options.frameOrigin, cssPath, options.docKey);
  const scriptUrl = substitutedFileUrl(options.frameOrigin, scriptPath, options.docKey);
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
  const linksConfiguredStylesheet = hasConfiguredStylesheet(source, htmlDirectory, cssPath);
  const sourceWithoutConfiguredScript = rewriteLinks(stripConfiguredScript(source, htmlDirectory, scriptPath), htmlDirectory, cssPath, cssUrl, options.docKey);

  if (!isDocument) {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${baseTag}
  ${linksConfiguredStylesheet ? "" : cssTag}
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
    ...(linksConfiguredStylesheet ? [] : [cssTag])
  ].join("\n");
  document = injectIntoHead(document, headTags);
  document = injectBeforeBodyEnd(document, bootstrapTag);
  return document;
}
