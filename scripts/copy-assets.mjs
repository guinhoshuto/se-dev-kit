import {chmod, cp, mkdir} from "node:fs/promises";
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
