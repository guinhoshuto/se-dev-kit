import {execFileSync} from "node:child_process";
import {chmod, cp, mkdir, readFile, writeFile} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const copies = [
  ["src/studio-ui/index.html", "dist/studio-ui/index.html"],
  ["src/studio-ui/styles.css", "dist/studio-ui/styles.css"]
];

for (const [source, destination] of copies) {
  const absoluteDestination = resolve(projectRoot, destination);
  await mkdir(dirname(absoluteDestination), {recursive: true});
  await cp(resolve(projectRoot, source), absoluteDestination);
}

await chmod(resolve(projectRoot, "dist/cli/index.js"), 0o755);
await mkdir(resolve(projectRoot, "public/engine/runtime"), {recursive: true});
await cp(resolve(projectRoot, "dist/runtime"), resolve(projectRoot, "public/engine/runtime"), {recursive: true});
await cp(resolve(projectRoot, "dist/version.js"), resolve(projectRoot, "public/engine/version.js"));

// Which build a render came from (manifest studio.commit/dirty). Vercel builds have no .git
// checkout but expose the commit; a local build asks git. Untracked files do not count as dirty.
const git = (...args) => {
  try {
    return execFileSync("git", ["-C", projectRoot, ...args], {encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]}).trim();
  } catch {
    return null;
  }
};
const packageVersion = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8")).version;
const vercelCommit = process.env.VERCEL_GIT_COMMIT_SHA || null;
const commit = vercelCommit ?? git("rev-parse", "HEAD");
const status = vercelCommit ? "" : git("status", "--porcelain", "--untracked-files=no");
await writeFile(resolve(projectRoot, "dist/build-info.json"), `${JSON.stringify({
  version: packageVersion,
  commit,
  dirty: status === null ? null : status.length > 0
}, null, 2)}\n`);
