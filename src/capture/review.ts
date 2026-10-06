import {readdir, readFile, stat, writeFile} from "node:fs/promises";
import {basename, dirname, join, relative, resolve, sep} from "node:path";
import type {JsonObject} from "../types.js";
import {StudioError} from "../shared/errors.js";

/**
 * Review codes: a short, quotable caption for each file a render writes ("LT-03 is too dark"), on the
 * contact sheet and on the review page. The tag comes from the recipe id and the number from the recipe's
 * variant order, so rendering the same recipe again gives every file the same code.
 */

export type ReviewKind = "screenshot" | "video" | "still" | "thumbnail" | "contactSheet";

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
 * order; a repeated tag gets a digit (`C`, `C2`). A tag stays put while the recipes keep their ids and order.
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
  const what = item.kind === "contactSheet"
    ? "contact sheet"
    : `${item.variant} · ${item.kind === "still" ? `still ${item.name}` : item.kind}`;
  return `${item.code} · ${what}`;
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
}

const MANIFEST = "manifest.json";

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

async function readSection(directory: string): Promise<ReviewSection> {
  const path = join(directory, MANIFEST);
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
  return {
    tag,
    recipe,
    directory,
    outputRoot: dirname(directory),
    generatedAt: typeof manifest.generatedAt === "string" ? manifest.generatedAt : null,
    items
  };
}

/**
 * One section per recipe folder: a folder that holds manifest.json, or each subfolder that does, by name.
 * Sections of the same recipe may share a tag (two rounds of one recipe); different recipes may not.
 */
export async function reviewSections(folders: readonly string[]): Promise<ReviewSection[]> {
  const sections: ReviewSection[] = [];
  for (const folder of folders) {
    const directory = resolve(folder);
    if (await exists(join(directory, MANIFEST))) {
      sections.push(await readSection(directory));
      continue;
    }
    const children = await readdir(directory, {withFileTypes: true}).catch(() => {
      throw new StudioError("REVIEW_FOLDER_NOT_FOUND", `Review folder not found: ${folder}`);
    });
    const found: string[] = [];
    for (const child of children.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()) {
      if (await exists(join(directory, child, MANIFEST))) found.push(join(directory, child));
    }
    if (found.length === 0) {
      throw new StudioError(
        "REVIEW_FOLDER_EMPTY",
        `${folder} has no ${MANIFEST}, and no folder inside it has one.`,
        "Pass a recipe folder written by render, capture, or record, or the output root that holds them."
      );
    }
    for (const child of found) sections.push(await readSection(child));
  }
  const owners = new Map<string, ReviewSection>();
  for (const section of sections) {
    const owner = owners.get(section.tag);
    if (owner && owner.recipe !== section.recipe) {
      throw new StudioError(
        "REVIEW_TAG_COLLISION",
        `Recipes "${owner.recipe}" (${owner.directory}) and "${section.recipe}" (${section.directory}) both use the tag ${section.tag}, so their codes would collide.`,
        "Write one review page per widget."
      );
    }
    owners.set(section.tag, owner ?? section);
  }
  return sections;
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
      const path = href(page, join(section.outputRoot, item.file));
      const caption = escapeHtml(reviewCaption(item));
      const media = item.kind === "video"
        ? `<video src="${path}" controls muted preload="metadata"></video>`
        : `<a href="${path}"><img src="${path}" alt="${caption}" loading="lazy"></a>`;
      return `<figure id="${escapeHtml(anchor(item.code))}">${media}<figcaption>${caption}</figcaption></figure>`;
    });
    const where = [href(page, section.directory) || ".", section.generatedAt].filter(Boolean).join(" · ");
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

export interface ReviewPageResult {
  page: string;
  sections: {tag: string; recipe: string; directory: string; items: number}[];
  images: number;
  videos: number;
  /** Files the manifests list that are not on disk; their figures stay, with their codes. */
  missing: string[];
}

/** Writes the review page over render folders; replacing an existing page takes `force`. */
export async function writeReviewPage(options: {
  page: string;
  folders: readonly string[];
  title?: string;
  force?: boolean;
}): Promise<ReviewPageResult> {
  const page = resolve(options.page);
  if (!page.endsWith(".html")) throw new StudioError("REVIEW_PAGE_INVALID", `The review page must end in .html: ${options.page}`);
  if (options.folders.length === 0) throw new StudioError("REVIEW_FOLDER_EMPTY", "Pass at least one render folder.");
  if (!options.force && (await exists(page))) {
    throw new StudioError("OUTPUT_EXISTS", `${options.page} exists.`, "Pass --force to replace this page.");
  }
  const sections = await reviewSections(options.folders);
  const missing: string[] = [];
  for (const section of sections) {
    for (const item of section.items) {
      const path = join(section.outputRoot, item.file);
      if (!(await exists(path))) missing.push(path);
    }
  }
  await writeFile(page, renderReviewPage(page, options.title ?? "Review", sections), options.force ? undefined : {flag: "wx"});
  const items = sections.flatMap((section) => section.items);
  return {
    page,
    sections: sections.map((section) => ({tag: section.tag, recipe: section.recipe, directory: section.directory, items: section.items.length})),
    images: items.filter((item) => item.kind !== "video").length,
    videos: items.filter((item) => item.kind === "video").length,
    missing
  };
}

/** One line for the terminal: what the page holds, by section. */
export function reviewSummary(result: ReviewPageResult): string {
  const counts = [`${result.images} image${result.images === 1 ? "" : "s"}`];
  if (result.videos > 0) counts.push(`${result.videos} video${result.videos === 1 ? "" : "s"}`);
  const sections = result.sections.map((section) => `${section.tag} ${section.recipe}`).join(", ");
  const line = `${result.page}: ${counts.join(" and ")} in ${result.sections.length} section${result.sections.length === 1 ? "" : "s"} (${sections}).`;
  return result.missing.length > 0
    ? `${line}\nMissing on disk (${result.missing.length}): ${result.missing.map((path) => basename(path)).join(", ")}`
    : line;
}
