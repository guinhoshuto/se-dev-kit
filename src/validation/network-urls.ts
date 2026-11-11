import type {Diagnostic, ResolvedProject} from "../types.js";
import {isGoogleFontsHost} from "../runtime/google-fonts-url.js";

// A whole value that is one http(s) URL; a link inside a longer text is shown as text and requests nothing.
const NETWORK_URL_PATTERN = /^https?:\/\/\S+$/i;
const LISTED_ENTRIES_MAX = 5;

const NETWORK_URL_HINT =
  "Runtime network is blocked: a widget that loads one of these fails the video render with VIDEO_RUNTIME_ERROR, even after the test run passed. Use a sws-sample: reference or a widget file instead.";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** True for a URL that jobs and renders answer from the font route; a value `new URL` cannot parse is not exempt. */
function isAnsweredByFontRoute(url: string): boolean {
  try {
    return isGoogleFontsHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Every whole string that is an http(s) URL outside the Google Fonts hosts, trimmed, in first-seen order, without duplicates. */
export function collectNetworkUrls(value: unknown): string[] {
  const found: string[] = [];
  const visit = (input: unknown, depth: number) => {
    if (depth > 64) return;
    if (typeof input === "string") {
      const url = input.trim();
      if (!NETWORK_URL_PATTERN.test(url) || isAnsweredByFontRoute(url)) return;
      if (!found.includes(url)) found.push(url);
    } else if (Array.isArray(input)) for (const item of input) visit(item, depth + 1);
    else if (isPlainObject(input)) for (const item of Object.values(input)) visit(item, depth + 1);
  };
  visit(value, 0);
  return found;
}

/** Warns once about the external http(s) URLs in the catalog test data: runtime network is blocked. */
export function networkUrlDiagnostics(project: ResolvedProject): Diagnostic[] {
  // FIELDS defaults are production source and stay out: a theme that overrides the field could not silence them.
  const sources: [string, unknown][] = [
    ["channel", project.config.channel ?? {}],
    ...project.themes.map((item): [string, unknown] => [`theme "${item.id}"`, item.value]),
    ...project.fixtures.map((item): [string, unknown] => [`fixture "${item.id}"`, item.value]),
    ...project.scenes.map((item): [string, unknown] => [`scene "${item.id}"`, item.value]),
    ...project.scenarios.map((item): [string, unknown] => [`scenario "${item.id}"`, item.value]),
    ...project.recipes.map((item): [string, unknown] => [`recipe "${item.id}"`, item.value])
  ];
  const entries = sources.flatMap(([label, value]) => collectNetworkUrls(value).map((url) => `${label} uses ${url}`));
  if (entries.length === 0) return [];
  const listed = entries.slice(0, LISTED_ENTRIES_MAX);
  const leftOut = entries.length - listed.length;
  return [
    {
      status: "warning",
      code: "FIXTURE_NETWORK_URL",
      detail: `External URLs in test data: ${listed.join("; ")}${leftOut > 0 ? `; and ${leftOut} more` : ""}.`,
      hint: NETWORK_URL_HINT
    }
  ];
}
