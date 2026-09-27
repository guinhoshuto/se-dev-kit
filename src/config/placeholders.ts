import {parse, type DefaultTreeAdapterMap} from "parse5";
import type {JsonObject, JsonValue} from "../types.js";

/**
 * StreamElements `{{field}}` placeholders. StreamElements replaces them with the raw field value in
 * the widget's HTML, CSS and JS before the page loads (documentation read on 2026-09-26; escaping
 * and missing fields are still to be confirmed on real StreamElements). The Studio does the same in
 * memory: widget files are never rewritten.
 */
const PLACEHOLDER_SOURCE = String.raw`\{\{\s*([\w.-]+)\s*\}\}`;

/** A fresh global pattern; group 1 is the field id. Inner spaces are optional. */
export function placeholderPattern(): RegExp {
  return new RegExp(PLACEHOLDER_SOURCE, "g");
}

export function hasPlaceholder(text: string): boolean {
  return new RegExp(PLACEHOLDER_SOURCE).test(text);
}

/** The raw text a field value becomes. Objects and arrays are JSON; `null` is empty. */
export function placeholderText(value: JsonValue): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "";
  return JSON.stringify(value);
}

export interface PlaceholderSubstitution {
  text: string;
  /** Placeholder ids with no field in `fieldData`, in first-seen order. They stay intact. */
  missing: string[];
}

/**
 * Replaces each `{{name}}` with the raw value of `fieldData[name]` in one pass, so a value that
 * itself contains `{{…}}` is never expanded again. Unknown placeholders stay intact.
 */
export function substitutePlaceholders(text: string, fieldData: JsonObject): PlaceholderSubstitution {
  const missing: string[] = [];
  const substituted = text.replace(placeholderPattern(), (match: string, name: string) => {
    if (!Object.hasOwn(fieldData, name)) {
      if (!missing.includes(name)) missing.push(name);
      return match;
    }
    return placeholderText(fieldData[name] as JsonValue);
  });
  return {text: substituted, missing};
}

export function missingPlaceholderWarning(file: string, missing: readonly string[]): string {
  return `${file} uses ${missing.map((name) => `{{${name}}}`).join(", ")} with no matching field; the placeholder text stays as written.`;
}

type HtmlNode = DefaultTreeAdapterMap["node"];

/**
 * The importer's document-control refusals for one element, or `undefined` when it is allowed.
 * Shared with the checks that run again after substitution, because substituted values never went
 * through the import checks.
 */
export function refusedHtmlElement(tagName: string, attrs: readonly {name: string; value: string}[]): string | undefined {
  if (["base", "iframe", "object", "embed"].includes(tagName) || (tagName === "meta" && attrs.some((attr) => attr.name === "http-equiv"))) {
    return `Unsupported embedded or document-control element: ${tagName}`;
  }
  if (attrs.some((attr) => attr.name.startsWith("on"))) {
    return "Inline HTML event handlers are unsupported. Register listeners in widget JavaScript after runtime initialization.";
  }
  return undefined;
}

/** Every refusal in an HTML document or fragment, one entry per offending element, in document order. */
export function htmlRefusals(html: string): string[] {
  const found: string[] = [];
  const visit = (node: HtmlNode): void => {
    if ("tagName" in node) {
      const reason = refusedHtmlElement(node.tagName, node.attrs);
      if (reason) found.push(reason);
    }
    if ("childNodes" in node) node.childNodes.forEach(visit);
    if ("content" in node) visit(node.content);
  };
  visit(parse(html));
  return found;
}

/**
 * Refusals present after substitution that were not in the source. Source that the host already
 * accepted (the local CLI allows inline handlers) is not judged again; only what values introduced.
 */
export function introducedHtmlRefusals(before: string, after: string): string[] {
  const remaining = htmlRefusals(before);
  const introduced: string[] = [];
  for (const reason of htmlRefusals(after)) {
    const index = remaining.indexOf(reason);
    if (index >= 0) remaining.splice(index, 1);
    else introduced.push(reason);
  }
  return introduced;
}

export function substitutedHtmlError(reasons: readonly string[]): string {
  return `A substituted field value adds content the Studio refuses: ${reasons[0] ?? "unsupported HTML"}. Check the {{field}} values used in the widget HTML.`;
}
