import {StudioError} from "./errors.js";

const SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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

export function assertSafeId(value: string, label = "identifier"): string {
  if (!SAFE_ID.test(value) || value.includes("..")) {
    throw new StudioError(
      "INVALID_ID",
      `Invalid ${label} "${value}". Use lowercase letters, numbers, and single hyphens.`
    );
  }
  return value;
}
