import {lstat, mkdir, realpath, rename, writeFile} from "node:fs/promises";
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

export async function createAtomicTarget(outputRoot: string, target: string): Promise<{
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
  return {
    temporaryPath,
    commit: async () => {
      await rename(temporaryPath, safeTarget);
    }
  };
}

export async function atomicWriteFile(
  outputRoot: string,
  target: string,
  data: string | Buffer
): Promise<void> {
  const atomic = await createAtomicTarget(outputRoot, target);
  await writeFile(atomic.temporaryPath, data);
  await atomic.commit();
}
