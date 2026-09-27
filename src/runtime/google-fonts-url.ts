// Google Fonts URL rules shared by the frame runtime (browser) and the engine and web server (Node).
// This module is served to the widget frame, so it must stay free of Node APIs and its only
// allowed runtime import is ../version.js. It never performs network requests.

/** User-Agent sent upstream: current stable Chrome on Windows, as in the OBS browser source. */
export const GOOGLE_FONTS_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";
/** Bumping the epoch starts a new cache namespace; old entries stay readable for old revisions. */
export const FONT_CACHE_EPOCH = "v1";
export const GOOGLE_FONTS_MAX_URL_LENGTH = 2048;
export const GOOGLE_FONTS_MAX_FAMILIES = 20;
export const GOOGLE_FONTS_MAX_CSS_BYTES = 1024 * 1024;
/** Kept under the Function response limit acknowledged by the artifact download route. */
export const GOOGLE_FONTS_MAX_FONT_BYTES = 4 * 1024 * 1024;

export const GOOGLE_FONTS_CSS_HOST = "fonts.googleapis.com";
export const GOOGLE_FONTS_FILE_HOST = "fonts.gstatic.com";

export type GoogleFontsUrlKind = "css" | "font";

/**
 * `FONT_UNSUPPORTED`: outside the decided allowlist or the Studio's limits.
 * `FONT_BAD_REQUEST`: a request Google would refuse with 400 (for example an unresolved
 * `{{field}}` placeholder). It is answered locally with status 400 and never reaches upstream.
 */
export type GoogleFontsUrlErrorCode = "FONT_UNSUPPORTED" | "FONT_BAD_REQUEST";

export type GoogleFontsUrlRejectReason =
  | "parse"
  | "length"
  | "scheme"
  | "credentials"
  | "port"
  | "host"
  | "path"
  | "icon"
  | "text"
  | "query"
  | "families"
  | "family-missing"
  | "placeholder";

export interface GoogleFontsUrlAccepted {
  readonly ok: true;
  readonly kind: GoogleFontsUrlKind;
  /** Deterministic HTTPS form used as the cache key and as the only URL ever fetched upstream. */
  readonly url: string;
  /** Query parameters (and a fragment, as `#`) removed during canonicalization, in input order. */
  readonly dropped: readonly string[];
}

export interface GoogleFontsUrlRejected {
  readonly ok: false;
  readonly code: GoogleFontsUrlErrorCode;
  readonly reason: GoogleFontsUrlRejectReason;
  /** Present for `FONT_BAD_REQUEST`: the status to record as if upstream had answered. */
  readonly status?: 400;
  readonly message: string;
}

export type GoogleFontsUrlResult = GoogleFontsUrlAccepted | GoogleFontsUrlRejected;

export type OriginRuleVerdict =
  | {readonly ok: true; readonly url: string; readonly dropped: readonly string[]}
  | GoogleFontsUrlRejected;

/**
 * Generic rule for a trusted external origin. Google Fonts is the only user today; other
 * origins (emote or script CDNs) can be added later as further rules, not as a second mechanism.
 */
export interface OriginRule<Kind extends string = string> {
  readonly host: string;
  readonly pathPattern: RegExp;
  readonly kind: Kind;
  /** Called only for URLs whose host and path already match; scheme, port and credentials are checked before. */
  validate(url: URL): OriginRuleVerdict;
}

const GSTATIC_PATH = /^\/s\/[a-z0-9]+\/v[0-9]+\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.(?:woff2|woff|ttf|otf)$/;
const KEPT_CSS_PARAMETERS = ["display", "subset"] as const;

function unsupported(reason: GoogleFontsUrlRejectReason, message: string): GoogleFontsUrlRejected {
  return {ok: false, code: "FONT_UNSUPPORTED", reason, message};
}

function badRequest(reason: GoogleFontsUrlRejectReason, message: string): GoogleFontsUrlRejected {
  return {ok: false, code: "FONT_BAD_REQUEST", reason, status: 400, message};
}

/** Encodes a query value with a fixed, readable set of literal characters. */
function encodeQueryValue(value: string): string {
  return encodeURIComponent(value)
    .replace(/%20/g, "+")
    .replace(/%3A/gi, ":")
    .replace(/%2C/gi, ",")
    .replace(/%40/gi, "@")
    .replace(/%3B/gi, ";")
    .replace(/%7C/gi, "|");
}

function familyEntries(pathname: string, values: readonly string[]): string[] {
  const entries: string[] = [];
  for (const value of values) {
    const parts = pathname === "/css" ? value.split("|") : [value];
    for (const part of parts) {
      if (part.trim() !== "") entries.push(part.trim());
    }
  }
  return entries;
}

function validateCssUrl(url: URL): OriginRuleVerdict {
  const dropped: string[] = [];
  const families: string[] = [];
  const kept = new Map<string, string>();
  for (const [name, value] of url.searchParams) {
    if (name === "text") {
      return unsupported("text", "Google Fonts text= subsets are not supported; request the whole family instead.");
    }
    if (name === "family") {
      families.push(value);
    } else if ((KEPT_CSS_PARAMETERS as readonly string[]).includes(name) && !kept.has(name)) {
      kept.set(name, value);
    } else {
      dropped.push(name);
    }
  }
  if (families.some((family) => family.includes("{{"))) {
    return badRequest(
      "placeholder",
      "The Google Fonts family still contains an unresolved {{field}} placeholder; it was not sent to Google."
    );
  }
  const entries = familyEntries(url.pathname, families);
  if (entries.length === 0) {
    return badRequest("family-missing", "The Google Fonts URL does not name a family.");
  }
  if (entries.length > GOOGLE_FONTS_MAX_FAMILIES) {
    return unsupported(
      "families",
      `The Google Fonts URL requests ${entries.length} families; the limit is ${GOOGLE_FONTS_MAX_FAMILIES}.`
    );
  }
  const query = families.map((family) => `family=${encodeQueryValue(family)}`);
  for (const name of KEPT_CSS_PARAMETERS) {
    const value = kept.get(name);
    if (value !== undefined) query.push(`${name}=${encodeQueryValue(value)}`);
  }
  return {ok: true, url: `https://${GOOGLE_FONTS_CSS_HOST}${url.pathname}?${query.join("&")}`, dropped};
}

function validateFontFileUrl(url: URL): OriginRuleVerdict {
  if (url.search !== "") {
    return unsupported("query", "Google Fonts file URLs must not carry a query string.");
  }
  return {ok: true, url: `https://${GOOGLE_FONTS_FILE_HOST}${url.pathname}`, dropped: []};
}

export const GOOGLE_FONTS_ORIGIN_RULES: readonly OriginRule<GoogleFontsUrlKind>[] = [
  {host: GOOGLE_FONTS_CSS_HOST, pathPattern: /^\/css2?$/, kind: "css", validate: validateCssUrl},
  {host: GOOGLE_FONTS_FILE_HOST, pathPattern: GSTATIC_PATH, kind: "font", validate: validateFontFileUrl}
];

/** Returns the first rule whose host matches exactly and whose path pattern matches. */
export function matchOriginRule<Kind extends string>(
  rules: readonly OriginRule<Kind>[],
  url: URL
): OriginRule<Kind> | undefined {
  return rules.find((rule) => rule.host === url.hostname && rule.pathPattern.test(url.pathname));
}

/** True when the hostname is one of the Google Fonts hosts, whatever the path. */
export function isGoogleFontsHost(hostname: string): boolean {
  return GOOGLE_FONTS_ORIGIN_RULES.some((rule) => rule.host === hostname);
}

function pathRejection(url: URL): GoogleFontsUrlRejected {
  if (url.hostname === GOOGLE_FONTS_CSS_HOST && /^\/icon\/?$/.test(url.pathname)) {
    return unsupported("icon", "The Google Fonts /icon endpoint is not supported; use Material Symbols through /css2.");
  }
  if (url.hostname === GOOGLE_FONTS_FILE_HOST && url.pathname.startsWith("/l/")) {
    return unsupported("text", "Google Fonts text= subset files (/l/) are not supported; request the whole family instead.");
  }
  if (url.hostname === GOOGLE_FONTS_CSS_HOST) {
    return unsupported("path", `Only /css and /css2 are allowed on ${GOOGLE_FONTS_CSS_HOST}, not ${url.pathname}.`);
  }
  return unsupported(
    "path",
    `Only /s/<family>/v<N>/<file>.(woff2|woff|ttf|otf) is allowed on ${GOOGLE_FONTS_FILE_HOST}, not ${url.pathname}.`
  );
}

/**
 * Canonicalizes a Google Fonts stylesheet or font file URL and applies the allowlist.
 * `http:` and protocol-relative URLs are promoted to HTTPS, because StreamElements pages are HTTPS.
 */
export function canonicalGoogleFontsUrl(input: string): GoogleFontsUrlResult {
  const raw = input.trim();
  if (raw.length > GOOGLE_FONTS_MAX_URL_LENGTH) {
    return unsupported("length", `Google Fonts URLs are limited to ${GOOGLE_FONTS_MAX_URL_LENGTH} characters.`);
  }
  let url: URL;
  try {
    url = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
  } catch {
    return unsupported("parse", "The Google Fonts URL could not be parsed as an absolute URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return unsupported("scheme", `Google Fonts URLs must use HTTPS, not ${url.protocol}`);
  }
  if (url.username !== "" || url.password !== "") {
    return unsupported("credentials", "Google Fonts URLs must not carry credentials.");
  }
  if (url.port !== "" && url.port !== "443") {
    return unsupported("port", `Google Fonts URLs must use port 443, not ${url.port}.`);
  }
  if (!isGoogleFontsHost(url.hostname)) {
    return unsupported("host", `${url.hostname} is not an allowed Google Fonts host.`);
  }
  const rule = matchOriginRule(GOOGLE_FONTS_ORIGIN_RULES, url);
  if (!rule) return pathRejection(url);
  const verdict = rule.validate(url);
  if (!verdict.ok) return verdict;
  const dropped = url.hash !== "" ? [...verdict.dropped, "#"] : verdict.dropped;
  return {ok: true, kind: rule.kind, url: verdict.url, dropped};
}

export interface GoogleFontVariant {
  readonly italic: boolean;
  /** Inclusive weight range; a single weight has equal bounds. */
  readonly weight: readonly [number, number];
}

export interface GoogleFontFamily {
  readonly name: string;
  /** Axis tags named in a css2 request, in request order (for example `["opsz", "wght"]`). */
  readonly axes: readonly string[];
  readonly variants: readonly GoogleFontVariant[];
}

const DEFAULT_VARIANT: GoogleFontVariant = {italic: false, weight: [400, 400]};

function parseWeight(value: string | undefined): readonly [number, number] | undefined {
  if (value === undefined || value === "") return [400, 400];
  const range = /^(\d{1,4}(?:\.\d+)?)\.\.(\d{1,4}(?:\.\d+)?)$/.exec(value);
  if (range) return [Number(range[1]), Number(range[2])];
  if (/^\d{1,4}(?:\.\d+)?$/.test(value)) return [Number(value), Number(value)];
  return undefined;
}

function parseV1Variant(token: string): GoogleFontVariant | undefined {
  let rest = token.trim().toLowerCase();
  let italic = false;
  if (rest.endsWith("italic")) {
    italic = true;
    rest = rest.slice(0, -"italic".length);
  } else if (rest.endsWith("i")) {
    italic = true;
    rest = rest.slice(0, -1);
  }
  if (rest === "" || rest === "regular") return {italic, weight: [400, 400]};
  if (rest === "bold" || rest === "b") return {italic, weight: [700, 700]};
  if (/^\d{1,4}$/.test(rest)) return {italic, weight: [Number(rest), Number(rest)]};
  return undefined;
}

function parseV1Family(entry: string): GoogleFontFamily {
  const [name = "", spec] = entry.split(":");
  const variants = (spec ?? "")
    .split(",")
    .filter((token) => token.trim() !== "")
    .map(parseV1Variant)
    .filter((variant): variant is GoogleFontVariant => variant !== undefined);
  return {name: name.trim(), axes: [], variants: variants.length > 0 ? variants : [DEFAULT_VARIANT]};
}

function parseCss2Family(entry: string): GoogleFontFamily {
  const colon = entry.indexOf(":");
  const name = (colon === -1 ? entry : entry.slice(0, colon)).trim();
  const spec = colon === -1 ? "" : entry.slice(colon + 1);
  const at = spec.indexOf("@");
  if (at === -1) return {name, axes: [], variants: [DEFAULT_VARIANT]};
  const axes = spec.slice(0, at).split(",").map((axis) => axis.trim());
  const variants: GoogleFontVariant[] = [];
  for (const tuple of spec.slice(at + 1).split(";")) {
    if (tuple.trim() === "") continue;
    const values = tuple.split(",").map((value) => value.trim());
    const italValue = values[axes.indexOf("ital")];
    const weight = parseWeight(axes.includes("wght") ? values[axes.indexOf("wght")] : undefined);
    if (!weight) continue;
    const italics = italValue === undefined ? [false] : italValue === "0..1" ? [false, true] : [italValue === "1"];
    for (const italic of italics) variants.push({italic, weight});
  }
  return {name, axes, variants: variants.length > 0 ? variants : [DEFAULT_VARIANT]};
}

/**
 * Lists the families and variants a Google Fonts stylesheet URL requests, so the frame can
 * preload them. Understands v1 (`/css`, `|` or `%7C` separators, comma-separated weights) and
 * css2 (repeated `family=`, axes such as `wght`, `ital,wght` and `opsz,wght`, `a..b` ranges).
 * Returns an empty list for anything that is not an accepted Google Fonts stylesheet URL.
 */
export function familiesFromUrl(input: string): GoogleFontFamily[] {
  const canonical = canonicalGoogleFontsUrl(input);
  if (!canonical.ok || canonical.kind !== "css") return [];
  const url = new URL(canonical.url);
  const entries = familyEntries(url.pathname, url.searchParams.getAll("family"));
  return entries.map((entry) => (url.pathname === "/css" ? parseV1Family(entry) : parseCss2Family(entry)));
}
