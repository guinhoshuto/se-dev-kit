import {StudioError} from "./errors.js";

/** package.json `engines.node`; a unit test keeps the two equal. */
export const SUPPORTED_NODE = ">=22.20 <23 || >=24 <25";

function parts(version: string): [number, number, number] {
  const [major = 0, minor = 0, patch = 0] = version.replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  return [major, minor, patch];
}

function compare(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) if (left[index] !== right[index]) return left[index]! - right[index]!;
  return 0;
}

/** Whether `version` satisfies an engines range written with `>=` and `<` comparators only. */
export function satisfiesNodeRange(version: string, range: string = SUPPORTED_NODE): boolean {
  const current = parts(version);
  return range.split("||").some((set) =>
    set.trim().split(/\s+/).every((comparator) => {
      const match = /^(>=|<)(\d+(?:\.\d+){0,2})$/.exec(comparator);
      if (!match) throw new Error(`Unsupported engines comparator: ${comparator}`);
      const order = compare(current, parts(match[2]!));
      return match[1] === ">=" ? order >= 0 : order < 0;
    })
  );
}

/**
 * Local capture, record and render refuse a Node.js version outside `engines`: on Node 26, Chrome
 * launch and close have hung with the work already written.
 */
export function assertSupportedNode(allowUnsupported: boolean, version: string = process.versions.node): void {
  if (allowUnsupported || satisfiesNodeRange(version)) return;
  throw new StudioError(
    "NODE_UNSUPPORTED",
    `Node.js ${version} is outside this Studio's supported range (${SUPPORTED_NODE}).`,
    "Run the CLI with Node 24 (the Studio checkout's .node-version). Pass --allow-unsupported-node only to render anyway: Chrome launch and close have hung on Node 26."
  );
}
