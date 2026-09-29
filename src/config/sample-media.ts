import {createHash} from "node:crypto";
import {readFile, realpath} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {z} from "zod";
import {StudioError, toErrorMessage} from "../shared/errors.js";
import {isInside} from "../shared/paths.js";
import {
  SAMPLE_MEDIA_SCHEME,
  SAMPLE_REFERENCE_PATTERN,
  claimsSampleMediaScheme,
  collectSampleMediaReferences,
  type SampleMediaKind,
  type SampleMediaSummary,
  type SampleMediaTone
} from "../studio-ui/sample-media.js";

export interface SampleMediaEntry {
  id: string;
  reference: string;
  file: string;
  kind: SampleMediaKind;
  contentType: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  label: string;
  alt: string;
  color: string;
  tone?: SampleMediaTone;
  origin: string;
}

/** A verified, immutable view of `sample-media/`. Bytes are read and checked once, then served from memory. */
export interface SampleMediaCatalog {
  root: string;
  items: readonly SampleMediaEntry[];
  entry(reference: string): SampleMediaEntry | undefined;
  entryForFile(file: string): SampleMediaEntry | undefined;
  /** The date the owner retired a reference (its file no longer ships), or undefined for any other reference. */
  retiredOn(reference: string): string | undefined;
  body(reference: string): Buffer;
}

const CONTENT_TYPES: Record<string, string> = {jpg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif"};
const MAX_SAMPLE_BYTES = 3 * 1024 * 1024;

const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    items: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
            reference: z.string().regex(SAMPLE_REFERENCE_PATTERN),
            file: z.string().min(1),
            kind: z.enum(["gallery", "backdrop"]),
            contentType: z.enum(["image/jpeg", "image/png", "image/webp", "image/gif"]),
            width: z.number().int().min(1).max(8192),
            height: z.number().int().min(1).max(8192),
            bytes: z.number().int().min(1).max(MAX_SAMPLE_BYTES),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
            label: z.string().trim().min(1).max(80),
            alt: z.string().trim().min(1).max(400),
            color: z.string().regex(/^#[0-9a-f]{6}$/),
            tone: z.enum(["dark", "medium", "light"]).optional(),
            origin: z.string().trim().min(1).max(400)
          })
          .strict()
      )
      .min(1)
      .max(256),
    retired: z
      .array(
        z
          .object({
            reference: z.string().regex(SAMPLE_REFERENCE_PATTERN),
            retiredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
          })
          .strict()
      )
      .max(1024)
      .optional()
  })
  .strict();

/** The packaged `sample-media/` directory beside `dist/`, resolved lazily so bundlers never evaluate it. */
export function defaultSampleMediaRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../sample-media");
}

function invalid(root: string, detail: string): StudioError {
  return new StudioError(
    "SAMPLE_MEDIA_CATALOG_INVALID",
    `Built-in sample media at ${root} is missing or invalid: ${detail}`,
    "Reinstall or rebuild SE Widget Studio so sample-media/ matches its manifest. Widgets that use no sws-sample: reference are unaffected."
  );
}

async function readCatalog(root: string): Promise<SampleMediaCatalog> {
  let realRoot: string;
  let parsed: z.infer<typeof manifestSchema>;
  try {
    realRoot = await realpath(root);
    const result = manifestSchema.safeParse(JSON.parse(await readFile(resolve(realRoot, "manifest.json"), "utf8")) as unknown);
    if (!result.success) throw new Error(result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
    parsed = result.data;
  } catch (error) {
    throw invalid(root, toErrorMessage(error));
  }
  const byReference = new Map<string, SampleMediaEntry>();
  const byFile = new Map<string, SampleMediaEntry>();
  const bodies = new Map<string, Buffer>();
  const ids = new Set<string>();
  const retired = new Map<string, string>();
  for (const {reference, retiredOn} of parsed.retired ?? []) {
    if (retired.has(reference)) throw invalid(root, `duplicate retired reference ${reference}.`);
    retired.set(reference, retiredOn);
  }
  for (const item of parsed.items) {
    if (item.reference !== `${SAMPLE_MEDIA_SCHEME}${item.file}`) throw invalid(root, `${item.id} reference must equal the scheme plus its file.`);
    if (retired.has(item.reference)) throw invalid(root, `${item.id} reuses the retired reference ${item.reference}.`);
    const extension = item.file.split(".").at(-1) ?? "";
    if (CONTENT_TYPES[extension] !== item.contentType) throw invalid(root, `${item.id} content type does not match ${item.file}.`);
    if (item.kind === "backdrop" && !item.tone) throw invalid(root, `${item.id} is a backdrop without a tone.`);
    if (ids.has(item.id) || byReference.has(item.reference)) throw invalid(root, `duplicate sample ${item.id}.`);
    ids.add(item.id);
    let body: Buffer;
    try {
      const filePath = await realpath(resolve(realRoot, item.file));
      if (!isInside(realRoot, filePath) || filePath !== resolve(realRoot, item.file)) throw new Error("path escapes the catalog");
      body = await readFile(filePath);
    } catch (error) {
      throw invalid(root, `${item.file}: ${toErrorMessage(error)}`);
    }
    if (body.byteLength !== item.bytes || createHash("sha256").update(body).digest("hex") !== item.sha256) {
      throw invalid(root, `${item.file} does not match its recorded size and SHA-256.`);
    }
    const {tone, ...required} = item;
    const entry: SampleMediaEntry = {...required, ...(tone ? {tone} : {})};
    byReference.set(entry.reference, entry);
    byFile.set(entry.file, entry);
    bodies.set(entry.reference, body);
  }
  const items = Object.freeze([...byReference.values()]);
  return {
    root: realRoot,
    items,
    entry: (reference) => byReference.get(reference),
    entryForFile: (file) => byFile.get(file),
    retiredOn: (reference) => retired.get(reference),
    body: (reference) => {
      const body = bodies.get(reference);
      if (!body) throw sampleMediaNotFound(reference, retired.get(reference));
      return body;
    }
  };
}

const catalogs = new Map<string, Promise<SampleMediaCatalog>>();

/** Loads and verifies a catalog once per root. A failed load is not cached, so a repaired install recovers. */
export function loadSampleMediaCatalog(root: string = defaultSampleMediaRoot()): Promise<SampleMediaCatalog> {
  const key = resolve(root);
  let pending = catalogs.get(key);
  if (!pending) {
    pending = readCatalog(key);
    catalogs.set(key, pending);
    pending.catch(() => catalogs.delete(key));
  }
  return pending;
}

/** Opens every unknown-reference error; a retired reference says when it stopped shipping instead. */
export function unknownSampleMediaText(reference: string, retiredOn?: string): string {
  return retiredOn ? `Sample media reference ${reference} was retired on ${retiredOn} and no longer ships` : `Unknown sample media reference: ${reference}`;
}

export function sampleMediaNotFound(reference: string, retiredOn?: string): StudioError {
  return new StudioError(
    "SAMPLE_MEDIA_NOT_FOUND",
    unknownSampleMediaText(reference, retiredOn),
    "Use a reference listed in sample-media/manifest.json, for example sws-sample:gallery/streamer-1.jpg."
  );
}

/** Returns the verified entry for a reference or fails with SAMPLE_MEDIA_NOT_FOUND. */
export function requireSampleMedia(catalog: SampleMediaCatalog, reference: string): SampleMediaEntry {
  const entry = claimsSampleMediaScheme(reference) ? catalog.entry(reference) : undefined;
  if (!entry) throw sampleMediaNotFound(reference, catalog.retiredOn(reference));
  return entry;
}

/** SHA-256 of each referenced sample, keyed by reference and sorted, for provenance and revision pins. */
export async function sampleMediaHashes(value: unknown, root?: string): Promise<Record<string, string>> {
  const references = collectSampleMediaReferences(value).sort();
  if (references.length === 0) return {};
  const catalog = await loadSampleMediaCatalog(root);
  const hashes: Record<string, string> = {};
  for (const reference of references) hashes[reference] = createHash("sha256").update(catalog.body(requireSampleMedia(catalog, reference).reference)).digest("hex");
  return hashes;
}

/** Fails when a saved revision pinned a sample whose bytes differ in this build. */
export async function assertSampleMediaPins(pins: Record<string, string> | undefined, root?: string): Promise<void> {
  const entries = Object.entries(pins ?? {});
  if (entries.length === 0) return;
  const catalog = await loadSampleMediaCatalog(root);
  for (const [reference, sha256] of entries) {
    const entry = catalog.entry(reference);
    if (!entry) throw sampleMediaNotFound(reference, catalog.retiredOn(reference));
    if (entry.sha256 !== sha256) {
      throw new StudioError(
        "SAMPLE_MEDIA_CHANGED",
        `Sample media changed since this revision was saved: ${reference}`,
        "Built-in samples are append-only; restore the matching Studio build or save a new revision that uses a current reference."
      );
    }
  }
}

export function sampleMediaSummaries(catalog: SampleMediaCatalog, frameOrigin?: string): SampleMediaSummary[] {
  return catalog.items.map((item) => ({
    reference: item.reference,
    kind: item.kind,
    label: item.label,
    alt: item.alt,
    width: item.width,
    height: item.height,
    color: item.color,
    ...(item.tone ? {tone: item.tone} : {}),
    ...(frameOrigin ? {url: `${frameOrigin}/__sws/sample/${item.file}`} : {})
  }));
}
