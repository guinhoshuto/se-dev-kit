import type {FontReport} from "../types.js";
import {StudioError} from "../shared/errors.js";
import {canonicalGoogleFontsUrl, familiesFromUrl} from "../runtime/google-fonts-url.js";
import type {FontRequestIssue} from "./browser.js";

const LOCAL_HINT =
  "The local CLI blocks Google Fonts. Validate widgets that use them in the hosted Studio, which serves them from its font cache; never vendor the font or edit the widget for it.";

/** Families a Google Fonts URL stands for: those a stylesheet requests, or the family folder of a font file. */
function familyNames(url: string): string[] {
  const names = familiesFromUrl(url).map((family) => family.name).filter(Boolean);
  if (names.length > 0) return names;
  try {
    const parsed = new URL(url);
    if (parsed.pathname.startsWith("/s/")) return [parsed.pathname.split("/")[2] ?? ""].filter(Boolean);
  } catch {
    // Not a URL; nothing to name.
  }
  return [];
}

function describe(url: string): string {
  const names = familyNames(url);
  return names.length > 0 ? `${names.map((name) => `"${name}"`).join(", ")} (${url})` : url;
}

function normalized(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

function isStylesheetUrl(url: string): boolean {
  try {
    return new URL(url).hostname === "fonts.googleapis.com";
  } catch {
    return false;
  }
}

/** Google refused the request, as it would in StreamElements: the text stays in fallback. */
function isRefusal(status: number | undefined): boolean {
  return status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

export interface FontCheck {
  /** Google refused a family (a 4xx, or a request Google would refuse, such as an unfilled placeholder). */
  warnings: string[];
}

/**
 * Turns the Google Fonts requests that failed in a capture, and the stylesheets the frame saw
 * fail, into the font codes. `/icon`, `text=` and URLs outside the allowlist fail with
 * FONT_UNSUPPORTED, because the Studio can never serve them; a font that is needed and cannot
 * be served fails with FONT_UNAVAILABLE; a family Google refuses is only a warning.
 */
export function checkFonts(
  issues: readonly FontRequestIssue[],
  report?: FontReport,
  options: {
    /** URLs a discovery pass is collecting (outside the job's font package); they fail nothing here. */
    ignore?: (url: string) => boolean;
  } = {}
): FontCheck {
  const failures = new Map<string, FontRequestIssue>();
  const referenced = report?.referencedStylesheets ? new Set(report.referencedStylesheets.map(normalized)) : undefined;
  for (const issue of issues) {
    // The widget dropped the stylesheet (its link now points elsewhere): not a font it uses.
    if (issue.aborted && referenced && isStylesheetUrl(issue.url) && !referenced.has(normalized(issue.url))) continue;
    const known = failures.get(issue.url);
    if (!known || (known.status === undefined && issue.status !== undefined)) failures.set(issue.url, issue);
  }
  for (const stylesheet of report?.failedStylesheets ?? []) {
    let url = stylesheet.href;
    try {
      url = new URL(stylesheet.href).href;
    } catch {
      // Keep the frame's value.
    }
    if (!failures.has(url)) failures.set(url, {url, detail: stylesheet.reason});
  }
  const warnings: string[] = [];
  const unavailable: string[] = [];
  for (const failure of failures.values()) {
    if (options.ignore?.(failure.url)) continue;
    const canonical = canonicalGoogleFontsUrl(failure.url);
    if (!canonical.ok && canonical.code === "FONT_UNSUPPORTED") {
      throw new StudioError(
        "FONT_UNSUPPORTED",
        `Google Fonts URL is not supported: ${failure.url}. ${canonical.message}`,
        "The Studio serves only fonts.googleapis.com /css and /css2 and fonts.gstatic.com /s/ files; /icon and text= requests are outside that list."
      );
    }
    if (isRefusal(failure.status) || (!canonical.ok && canonical.code === "FONT_BAD_REQUEST")) {
      warnings.push(`upstream-4xx: Google Fonts refused ${describe(failure.url)}${failure.status ? ` with HTTP ${failure.status}` : `: ${canonical.ok ? failure.detail : canonical.message}`}; the text stays in fallback, as in StreamElements.`);
      continue;
    }
    unavailable.push(`${describe(failure.url)}: ${failure.detail}`);
  }
  if (unavailable.length > 0) {
    throw new StudioError("FONT_UNAVAILABLE", `Google Fonts could not be loaded: ${unavailable.join("; ")}.`, LOCAL_HINT);
  }
  return {warnings};
}
