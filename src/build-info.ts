import {readFileSync} from "node:fs";
import {STUDIO_VERSION} from "./version.js";

export type BuildInfo = {version: string; commit: string | null; dirty: boolean | null};

let cached: BuildInfo | undefined;

/**
 * The build this engine came from, written next to it by scripts/copy-assets.mjs (build:engine).
 * A checkout that was never built reports the source version with an unknown commit.
 */
export function buildInfo(): BuildInfo {
  if (cached) return cached;
  try {
    const raw = JSON.parse(readFileSync(new URL("./build-info.json", import.meta.url), "utf8")) as Partial<BuildInfo>;
    cached = {
      version: typeof raw.version === "string" ? raw.version : STUDIO_VERSION,
      commit: typeof raw.commit === "string" ? raw.commit : null,
      dirty: typeof raw.dirty === "boolean" ? raw.dirty : null
    };
  } catch {
    cached = {version: STUDIO_VERSION, commit: null, dirty: null};
  }
  return cached;
}
