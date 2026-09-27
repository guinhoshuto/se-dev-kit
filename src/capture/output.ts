import {lstat, mkdir, realpath, rename, rmdir, unlink, writeFile} from "node:fs/promises";
import {basename, dirname, relative, resolve, sep} from "node:path";
import {randomBytes} from "node:crypto";
import {StudioError} from "../shared/errors.js";
import {assertOutputTarget, isInside} from "../shared/paths.js";

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function assertNoSymlinkAncestor(outputRoot: string, target: string): Promise<void> {
  const root = resolve(outputRoot);
  const targetParent = dirname(resolve(target));
  const parts = relative(root, targetParent).split(sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = resolve(current, part);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) {
        throw new StudioError("OUTPUT_SYMLINK", `Output target crosses a symbolic link: ${current}`);
      }
      if (!metadata.isDirectory()) {
        throw new StudioError("OUTPUT_PARENT_INVALID", `Output parent is not a directory: ${current}`);
      }
    } catch (error) {
      if (error instanceof StudioError) throw error;
      break;
    }
  }
  const realRoot = await realpath(root).catch(() => root);
  const existingParent = await realpath(current).catch(() => realRoot);
  if (!isInside(realRoot, existingParent)) {
    throw new StudioError("OUTPUT_ESCAPE", `Output target escapes through a symbolic link: ${target}`);
  }
}

export async function preflightOutputTargets(outputRoot: string, targets: string[], force: boolean): Promise<void> {
  const unique = new Set<string>();
  const collisions: string[] = [];
  for (const target of targets) {
    const safeTarget = assertOutputTarget(outputRoot, target);
    if (unique.has(safeTarget)) throw new StudioError("OUTPUT_COLLISION", `Multiple artifacts resolve to ${safeTarget}.`);
    unique.add(safeTarget);
    await assertNoSymlinkAncestor(outputRoot, safeTarget);
    if (await exists(safeTarget)) {
      const metadata = await lstat(safeTarget);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new StudioError("OUTPUT_TARGET_INVALID", `Existing output target is not a regular file: ${safeTarget}`);
      }
      collisions.push(safeTarget);
    }
  }
  if (collisions.length > 0 && !force) {
    throw new StudioError(
      "OUTPUT_EXISTS",
      `Refusing to overwrite ${collisions.length} existing output file(s): ${collisions.map((path) => basename(path)).join(", ")}.`,
      "Pass --force to replace only these exact planned files."
    );
  }
}

/**
 * Temporary paths created by one render. Each is added when its `.sws-*.tmp` name is chosen and removed
 * when it is committed, so a failed render can delete exactly the temporary files it created.
 */
export type TemporaryFiles = Set<string>;

export async function createAtomicTarget(outputRoot: string, target: string, temporaryFiles?: TemporaryFiles): Promise<{
  temporaryPath: string;
  commit: () => Promise<void>;
}> {
  const safeTarget = assertOutputTarget(outputRoot, target);
  await assertNoSymlinkAncestor(outputRoot, safeTarget);
  await mkdir(dirname(safeTarget), {recursive: true});
  const temporaryPath = resolve(
    dirname(safeTarget),
    `.${basename(safeTarget)}.sws-${randomBytes(6).toString("hex")}.tmp`
  );
  temporaryFiles?.add(temporaryPath);
  return {
    temporaryPath,
    commit: async () => {
      await rename(temporaryPath, safeTarget);
      temporaryFiles?.delete(temporaryPath);
    }
  };
}

export async function atomicWriteFile(
  outputRoot: string,
  target: string,
  data: string | Buffer,
  temporaryFiles?: TemporaryFiles
): Promise<void> {
  const atomic = await createAtomicTarget(outputRoot, target, temporaryFiles);
  await writeFile(atomic.temporaryPath, data);
  await atomic.commit();
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null ? (error as {code?: unknown}).code : undefined;
}

/** Deletes only the tracked temporary paths, never anything matched by name. Returns how many existed. */
export async function removeTemporaryFiles(temporaryFiles: TemporaryFiles): Promise<number> {
  let removed = 0;
  for (const path of [...temporaryFiles]) {
    try {
      await unlink(path);
      removed += 1;
    } catch {
      // A path that was never written (ENOENT) or cannot be removed must not hide the original error.
    }
    temporaryFiles.delete(path);
  }
  return removed;
}

/**
 * Removes an encoded variant's frame sequence: only the listed frame files and frames.json, each checked to be
 * a regular file directly inside the frame directory. Then it removes the frame directory and its parent only
 * when they are empty. Unlisted files, symbolic links, and non-empty directories stay.
 */
export async function discardFrameSequence(options: {
  outputRoot: string;
  framesDirectory: string;
  frameFiles: string[];
}): Promise<{removedFiles: number; removedDirectories: string[]}> {
  const directory = assertOutputTarget(options.outputRoot, options.framesDirectory);
  const names = [...options.frameFiles, "frames.json"];
  const paths = names.map((name) => {
    const path = resolve(directory, name);
    if (dirname(path) !== directory || basename(path) !== name) {
      throw new StudioError("FRAME_PATH_INVALID", `Frame file must be a plain name inside ${directory}: ${name}`);
    }
    return path;
  });
  await assertNoSymlinkAncestor(options.outputRoot, paths[paths.length - 1]!);
  // Validate both folders that may be removed before any file is deleted, so a refusal deletes nothing.
  const directoryCandidates = [directory, dirname(directory)].map((candidate) => assertOutputTarget(options.outputRoot, candidate));
  let removedFiles = 0;
  for (const path of new Set(paths)) {
    let metadata;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
    if (!metadata.isFile()) continue;
    await unlink(path);
    removedFiles += 1;
  }
  const removedDirectories: string[] = [];
  for (const safeCandidate of directoryCandidates) {
    try {
      await rmdir(safeCandidate);
      removedDirectories.push(safeCandidate);
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOTEMPTY" || code === "EEXIST" || code === "ENOENT" || code === "ENOTDIR") break;
      throw error;
    }
  }
  return {removedFiles, removedDirectories};
}
