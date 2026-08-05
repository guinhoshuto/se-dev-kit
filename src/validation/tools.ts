import {access} from "node:fs/promises";
import {constants} from "node:fs";
import {delimiter, resolve} from "node:path";
import {spawn} from "node:child_process";

export async function findExecutable(name: string, explicitPath?: string): Promise<string | undefined> {
  const candidates = explicitPath
    ? [resolve(explicitPath)]
    : (process.env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => resolve(directory, name));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.R_OK | constants.X_OK);
      return candidate;
    } catch {
      // Continue through the explicit, bounded candidate list.
    }
  }
  return undefined;
}

export async function runExecutable(
  executable: string,
  args: string[],
  options: {cwd?: string; maxOutputBytes?: number} = {}
): Promise<{code: number; stdout: string; stderr: string}> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const limit = options.maxOutputBytes ?? 1_000_000;
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < limit) stdout += chunk.slice(0, limit - stdout.length);
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < limit) stderr += chunk.slice(0, limit - stderr.length);
    });
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({code: code ?? 1, stdout, stderr}));
  });
}

export async function toolVersion(executable: string | undefined): Promise<string | undefined> {
  if (!executable) return undefined;
  const result = await runExecutable(executable, ["-version"], {maxOutputBytes: 16_384});
  if (result.code !== 0) return undefined;
  return (result.stdout || result.stderr).split(/\r?\n/, 1)[0]?.trim();
}
