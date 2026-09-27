import type {JsonObject, JsonValue, NormalizedField, StageBackground} from "../types.js";

/**
 * Pure, browser-safe helpers for the built-in sample media. The engine, the local UI,
 * the hosted importer, and the hosted editor share these rules; only type imports are allowed here.
 */
export const SAMPLE_MEDIA_SCHEME = "sws-sample:";
/** A whole JSON string such as `sws-sample:gallery/neon-city.jpg`. Group 1 is the file inside `sample-media/`. */
export const SAMPLE_REFERENCE_PATTERN = /^sws-sample:([a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*\.(?:jpg|png|webp|gif))$/;
export const SAMPLE_MEDIA_ROUTE = "/__sws/sample/";

export type SampleMediaKind = "gallery" | "backdrop";
export type SampleMediaTone = "dark" | "medium" | "light";

/** Public description of one sample; `url` is present only where the host can serve it. */
export interface SampleMediaSummary {
  reference: string;
  kind: SampleMediaKind;
  label: string;
  alt: string;
  width: number;
  height: number;
  color?: string;
  tone?: SampleMediaTone;
  url?: string;
}

export type SampleMediaReference = `sws-sample:${string}`;

export function isSampleMediaReference(value: unknown): value is SampleMediaReference {
  return typeof value === "string" && SAMPLE_REFERENCE_PATTERN.test(value);
}

/** True for any string that claims the scheme, valid or not, so malformed references fail loudly. */
export function claimsSampleMediaScheme(value: unknown): value is SampleMediaReference {
  return typeof value === "string" && value.startsWith(SAMPLE_MEDIA_SCHEME);
}

export function sampleMediaFile(reference: string): string | undefined {
  return SAMPLE_REFERENCE_PATTERN.exec(reference)?.[1];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Every whole string that claims the sample scheme, in first-seen order, without duplicates. */
export function collectSampleMediaReferences(value: unknown): string[] {
  const found = new Set<string>();
  const visit = (input: unknown, depth: number) => {
    if (depth > 64) return;
    if (claimsSampleMediaScheme(input)) found.add(input);
    else if (Array.isArray(input)) for (const item of input) visit(item, depth + 1);
    else if (isPlainObject(input)) for (const item of Object.values(input)) visit(item, depth + 1);
  };
  visit(value, 0);
  return [...found];
}

/** Display text for tutorial replicas and field summaries: a sample shows its file name, never the scheme. */
export function sampleMediaDisplayText(value: string): string {
  const file = sampleMediaFile(value);
  if (file) return file.split("/").at(-1) ?? file;
  if (value.startsWith("[") && value.includes(SAMPLE_MEDIA_SCHEME)) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => (typeof item === "string" ? sampleMediaDisplayText(item) : JSON.stringify(item))).join(", ");
      }
    } catch {
      return value;
    }
  }
  return value;
}

export function isMultipleMediaField(field: Pick<NormalizedField, "definition">): boolean {
  return field.definition.multiple === true;
}

function isEmptyMediaValue(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null || value === "") return true;
  return Array.isArray(value) && value.every((item) => item === "" || item === null);
}

/**
 * Returns only the patch that fills empty `image-input` fields with gallery samples.
 * A single field receives one reference; a `multiple` field receives four. The first
 * image rotates with the order of filled fields, so the result is deterministic.
 */
export function fillEmptyImageFields(
  fields: Pick<NormalizedField, "id" | "type" | "definition">[],
  values: JsonObject,
  galleryReferences: string[]
): JsonObject {
  const references = galleryReferences.filter(isSampleMediaReference);
  const patch: JsonObject = {};
  if (references.length === 0) return patch;
  let filled = 0;
  for (const field of fields) {
    if (field.type !== "image-input" || !isEmptyMediaValue(values[field.id])) continue;
    const start = filled % references.length;
    if (isMultipleMediaField(field)) {
      const count = Math.min(4, references.length);
      patch[field.id] = Array.from({length: count}, (_value, index) => references[(start + index) % references.length]!);
    } else {
      patch[field.id] = references[start]!;
    }
    filled += 1;
  }
  return patch;
}

/** Parses the text of a `multiple` media control. Returns undefined unless it is a JSON array. */
export function parseMediaArrayText(text: string): JsonValue[] | undefined {
  if (text.trim() === "") return [];
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as JsonValue[]) : undefined;
  } catch {
    return undefined;
  }
}

/** Applies a sample choice: single fields are replaced, `multiple` fields append without duplicates. */
export function applySampleChoice(current: JsonValue | undefined, reference: string, multiple: boolean): JsonValue {
  if (!multiple) return reference;
  const list = Array.isArray(current) ? current.filter((item) => item !== "" && item !== null) : [];
  return list.includes(reference) ? list : [...list, reference];
}

/**
 * Browser URL for a background or media value shown by trusted Studio UI. Sample references
 * resolve only through the served catalog; unknown ones return an empty string.
 */
export function browserAssetUrl(value: string, frameOrigin: string, samples: readonly SampleMediaSummary[] = []): string {
  if (claimsSampleMediaScheme(value)) return samples.find((item) => item.reference === value)?.url ?? "";
  if (/^[a-z]+:/i.test(value) || value.startsWith("//")) return value;
  const clean = (value.split(/[?#]/, 1)[0] ?? value).replaceAll("\\", "/").replace(/^\.\//, "");
  const encoded = clean.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return `${frameOrigin}/__sws/widget/${encoded}`;
}

const SAMPLE_BACKGROUND_PREFIX = "sample:";

/** Value of the local stage background select for the current mode and image. */
export function backgroundSelectValue(mode: string, image: string | null, samples: readonly SampleMediaSummary[]): string {
  if (mode === "image" && image && samples.some((item) => item.reference === image)) return `${SAMPLE_BACKGROUND_PREFIX}${image}`;
  return mode;
}

/** Decodes a background select value. Sample options select image mode with that reference. */
export function parseBackgroundSelectValue(
  value: string,
  samples: readonly SampleMediaSummary[]
): {mode: string; image?: string} | undefined {
  if (value.startsWith(SAMPLE_BACKGROUND_PREFIX)) {
    const reference = value.slice(SAMPLE_BACKGROUND_PREFIX.length);
    return samples.some((item) => item.reference === reference) ? {mode: "image", image: reference} : undefined;
  }
  return ["checker", "charcoal", "white", "transparent", "image", "custom"].includes(value) ? {mode: value} : undefined;
}

/**
 * Hosted editor overrides without a selected scene would be written into FIELDS defaults.
 * Sample references never belong there, so those overrides stay temporary preview state.
 */
export function splitFieldOverrides(fieldData: JsonObject, hasScene: boolean): {persist: JsonObject; temporary: JsonObject} {
  if (hasScene) return {persist: fieldData, temporary: {}};
  const persist: JsonObject = {};
  const temporary: JsonObject = {};
  for (const [key, value] of Object.entries(fieldData)) {
    if (collectSampleMediaReferences(value).length > 0) temporary[key] = value;
    else persist[key] = value;
  }
  return {persist, temporary};
}

/** Sets or clears a scene background image; a sample without an opaque color gets its dominant color. */
export function withBackgroundImage(
  background: StageBackground | undefined,
  image: string,
  samples: readonly SampleMediaSummary[]
): StageBackground {
  const {image: _previous, ...rest} = background ?? {id: "background"};
  if (!image) return rest;
  const sample = samples.find((item) => item.reference === image);
  const needsColor = sample?.color !== undefined && (!rest.color || rest.color === "transparent");
  return {...rest, ...(needsColor && sample?.color ? {color: sample.color} : {}), image};
}
