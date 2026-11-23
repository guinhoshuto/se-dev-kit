import {lstat, mkdir, readdir, readFile, realpath, stat, writeFile} from "node:fs/promises";
import {basename, dirname, join, relative, resolve, sep} from "node:path";
import type {JsonObject} from "../types.js";
import {StudioError} from "../shared/errors.js";
import {isInside} from "../shared/paths.js";
import {findExecutable} from "../validation/tools.js";
import {atomicWriteFile} from "./output.js";
import {encodePng} from "./png.js";
import {
  composeSheet,
  decodeVideo,
  MAX_SHEET_CELLS,
  probeVideo,
  reviewMediaItems,
  secondsLabel,
  sheetCellCount,
  sheetFrames,
  sheetStepFor,
  type VideoProbe,
  VIDEO_EXTENSIONS
} from "./review-media.js";

/**
 * Review codes: a short, quotable caption for each file a render writes ("LT-03 is too dark"), on the
 * contact sheet and on the review page. The tag comes from the recipe id and the number from the recipe's
 * variant order, so rendering the same recipe again gives every file the same code.
 */

/** `trail` and `sheet` are images the review page derives from a video (`review --trails`, `review --sheet`). */
export type ReviewKind = "screenshot" | "video" | "still" | "thumbnail" | "contactSheet" | "trail" | "sheet";

export interface ReviewItem {
  /** `LT-03`: the recipe's tag and the file's place in review order. */
  code: string;
  kind: ReviewKind;
  /** Path relative to the render's output root, as the manifest writes it. */
  file: string;
  /** The variant the file belongs to; absent for the contact sheet. */
  variant?: string;
  /** A still's step name. */
  name?: string;
  /** A trail's or sheet's source: the video's code. */
  source?: string;
  /** A trail's step: every n-th frame. */
  every?: number;
  /** A sheet's step, in seconds. */
  step?: number;
  /** Where a trail or sheet is written, beside the page; `file` is then its video's manifest path. */
  path?: string;
}

/** What `reviewItems` reads from a manifest entry. */
export interface ReviewEntry {
  id: string;
  screenshot?: string | null;
  thumbnail?: string | null;
  video?: string | null;
  stills?: {name: string; file: {file: string}}[];
}

/**
 * The initials of each recipe id (`listing-tutorial` → `LT`, `listingTutorial` → `LT`), in the widget's recipe
 * order; a repeated tag gets a digit (`C`, `C2`). A tag another recipe already has (`cover`, `c`, `cover-2`: `C`,
 * `C2`, and `C2` again) goes to the first one, and the later one gets the tag without its digits and the lowest digit
 * from 2 that no recipe has (`C3`), as the review page renames it; every other tag stays as the count gives it. A tag
 * stays put while the recipes keep their ids and order.
 */
export function reviewTags(recipeIds: readonly string[]): Map<string, string> {
  const tags = new Map<string, string>();
  const seen = new Map<string, number>();
  for (const id of recipeIds) {
    if (tags.has(id)) continue;
    const words = id.replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, "$1 $2").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const initials = words.map((word) => [...word][0]!.toUpperCase()).join("") || "R";
    const count = (seen.get(initials) ?? 0) + 1;
    seen.set(initials, count);
    tags.set(id, count === 1 ? initials : `${initials}${count}`);
  }
  const taken = new Set(tags.values());
  const given = new Set<string>();
  for (const [id, tag] of tags) {
    if (given.has(tag)) tags.set(id, freeTag(tag, taken));
    else given.add(tag);
  }
  return tags;
}

/**
 * A render's files in review order, each under a code: screenshots first, so the contact sheet's cells are
 * 01 to n, then videos, stills (in step order), thumbnails, and the contact sheet. Inside each kind the files
 * follow the variant order. Numbers have two digits, or more when a render has over 99 files.
 */
export function reviewItems(tag: string, entries: readonly ReviewEntry[], contactSheet?: string | null): ReviewItem[] {
  const files: Omit<ReviewItem, "code">[] = [];
  for (const entry of entries) if (entry.screenshot) files.push({kind: "screenshot", file: entry.screenshot, variant: entry.id});
  for (const entry of entries) if (entry.video) files.push({kind: "video", file: entry.video, variant: entry.id});
  for (const entry of entries) {
    for (const still of entry.stills ?? []) files.push({kind: "still", file: still.file.file, variant: entry.id, name: still.name});
  }
  for (const entry of entries) if (entry.thumbnail) files.push({kind: "thumbnail", file: entry.thumbnail, variant: entry.id});
  if (contactSheet) files.push({kind: "contactSheet", file: contactSheet});
  const width = Math.max(2, String(files.length).length);
  return files.map((item, index) => ({code: `${tag}-${String(index + 1).padStart(width, "0")}`, ...item}));
}

/** The caption under a file: its code, then what it shows. */
export function reviewCaption(item: ReviewItem): string {
  if (item.kind === "trail" || item.kind === "sheet") {
    const step = item.kind === "trail"
      ? `every ${item.every === 1 ? "" : `${ordinal(item.every!)} `}frame`
      : `every ${item.step} s`;
    return `${item.code} · ${item.variant} · ${item.kind} of ${item.source}, ${step}`;
  }
  const what = item.kind === "contactSheet"
    ? "contact sheet"
    : `${item.variant} · ${item.kind === "still" ? `still ${item.name}` : item.kind}`;
  return `${item.code} · ${what}`;
}

function ordinal(value: number): string {
  const suffix = value % 100 >= 11 && value % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][value % 10] ?? "th");
  return `${value}${suffix}`;
}

export interface ReviewSection {
  tag: string;
  recipe: string;
  /** The recipe folder, which holds manifest.json. */
  directory: string;
  /** The folder the manifest's paths are relative to. */
  outputRoot: string;
  generatedAt: string | null;
  items: ReviewItem[];
  /**
   * The tag the manifest records, when the page gave the section another one because a different recipe recorded
   * it first; its contact sheet still captions the recorded codes.
   */
  recordedTag?: string;
  /**
   * A job folder's downloaded file for each manifest path (`listing-tutorial/a.png` → `<job>/001-a.png`); a recipe
   * folder has none, and its files sit at their manifest paths under `outputRoot`.
   */
  files?: ReadonlyMap<string, string>;
}

const MANIFEST = "manifest.json";
/** The report `studio-client.mjs run` writes beside the artifacts it downloads, each as `<NNN>-<basename>`. */
const JOB = "job.json";
const JOB_FILE = /^\d{3}-[a-zA-Z0-9._-]{1,120}$/;
const RERUN_HINT = "Run the job again with the current studio-client.mjs, whose job.json records each file's path in the job, and review that folder.";

/** Where a review item's file is on disk. */
export function reviewItemPath(section: ReviewSection, item: ReviewItem): string {
  return item.path ?? section.files?.get(item.file) ?? join(section.outputRoot, item.file);
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

async function readSection(directory: string): Promise<ReviewSection> {
  return {...(await readManifest(join(directory, MANIFEST))), directory, outputRoot: dirname(directory)};
}

async function readManifest(path: string): Promise<Omit<ReviewSection, "directory" | "outputRoot">> {
  let manifest: JsonObject;
  try {
    manifest = JSON.parse(await readFile(path, "utf8")) as JsonObject;
  } catch (error) {
    throw new StudioError("REVIEW_MANIFEST_INVALID", `Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const recipe = asObject(manifest.recipe)?.id;
  if (typeof recipe !== "string" || !Array.isArray(manifest.artifacts)) {
    throw new StudioError("REVIEW_MANIFEST_INVALID", `${path} is not a render manifest: it has no recipe id or artifacts.`);
  }
  const review = asObject(manifest.review);
  const recorded = Array.isArray(review?.items) && typeof review?.tag === "string";
  // Manifests written before review codes get the same codes, computed from the recipe id alone.
  const tag = recorded ? (review!.tag as string) : reviewTags([recipe]).get(recipe)!;
  const items = recorded
    ? (review!.items as unknown as ReviewItem[])
    : reviewItems(tag, manifest.artifacts as unknown as ReviewEntry[], asObject(manifest.contactSheet)?.file as string | undefined);
  return {tag, recipe, generatedAt: typeof manifest.generatedAt === "string" ? manifest.generatedAt : null, items};
}

/** The name `run` gives a downloaded artifact, without its `<NNN>-` prefix: the path's basename, made safe. */
function downloadedBasename(path: string): string {
  return basename(path).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "artifact";
}

/**
 * The sections of a job folder that `studio-client.mjs run` wrote: one per render manifest it downloaded, each
 * manifest path matched to its downloaded file by the artifact's `name` in job.json. A folder from an older client
 * has no names: a path then matches the one artifact with its basename, and an ambiguous or absent one is refused.
 * Test reports and other JSON files are not render manifests and stay out.
 */
async function readJobSections(directory: string): Promise<ReviewSection[]> {
  const path = join(directory, JOB);
  let job: JsonObject | undefined;
  try {
    job = asObject(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    throw new StudioError("REVIEW_JOB_INVALID", `Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const artifacts = Array.isArray(job?.artifacts) ? job.artifacts.map(asObject) : [];
  if (job?.schemaVersion !== 1 || !Array.isArray(job.artifacts) || artifacts.some((entry) => typeof entry?.file !== "string" || !JOB_FILE.test(entry.file) || (entry.name !== undefined && typeof entry.name !== "string"))) {
    throw new StudioError("REVIEW_JOB_INVALID", `${path} is not the job report of studio-client.mjs run.`);
  }
  const entries = artifacts.map((entry) => ({file: entry!.file as string, name: entry!.name as string | undefined}));
  const named = entries.every((entry) => entry.name !== undefined);
  const manifests = named
    ? entries.filter((entry) => basename(entry.name!) === MANIFEST)
    : entries.filter((entry) => entry.file.slice(4) === MANIFEST);
  if (manifests.length === 0) {
    throw new StudioError("REVIEW_FOLDER_EMPTY", `${path} lists no render manifest.`, "A test job has none; review the folder of a render job.");
  }
  const sections: ReviewSection[] = [];
  for (const manifest of manifests) {
    const section = await readManifest(join(directory, manifest.file));
    const files = new Map<string, string>();
    for (const item of section.items) {
      if (named) {
        const match = entries.find((entry) => entry.name === item.file);
        if (match) files.set(item.file, join(directory, match.file));
        continue;
      }
      const matches = entries.filter((entry) => entry.file.slice(4) === downloadedBasename(item.file));
      if (matches.length !== 1) {
        throw new StudioError(
          matches.length === 0 ? "REVIEW_JOB_FILE_MISSING" : "REVIEW_JOB_AMBIGUOUS",
          matches.length === 0
            ? `${item.code} (${item.file}) has no downloaded file in ${directory}, and its job.json does not name the files.`
            : `${item.code} (${item.file}) could be any of ${matches.map((entry) => entry.file).join(", ")} in ${directory}: its job.json does not name the files.`,
          RERUN_HINT
        );
      }
      files.set(item.file, join(directory, matches[0]!.file));
    }
    sections.push({...section, directory, outputRoot: directory, files});
  }
  return sections;
}

/**
 * One section per recipe folder: a folder that holds manifest.json, or each subfolder that does, by name. A job
 * folder of `studio-client.mjs run` (job.json) gives one section per render manifest it downloaded.
 * Sections of the same recipe may share a tag (two rounds of one recipe); different recipes may not, so the page
 * renames a later one (`pageTags`).
 */
export async function reviewSections(folders: readonly string[]): Promise<ReviewSection[]> {
  const sections: ReviewSection[] = [];
  const read = async (directory: string) => (await exists(join(directory, MANIFEST)) ? [await readSection(directory)] : readJobSections(directory));
  for (const folder of folders) {
    const directory = resolve(folder);
    if ((await exists(join(directory, MANIFEST))) || (await exists(join(directory, JOB)))) {
      sections.push(...(await read(directory)));
      continue;
    }
    const children = await readdir(directory, {withFileTypes: true}).catch(() => {
      throw new StudioError("REVIEW_FOLDER_NOT_FOUND", `Review folder not found: ${folder}`);
    });
    const found: string[] = [];
    for (const child of children.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()) {
      if ((await exists(join(directory, child, MANIFEST))) || (await exists(join(directory, child, JOB)))) found.push(join(directory, child));
    }
    if (found.length === 0) {
      throw new StudioError(
        "REVIEW_FOLDER_EMPTY",
        `${folder} has no ${MANIFEST} or ${JOB}, and no folder inside it has one.`,
        "Pass a recipe folder written by render, capture, or record, the output folder of studio-client.mjs run, or a folder that holds them."
      );
    }
    for (const child of found) sections.push(...(await read(child)));
  }
  return pageTags(sections);
}

/**
 * One tag per recipe on the page. A section keeps the tag its manifest records unless a different recipe recorded
 * it first (`vitrine-cover` and `vitrine-config`, both `VC`, rendered apart); then it gets the recorded tag without
 * its trailing digits and the lowest digit from 2 that no section records and no section was given (`VC2`), and its
 * codes follow. Rounds of one recipe share their tag, and tags stay put while the folders hold the same recipes in
 * the same order.
 */
function pageTags(sections: readonly ReviewSection[]): ReviewSection[] {
  const taken = new Set(sections.map((section) => section.tag));
  const owners = new Map<string, ReviewSection>();
  const given = new Map<string, string>();
  return sections.map((section) => {
    const owner = owners.get(section.tag) ?? section;
    owners.set(section.tag, owner);
    if (owner.recipe === section.recipe) return section;
    const prefix = `${section.tag}-`;
    if (section.items.some((item) => !item.code.startsWith(prefix))) {
      throw new StudioError(
        "REVIEW_TAG_COLLISION",
        `Recipes "${owner.recipe}" (${owner.directory}) and "${section.recipe}" (${section.directory}) both use the tag ${section.tag}, and the codes of "${section.recipe}" do not all start with ${prefix}, so the page cannot give it another tag.`,
        "Render that recipe again, or write one review page per widget."
      );
    }
    const key = JSON.stringify([section.tag, section.recipe]);
    const tag = given.get(key) ?? freeTag(section.tag, taken);
    given.set(key, tag);
    const items = section.items.map((item) => ({...item, code: `${tag}-${item.code.slice(prefix.length)}`}));
    return {...section, tag, recordedTag: section.tag, items};
  });
}

/** The lowest `<tag without its trailing digits><digit>` from 2 that is not taken; it is taken from then on. */
function freeTag(tag: string, taken: Set<string>): string {
  const base = tag.replace(/\p{N}+$/u, "") || tag;
  let digit = 2;
  while (taken.has(`${base}${digit}`)) digit += 1;
  const free = `${base}${digit}`;
  taken.add(free);
  return free;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function href(page: string, file: string): string {
  return relative(dirname(page), file).split(sep).map(encodeURIComponent).join("/");
}

/** The review page: one section per recipe folder, each file under its code, linked relative to the page. */
export function renderReviewPage(page: string, title: string, sections: readonly ReviewSection[]): string {
  const rounds = new Map<string, number>();
  const body = sections.map((section) => {
    // Two rounds of one recipe keep their codes; only the second one's anchors get a suffix.
    const round = (rounds.get(section.tag) ?? 0) + 1;
    rounds.set(section.tag, round);
    const anchor = (code: string) => (round === 1 ? code : `${code}.${round}`);
    const figures = section.items.map((item) => {
      const path = href(page, reviewItemPath(section, item));
      const caption = escapeHtml(reviewCaption(item));
      const media = item.kind === "video"
        ? `<video src="${path}" controls muted preload="metadata"></video>`
        : `<a href="${path}"><img src="${path}" alt="${caption}" loading="lazy"></a>`;
      return `<figure id="${escapeHtml(anchor(item.code))}">${media}<figcaption>${caption}</figcaption></figure>`;
    });
    const renamed = section.recordedTag === undefined
      ? null
      : `renamed from ${section.recordedTag}${section.items.some((item) => item.kind === "contactSheet") ? `; its contact sheet still says ${section.recordedTag}` : ""}`;
    const where = [href(page, section.directory) || ".", section.generatedAt, renamed].filter(Boolean).join(" · ");
    return [
      `<section id="${escapeHtml(anchor(section.tag))}">`,
      `<h2>${escapeHtml(section.tag)} · ${escapeHtml(section.recipe)}</h2>`,
      `<p class="where">${escapeHtml(where)}</p>`,
      `<div class="grid">`,
      ...figures,
      `</div>`,
      `</section>`
    ].join("\n");
  });
  const nav = sections
    .map((section, index) => {
      const round = sections.slice(0, index).filter((other) => other.tag === section.tag).length + 1;
      const target = round === 1 ? section.tag : `${section.tag}.${round}`;
      return `<a href="#${escapeHtml(target)}">${escapeHtml(section.tag)} · ${escapeHtml(section.recipe)}</a>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:dark;--bg:#111317;--fg:#e8eaee;--muted:#9aa3b2;--line:#2b303a;--cap:#1b1f26}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}
main{max-width:1600px;margin:0 auto;padding:16px}
h1{font-size:20px;margin:0 0 8px}
h2{font-size:16px;margin:32px 0 2px}
nav{position:sticky;top:0;z-index:1;background:var(--bg);padding:8px 0;display:flex;flex-wrap:wrap;gap:4px 16px}
nav a{color:#9cc4ff}
.where{color:var(--muted);margin:0 0 10px;overflow-wrap:anywhere}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,420px),1fr));gap:12px}
figure{margin:0;border:1px solid var(--line);min-width:0}
img,video{display:block;width:100%;height:auto;background:repeating-conic-gradient(#2a2e36 0 25%,#1f2229 0 50%) 0 0/16px 16px}
figcaption{font:600 14px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--cap);padding:6px 8px;overflow-wrap:anywhere}
</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
<nav>
${nav}
</nav>
${body.join("\n")}
</main>
</body>
</html>
`;
}

export interface ReviewMediaResult {
  code: string;
  /** The video's code. */
  source: string;
  file: string;
  /** A sheet's cells. */
  cells?: number;
}

export interface ReviewPageResult {
  page: string;
  /** `recordedTag` only for a section the page renamed. */
  sections: {tag: string; recordedTag?: string; recipe: string; directory: string; items: number}[];
  images: number;
  videos: number;
  /** Files the manifests list that are not on disk; their figures stay, with their codes. */
  missing: string[];
  /** With `--trails`: the trail written for each video. */
  trails?: ReviewMediaResult[];
  /** With `--sheet`: the timed frame sheet written for each video. */
  sheets?: ReviewMediaResult[];
  /** With `--trails` or `--sheet`: videos missing on disk, which get no trail or sheet. */
  skipped?: string[];
}

export interface ReviewMediaOptions {
  /** A trail per video: the per-pixel maximum of every `trailEvery`-th frame (default 2). */
  trails?: boolean;
  trailEvery?: number;
  /** A timed frame sheet per video, one cell every `sheet` seconds. */
  sheet?: number;
  ffmpegPath?: string;
  ffprobePath?: string;
}

interface MediaJob {
  section: ReviewSection;
  video: string;
  trail?: ReviewItem;
  sheet?: ReviewItem;
  probe?: VideoProbe;
}

/** The folder beside the page that holds its trails and sheets: `index.html` → `index-media/`. */
export function reviewMediaFolder(page: string): string {
  return join(dirname(page), `${basename(page, ".html")}-media`);
}

/** The video's real path, refused unless it is a regular file inside its section's folder. */
async function containedVideo(section: ReviewSection, item: ReviewItem, path: string): Promise<string> {
  const root = await realpath(section.directory);
  const real = await realpath(path).catch(() => undefined);
  const regular = real === undefined ? false : (await lstat(real)).isFile();
  if (real === undefined || !regular || !isInside(root, real)) {
    throw new StudioError(
      "REVIEW_MEDIA_OUTSIDE",
      `${item.code} (${item.file}) is not a regular file inside ${section.directory}, so review does not decode it.`,
      "Trails and sheets read only the videos inside each render folder; review that render's own folder."
    );
  }
  if (!VIDEO_EXTENSIONS.some((extension) => real.toLowerCase().endsWith(extension))) {
    throw new StudioError(
      "REVIEW_MEDIA_INVALID",
      `${item.code} (${item.file}) is not an ${VIDEO_EXTENSIONS.join(", ")} file, so review does not decode it.`,
      "Trails and sheets read only the MP4, WebM, and MOV videos a render writes."
    );
  }
  return real;
}

function validateMediaOptions(options: ReviewMediaOptions): void {
  if (options.trailEvery !== undefined && !options.trails) {
    throw new StudioError("REVIEW_OPTION_INVALID", "--trail-every sets the step of a trail.", "Pass --trails with it.");
  }
  if (options.trailEvery !== undefined && (!Number.isInteger(options.trailEvery) || options.trailEvery < 1)) {
    throw new StudioError("REVIEW_OPTION_INVALID", `--trail-every must be an integer of at least 1, not ${options.trailEvery}.`);
  }
  if (options.sheet !== undefined && (!Number.isFinite(options.sheet) || options.sheet <= 0)) {
    throw new StudioError("REVIEW_OPTION_INVALID", `--sheet must be a number of seconds above 0, not ${options.sheet}.`);
  }
}

/** The trail and sheet items of each section, their videos checked and their targets free (or `force`). */
async function planReviewMedia(page: string, sections: readonly ReviewSection[], missing: readonly string[], options: ReviewMediaOptions & {force?: boolean}) {
  const folder = reviewMediaFolder(page);
  const rounds = new Map<string, number>();
  const jobs: MediaJob[] = [];
  const skipped: string[] = [];
  const planned = [];
  for (const section of sections) {
    const round = (rounds.get(section.tag) ?? 0) + 1;
    rounds.set(section.tag, round);
    const videos: {item: ReviewItem; real: string}[] = [];
    for (const item of section.items.filter((candidate) => candidate.kind === "video")) {
      const path = reviewItemPath(section, item);
      if (missing.includes(path)) skipped.push(path);
      else videos.push({item, real: await containedVideo(section, item, path)});
    }
    const derived = reviewMediaItems(section.tag, section.items, videos.map((video) => video.item), {
      ...(options.trails ? {trailEvery: options.trailEvery ?? 2} : {}),
      ...(options.sheet === undefined ? {} : {sheetSeconds: options.sheet})
    }).map((item) => ({...item, path: join(folder, `${round === 1 ? item.code : `${item.code}.${round}`}-${item.kind}.png`)}));
    for (const video of videos) {
      const job: MediaJob = {section, video: video.real};
      for (const item of derived.filter((candidate) => candidate.source === video.item.code)) job[item.kind === "trail" ? "trail" : "sheet"] = item;
      jobs.push(job);
    }
    planned.push({...section, items: [...section.items, ...derived]});
  }
  const folderEntry = await lstat(folder).catch(() => undefined);
  if (folderEntry && !folderEntry.isDirectory()) {
    throw new StudioError("OUTPUT_TARGET_INVALID", `${folder} exists and is not a folder.`);
  }
  const collisions: string[] = [];
  for (const item of planned.flatMap((section) => section.items).filter((candidate) => candidate.path !== undefined)) {
    const entry = await lstat(item.path!).catch(() => undefined);
    if (!entry) continue;
    if (!entry.isFile()) throw new StudioError("OUTPUT_TARGET_INVALID", `Existing output target is not a regular file: ${item.path}`);
    collisions.push(item.path!);
  }
  if (collisions.length > 0 && !options.force) {
    throw new StudioError("OUTPUT_EXISTS", `${collisions.length} trail or sheet file${collisions.length === 1 ? "" : "s"} exist: ${collisions.map((path) => basename(path)).join(", ")}.`, "Pass --force to replace exactly these files and the page.");
  }
  return {sections: planned, jobs, skipped};
}

/**
 * Writes the review page over render folders; replacing an existing page takes `force`. With `trails` or `sheet`,
 * it first writes a trail and a timed frame sheet per video, decoded by FFmpeg, beside the page, and lists them under
 * codes after each section's own; without them it never looks for FFmpeg.
 */
export async function writeReviewPage(options: {
  page: string;
  folders: readonly string[];
  title?: string;
  force?: boolean;
} & ReviewMediaOptions): Promise<ReviewPageResult> {
  const page = resolve(options.page);
  if (!page.endsWith(".html")) throw new StudioError("REVIEW_PAGE_INVALID", `The review page must end in .html: ${options.page}`);
  if (options.folders.length === 0) throw new StudioError("REVIEW_FOLDER_EMPTY", "Pass at least one render folder.");
  const media = options.trails === true || options.sheet !== undefined;
  validateMediaOptions(options);
  let ffmpeg: string | undefined;
  let ffprobe: string | undefined;
  if (media) {
    ffmpeg = await findExecutable("ffmpeg", options.ffmpegPath);
    ffprobe = await findExecutable("ffprobe", options.ffprobePath);
    if (!ffmpeg || !ffprobe) {
      throw new StudioError(
        "FFMPEG_NOT_FOUND",
        `--trails and --sheet decode videos with FFmpeg and ffprobe, and ${!ffmpeg ? "ffmpeg" : "ffprobe"} was not found${(!ffmpeg ? options.ffmpegPath : options.ffprobePath) ? ` at ${!ffmpeg ? options.ffmpegPath : options.ffprobePath}` : " on PATH"}.`,
        "Install FFmpeg (it ships ffprobe), or pass --ffmpeg-path and --ffprobe-path; the Studio never downloads it."
      );
    }
  }
  if (!options.force && (await exists(page))) {
    throw new StudioError("OUTPUT_EXISTS", `${options.page} exists.`, "Pass --force to replace this page.");
  }
  let sections = await reviewSections(options.folders);
  const missing: string[] = [];
  for (const section of sections) {
    for (const item of section.items) {
      const path = reviewItemPath(section, item);
      if (!(await exists(path))) missing.push(path);
    }
  }
  let derived: Pick<ReviewPageResult, "trails" | "sheets" | "skipped"> = {};
  if (media) {
    const plan = await planReviewMedia(page, sections, missing, options);
    sections = plan.sections;
    for (const job of plan.jobs) {
      job.probe = await probeVideo(ffprobe!, job.video);
      if (job.sheet) {
        const cells = sheetFrames(job.probe.frames, job.probe.fps, options.sheet!, MAX_SHEET_CELLS + 1).length;
        if (cells > MAX_SHEET_CELLS) {
          const count = Math.max(cells, sheetCellCount(job.probe.frames, job.probe.fps, options.sheet!));
          throw new StudioError(
            "REVIEW_SHEET_TOO_LARGE",
            `A sheet of ${job.sheet.source} every ${options.sheet} s has ${count} cells; a sheet holds at most ${MAX_SHEET_CELLS}.`,
            `Pass --sheet ${sheetStepFor(job.probe.frames / job.probe.fps)} or more.`
          );
        }
      }
    }
    const trails: ReviewMediaResult[] = [];
    const sheets: ReviewMediaResult[] = [];
    // Every video decodes before any file is written: a failure leaves no trail or sheet behind without its page.
    const writes: {path: string; data: Buffer}[] = [];
    for (const job of plan.jobs) {
      const probe = job.probe!;
      const instants = job.sheet ? sheetFrames(probe.frames, probe.fps, options.sheet!) : [];
      const decoded = await decodeVideo({
        ffmpeg: ffmpeg!,
        path: job.video,
        probe,
        ...(job.trail ? {trailEvery: job.trail.every!} : {}),
        ...(job.sheet ? {sheetIndexes: instants.map((instant) => instant.frame)} : {})
      });
      if (job.trail && decoded.trail) {
        const write = {path: job.trail.path!, data: encodePng(probe.width, probe.height, 3, decoded.trail.data)};
        writes.push(write);
        trails.push({code: job.trail.code, source: job.trail.source!, file: job.trail.path!});
      }
      if (job.sheet) {
        const cells = instants
          .filter((instant) => decoded.cells.has(instant.frame))
          .map((instant) => ({image: decoded.cells.get(instant.frame)!, label: secondsLabel(instant.seconds, options.sheet!)}));
        if (cells.length === 0) throw new StudioError("REVIEW_MEDIA_INVALID", `FFmpeg decoded none of the sheet's frames of ${job.video}.`);
        const sheet = composeSheet(cells);
        writes.push({path: job.sheet.path!, data: encodePng(sheet.width, sheet.height, 3, sheet.data)});
        sheets.push({code: job.sheet.code, source: job.sheet.source!, file: job.sheet.path!, cells: cells.length});
      }
    }
    for (const write of writes) await atomicWriteFile(dirname(page), write.path, write.data);
    derived = {
      ...(options.trails ? {trails} : {}),
      ...(options.sheet === undefined ? {} : {sheets}),
      skipped: plan.skipped
    };
  }
  await mkdir(dirname(page), {recursive: true});
  await writeFile(page, renderReviewPage(page, options.title ?? "Review", sections), options.force ? undefined : {flag: "wx"});
  const items = sections.flatMap((section) => section.items);
  return {
    page,
    sections: sections.map((section) => ({
      tag: section.tag,
      ...(section.recordedTag === undefined ? {} : {recordedTag: section.recordedTag}),
      recipe: section.recipe,
      directory: section.directory,
      items: section.items.length
    })),
    images: items.filter((item) => item.kind !== "video").length,
    videos: items.filter((item) => item.kind === "video").length,
    missing,
    ...derived
  };
}

/** One line for the terminal: what the page holds, by section. */
export function reviewSummary(result: ReviewPageResult): string {
  const counts = [`${result.images} image${result.images === 1 ? "" : "s"}`];
  if (result.videos > 0) counts.push(`${result.videos} video${result.videos === 1 ? "" : "s"}`);
  const sections = result.sections
    .map((section) => `${section.tag} ${section.recipe}${section.recordedTag === undefined ? "" : ` (renamed from ${section.recordedTag})`}`)
    .join(", ");
  const line = `${result.page}: ${counts.join(" and ")} in ${result.sections.length} section${result.sections.length === 1 ? "" : "s"} (${sections}).`;
  const lines = [line];
  if (result.missing.length > 0) lines.push(`Missing on disk (${result.missing.length}): ${result.missing.map((path) => basename(path)).join(", ")}`);
  const derived = [...(result.trails ?? []), ...(result.sheets ?? [])];
  if (result.trails || result.sheets) {
    const written = [
      ...(result.trails ? [`${result.trails.length} trail${result.trails.length === 1 ? "" : "s"}`] : []),
      ...(result.sheets ? [`${result.sheets.length} sheet${result.sheets.length === 1 ? "" : "s"}`] : [])
    ].join(" and ");
    lines.push(`Wrote ${written}${derived.length > 0 ? ` (${derived.map((item) => `${item.code} of ${item.source}`).join(", ")}) in ${dirname(derived[0]!.file)}` : ""}.`);
  }
  if (result.skipped && result.skipped.length > 0) {
    lines.push(`No trail or sheet for videos missing on disk (${result.skipped.length}): ${result.skipped.map((path) => basename(path)).join(", ")}`);
  }
  return lines.join("\n");
}
