// The guard a repo script puts around its main, so importing it (a test, another script) runs nothing.
import {realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

/**
 * Whether the module at `moduleUrl` (the caller's import.meta.url) is the script node was started with. Node resolves
 * links for the ESM entry point, so import.meta.url is the real path while argv[1] keeps the linked one: compared as
 * they are, a script run through a link exits 0 without doing anything (cut-loop.mjs did, through the skill link). Both
 * sides are compared by their real paths, as skills/se-widget-studio/scripts/studio-client.mjs does.
 */
export function isEntryPoint(moduleUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
