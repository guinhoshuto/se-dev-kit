// Validation of Google Fonts stylesheets and font bytes (Node only). Pure: no network, no disk.
import postcss, {type ChildNode, type Declaration} from "postcss";

import {GOOGLE_FONTS_MAX_CSS_BYTES, canonicalGoogleFontsUrl} from "../runtime/google-fonts-url.js";

export type FontFileFormat = "woff2" | "woff" | "otf" | "ttf" | "ttc";

export interface GoogleFontFile {
  /** Canonical `https://fonts.gstatic.com/s/...` URL. */
  readonly url: string;
  /** The `format()` hint next to the `url()`, when present. */
  readonly format: string | undefined;
  readonly unicodeRange: string | undefined;
  /** Every `@font-face` descriptor except `src`, keyed by lowercase name (`font-family`, `font-weight`, ...). */
  readonly descriptors: Readonly<Record<string, string>>;
}

export type GoogleCssValidation =
  | {readonly ok: true; readonly files: readonly GoogleFontFile[]; readonly classRules: number}
  | {readonly ok: false; readonly message: string};

const FONT_FACE_DESCRIPTORS = new Set([
  "font-family",
  "font-style",
  "font-weight",
  "font-stretch",
  "font-display",
  "font-feature-settings",
  "font-variation-settings",
  "unicode-range",
  "size-adjust",
  "ascent-override",
  "descent-override",
  "line-gap-override"
]);

const CLASS_RULE_PROPERTIES = new Set([
  "line-height",
  "letter-spacing",
  "text-transform",
  "display",
  "white-space",
  "word-wrap",
  "direction",
  "font-feature-settings",
  "-webkit-font-feature-settings",
  "-moz-font-feature-settings",
  "-webkit-font-smoothing",
  "-moz-osx-font-smoothing"
]);

const CLASS_SELECTOR = /^\.[A-Za-z_-][A-Za-z0-9_-]*$/;
const FORBIDDEN_SCHEME = /(?:^|[\s(,'"])(?:data|javascript)\s*:/i;
const SRC_ENTRY = /^url\(\s*(['"]?)([^'"()\s\\]+)\1\s*\)(?:\s+format\(\s*(['"]?)([A-Za-z0-9-]+)\3\s*\))?$/i;

class CssRejection extends Error {}

function reject(message: string): never {
  throw new CssRejection(message);
}

/** Values outside `src` must be plain keywords, numbers and strings: no functions or escapes. */
function assertPlainValue(declaration: Declaration, where: string): void {
  if (FORBIDDEN_SCHEME.test(declaration.value)) {
    reject(`${where}: ${declaration.prop} uses a forbidden data: or javascript: value.`);
  }
  if (/[()\\]/.test(declaration.value)) {
    reject(`${where}: ${declaration.prop} must not contain url(), other functions, or escapes.`);
  }
}

function parseSrc(value: string): {url: string; format: string | undefined}[] {
  if (FORBIDDEN_SCHEME.test(value)) reject("@font-face src uses a forbidden data: or javascript: URL.");
  const entries = value.split(",").map((entry) => entry.trim());
  return entries.map((entry) => {
    const match = SRC_ENTRY.exec(entry);
    if (!match) reject(`@font-face src entry is not url(...) with an optional format(...): ${entry.slice(0, 120)}`);
    const canonical = canonicalGoogleFontsUrl(match[2] ?? "");
    if (!canonical.ok || canonical.kind !== "font") {
      reject(`@font-face src must point to https://fonts.gstatic.com/s/: ${(match[2] ?? "").slice(0, 120)}`);
    }
    return {url: canonical.url, format: match[4]?.toLowerCase()};
  });
}

function onlyDeclarations(nodes: readonly ChildNode[], where: string): Declaration[] {
  const declarations: Declaration[] = [];
  for (const node of nodes) {
    if (node.type === "comment") continue;
    if (node.type !== "decl") reject(`${where} may contain only declarations.`);
    declarations.push(node);
  }
  return declarations;
}

function readFontFace(nodes: readonly ChildNode[]): GoogleFontFile[] {
  const descriptors: Record<string, string> = {};
  let sources: {url: string; format: string | undefined}[] | undefined;
  for (const declaration of onlyDeclarations(nodes, "@font-face")) {
    const prop = declaration.prop.toLowerCase();
    if (prop === "src") {
      if (sources) reject("@font-face declares src more than once.");
      sources = parseSrc(declaration.value);
      continue;
    }
    if (!FONT_FACE_DESCRIPTORS.has(prop)) reject(`@font-face descriptor ${prop} is not allowed.`);
    assertPlainValue(declaration, "@font-face");
    descriptors[prop] = declaration.value;
  }
  if (!sources) reject("@font-face has no src.");
  return sources.map((source) => ({
    url: source.url,
    format: source.format,
    unicodeRange: descriptors["unicode-range"],
    descriptors: {...descriptors}
  }));
}

function checkClassRule(selector: string, nodes: readonly ChildNode[]): void {
  if (!CLASS_SELECTOR.test(selector.trim())) reject(`Rule selector ${selector.slice(0, 80)} is not a single class.`);
  for (const declaration of onlyDeclarations(nodes, `Rule ${selector}`)) {
    const prop = declaration.prop.toLowerCase();
    if (!prop.startsWith("font-") && !CLASS_RULE_PROPERTIES.has(prop)) {
      reject(`Rule ${selector}: property ${prop} is not allowed.`);
    }
    assertPlainValue(declaration, `Rule ${selector}`);
  }
}

/**
 * Validates a stylesheet returned by fonts.googleapis.com and lists the font files it references.
 * Accepts `@font-face` rules whose `src` points only to fonts.gstatic.com `/s/`, plus class rules
 * without `url()` limited to font and text properties (Material Symbols). Rejects `@import`, every
 * other at-rule, `data:`, `javascript:` and any other `url()`.
 */
export function validateGoogleCss(input: string | Uint8Array): GoogleCssValidation {
  const bytes = typeof input === "string" ? Buffer.byteLength(input, "utf8") : input.byteLength;
  if (bytes > GOOGLE_FONTS_MAX_CSS_BYTES) {
    return {ok: false, message: `Google Fonts CSS is ${bytes} bytes; the limit is ${GOOGLE_FONTS_MAX_CSS_BYTES}.`};
  }
  let css: string;
  try {
    css = typeof input === "string" ? input : new TextDecoder("utf-8", {fatal: true}).decode(input);
  } catch {
    return {ok: false, message: "Google Fonts CSS is not valid UTF-8."};
  }
  try {
    const root = postcss.parse(css);
    const files: GoogleFontFile[] = [];
    let classRules = 0;
    for (const node of root.nodes) {
      if (node.type === "comment") continue;
      if (node.type === "atrule") {
        if (node.name.toLowerCase() !== "font-face" || node.params.trim() !== "") {
          reject(`At-rule @${node.name} is not allowed in Google Fonts CSS.`);
        }
        files.push(...readFontFace(node.nodes ?? []));
        continue;
      }
      if (node.type === "rule") {
        checkClassRule(node.selector, node.nodes);
        classRules += 1;
        continue;
      }
      reject(`Unexpected top-level ${node.type} in Google Fonts CSS.`);
    }
    return {ok: true, files, classRules};
  } catch (error) {
    if (error instanceof CssRejection) return {ok: false, message: error.message};
    return {ok: false, message: `Google Fonts CSS could not be parsed: ${error instanceof Error ? error.message : String(error)}`};
  }
}

/** Identifies a font file by its magic bytes; returns undefined for anything else (HTML, JSON, ...). */
export function sniffFont(bytes: Uint8Array): FontFileFormat | undefined {
  if (bytes.byteLength < 4) return undefined;
  const tag = String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0);
  switch (tag) {
    case "wOF2":
      return "woff2";
    case "wOFF":
      return "woff";
    case "OTTO":
      return "otf";
    case "\u0000\u0001\u0000\u0000":
    case "true":
      return "ttf";
    case "ttcf":
      return "ttc";
    default:
      return undefined;
  }
}
