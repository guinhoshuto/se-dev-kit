import {StudioError} from "./errors.js";

/** Lowercase letters and numbers in hyphen-separated runs: safe in a file name and a URL. */
export const SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  if (!slug || !SAFE_ID.test(slug)) {
    throw new StudioError("INVALID_ID", `Cannot create a safe identifier from "${value}".`);
  }
  return slug;
}

/** The rule SAFE_ID enforces, in words, for every message that refuses an id. */
export const SAFE_ID_RULE = "lowercase letters, numbers, and single hyphens";

/** Why an id is unsafe, or undefined when it is safe. Catalog schemas and assertSafeId share it. */
export function unsafeIdMessage(value: string, label = "identifier"): string | undefined {
  if (SAFE_ID.test(value) && !value.includes("..")) return undefined;
  return `Invalid ${label} "${value}". Use ${SAFE_ID_RULE}.`;
}

export function assertSafeId(value: string, label = "identifier"): string {
  const message = unsafeIdMessage(value, label);
  if (message) throw new StudioError("INVALID_ID", message);
  return value;
}
