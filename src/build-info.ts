import {execFileSync} from "node:child_process";
import {existsSync, readFileSync} from "node:fs";
import {readdir, stat} from "node:fs/promises";
import {dirname, join, relative, resolve, sep} from "node:path";
import {fileURLToPath} from "node:url";
import {STUDIO_VERSION} from "./version.js";

export type BuildInfo = {version: string; commit: string | null; dirty: boolean | null};

let cached: BuildInfo | undefined;

function readBuildInfo(path: string | URL): BuildInfo {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<BuildInfo>;
    return {
      version: typeof raw.version === "string" ? raw.version : STUDIO_VERSION,
      commit: typeof raw.commit === "string" ? raw.commit : null,
      dirty: typeof raw.dirty === "boolean" ? raw.dirty : null
    };
  } catch {
    return {version: STUDIO_VERSION, commit: null, dirty: null};
  }
}

/**
 * The build this engine came from, written next to it by scripts/copy-assets.mjs (build:engine).
 * A checkout that was never built reports the source version with an unknown commit.
 */
export function buildInfo(): BuildInfo {
  cached ??= readBuildInfo(new URL("./build-info.json", import.meta.url));
  return cached;
}

export interface BuildWarning {
  code: "BUILD_DIRTY" | "BUILD_STALE" | "BUILD_UNKNOWN";
  detail: string;
  hint: string;
}

export interface BuildFreshness {
  info: BuildInfo;
  /** Source files changed after the build, newest first, at most five; empty for a package without src/. */
  newerSources: string[];
  /** The checkout's current commit, when git knows it and it is not the one the build recorded. */
  head?: string;
  warnings: BuildWarning[];
}

const short = (commit: string) => commit.slice(0, 12);

async function sourceFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, {recursive: true, withFileTypes: true});
    return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
  } catch {
    return [];
  }
}

/** HEAD of the checkout rooted exactly here; an installed package would otherwise report its consumer's repository. */
function checkoutHead(root: string): string | undefined {
  if (!existsSync(join(root, ".git"))) return undefined;
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000}).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether dist/ still matches its checkout: built without uncommitted changes, from the commit the
 * checkout is on, and after the last change under src/. An installed package has no src/ and no git,
 * so only the recorded dirty flag applies there. `distDirectory` is for tests.
 */
export async function buildFreshness(distDirectory = dirname(fileURLToPath(import.meta.url))): Promise<BuildFreshness> {
  const infoPath = join(distDirectory, "build-info.json");
  const info = readBuildInfo(infoPath);
  const root = resolve(distDirectory, "..");
  const builtAt = await stat(infoPath).then((file) => file.mtimeMs, () => undefined);
  const changed: {path: string; mtimeMs: number}[] = [];
  if (builtAt !== undefined) {
    for (const path of await sourceFiles(join(root, "src"))) {
      const mtimeMs = await stat(path).then((file) => file.mtimeMs, () => 0);
      if (mtimeMs > builtAt) changed.push({path: relative(root, path).split(sep).join("/"), mtimeMs});
    }
  }
  const newerSources = changed.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 5).map((item) => item.path);
  const current = info.commit ? checkoutHead(root) : undefined;
  const head = current && current !== info.commit ? current : undefined;

  const warnings: BuildWarning[] = [];
  const rebuild = "Run npm run build:engine in the Studio checkout.";
  if (builtAt === undefined || info.commit === null) {
    warnings.push({code: "BUILD_UNKNOWN", detail: `${infoPath} is missing or records no commit, so renders cannot name the build they came from.`, hint: rebuild});
  }
  if (info.dirty === true) {
    warnings.push({
      code: "BUILD_DIRTY",
      detail: `dist/ was built from uncommitted changes on top of ${info.commit ? short(info.commit) : "an unknown commit"}; manifests record dirty: true, and no commit reproduces those renders.`,
      hint: `Commit the changes first, then: ${rebuild}`
    });
  }
  if (newerSources.length > 0) {
    warnings.push({code: "BUILD_STALE", detail: `dist/ is older than src/: ${newerSources.join(", ")} changed after the build, so renders do not run that code yet.`, hint: rebuild});
  }
  if (head && info.commit) {
    warnings.push({code: "BUILD_STALE", detail: `dist/ was built from ${short(info.commit)}, but the checkout is at ${short(head)}.`, hint: rebuild});
  }
  return {info, newerSources, ...(head ? {head} : {}), warnings};
}
