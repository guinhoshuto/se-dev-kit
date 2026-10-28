import {parse, type DefaultTreeAdapterMap} from "parse5";
import type {JsonObject, JsonValue} from "../types.js";

/**
 * StreamElements field placeholders, filled as its overlay fills them (the function that builds a
 * custom widget's frame in `streamelements.com/overlay/assets/index-DmBc-s-l.js`, read on 2026-10-28):
 * in the widget's HTML, CSS and JS, first every `{{name}}`, then, over that result, every `{name}`,
 * where `name` is word characters only (no spaces, dots or dashes) and a key of fieldData. Anything
 * else stays as written. The second pass also fills a `{name}` that a value from the first one
 * brought. The Studio does the same in memory: widget files are never rewritten. Unlike
 * StreamElements, only fieldData's own keys count: its `in` test also takes inherited object keys,
 * such as `{constructor}`.
 */
const DOUBLE_SOURCE = String.raw`\{\{(\w*)\}\}`;
const SINGLE_SOURCE = String.raw`\{(\w*)\}`;

/** Text StreamElements may fill: a `{name}`, alone or inside `{{name}}`. */
export function hasPlaceholder(text: string): boolean {
  return /\{\w+\}/.test(text);
}

/** The raw text a field value becomes, as JavaScript's `String()` makes it: `null` is "null", arrays join with commas. */
export function placeholderText(value: JsonValue): string {
  return String(value);
}

export interface PlaceholderSubstitution {
  text: string;
  /** `{{name}}` ids with no field in `fieldData`, in first-seen order. They stay intact. */
  missing: string[];
}

/**
 * Fills `{{name}}`, then `{name}`, with the raw value of `fieldData[name]`. A `{name}` with no field
 * is not reported: JavaScript and CSS are full of braces around a word.
 */
export function substitutePlaceholders(text: string, fieldData: JsonObject): PlaceholderSubstitution {
  const missing: string[] = [];
  const fill = (match: string, name: string): string => (Object.hasOwn(fieldData, name) ? placeholderText(fieldData[name] as JsonValue) : match);
  const doubled = text.replace(new RegExp(DOUBLE_SOURCE, "g"), (match: string, name: string) => {
    if (name && !Object.hasOwn(fieldData, name) && !missing.includes(name)) missing.push(name);
    return fill(match, name);
  });
  return {text: doubled.replace(new RegExp(SINGLE_SOURCE, "g"), fill), missing};
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
