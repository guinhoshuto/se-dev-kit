import {access, lstat, mkdir, realpath, stat} from "node:fs/promises";
import {constants} from "node:fs";
import {homedir} from "node:os";
import {dirname, isAbsolute, relative, resolve, sep} from "node:path";
import {StudioError} from "./errors.js";

export function isInside(parent: string, candidate: string): boolean {
  const difference = relative(parent, candidate);
  return difference === "" || (!difference.startsWith(`..${sep}`) && difference !== ".." && !isAbsolute(difference));
}

export async function resolveExistingPath(path: string, label = "path"): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    throw new StudioError("PATH_NOT_FOUND", `${label} does not exist: ${path}`);
  }
}

export async function resolveFileInside(
  root: string,
  requestedPath: string,
  label = "file"
): Promise<string> {
  if (
    !requestedPath ||
    requestedPath.includes("\0") ||
    isAbsolute(requestedPath) ||
    requestedPath.split(/[\\/]/).includes("..")
  ) {
    throw new StudioError("UNSAFE_PATH", `${label} must be a relative path inside the widget root.`);
  }

  const realRoot = await resolveExistingPath(root, "Widget root");
  const candidate = await resolveExistingPath(resolve(realRoot, requestedPath), label);
  if (!isInside(realRoot, candidate)) {
    throw new StudioError("PATH_ESCAPE", `${label} resolves outside the widget root: ${requestedPath}`);
  }
  const metadata = await stat(candidate);
  if (!metadata.isFile()) {
    throw new StudioError("NOT_A_FILE", `${label} is not a file: ${requestedPath}`);
  }
  return candidate;
}

export async function nearestExistingAncestor(path: string): Promise<string> {
  let current = resolve(path);
  while (true) {
    try {
      return await realpath(current);
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        throw new StudioError("OUTPUT_ANCESTOR_MISSING", `No existing ancestor found for output path: ${path}`);
      }
      current = parent;
    }
  }
}

async function canonicalPlannedPath(path: string): Promise<string> {
  let current = resolve(path);
  const missing: string[] = [];
  while (true) {
    try {
      const existing = await realpath(current);
      return resolve(existing, ...missing.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        throw new StudioError("OUTPUT_ANCESTOR_MISSING", `No existing ancestor found for output path: ${path}`);
      }
      missing.push(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      current = parent;
    }
  }
}

export async function assertSafeOutputRoot(
  requestedRoot: string,
  protectedPaths: string[]
): Promise<string> {
  if (!requestedRoot || requestedRoot.includes("\0")) {
    throw new StudioError("UNSAFE_OUTPUT", "Output root cannot be empty.");
  }
  const requestedOutputRoot = resolve(requestedRoot);
  try {
    const requestedMetadata = await lstat(requestedOutputRoot);
    if (requestedMetadata.isSymbolicLink()) {
      throw new StudioError("UNSAFE_OUTPUT", `Output root cannot be a symbolic link: ${requestedOutputRoot}`);
    }
  } catch (error) {
    if (error instanceof StudioError) throw error;
  }
  const outputRoot = await canonicalPlannedPath(requestedOutputRoot);
  const rootPath = await canonicalPlannedPath(resolve(sep));
  const forbidden = new Set(
    await Promise.all([rootPath, resolve(homedir()), ...protectedPaths].map((path) => canonicalPlannedPath(path)))
  );
  if (forbidden.has(outputRoot)) {
    throw new StudioError("UNSAFE_OUTPUT", `Refusing to use a protected directory as output root: ${outputRoot}`);
  }

  for (const protectedPath of forbidden) {
    if (outputRoot === protectedPath) {
      throw new StudioError("UNSAFE_OUTPUT", `Refusing to use a protected directory as output root: ${outputRoot}`);
    }
    if (isInside(outputRoot, protectedPath)) {
      throw new StudioError(
        "UNSAFE_OUTPUT",
        `Refusing to use an ancestor of a protected directory as output root: ${outputRoot}`
      );
    }
  }
  try {
    const metadata = await lstat(outputRoot);
    if (metadata.isSymbolicLink()) {
      throw new StudioError("UNSAFE_OUTPUT", `Output root cannot be a symbolic link: ${outputRoot}`);
    }
    if (!metadata.isDirectory()) {
      throw new StudioError("UNSAFE_OUTPUT", `Output root is not a directory: ${outputRoot}`);
    }
  } catch (error) {
    if (error instanceof StudioError) throw error;
  }

  return outputRoot;
}

export async function ensureOutputDirectory(outputRoot: string): Promise<void> {
  await mkdir(outputRoot, {recursive: true});
  await access(outputRoot, constants.W_OK);
}

export function assertOutputTarget(outputRoot: string, target: string): string {
  const resolvedRoot = resolve(outputRoot);
  const resolvedTarget = resolve(target);
  if (resolvedRoot === resolvedTarget || !isInside(resolvedRoot, resolvedTarget)) {
    throw new StudioError("OUTPUT_ESCAPE", `Output target escapes the output root: ${target}`);
  }
  return resolvedTarget;
}
