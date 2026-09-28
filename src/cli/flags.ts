import type {Command} from "commander";

/** Options declared with a `<file>` or `<directory>` argument take a local path. */
const PATH_ARGUMENT = /<(?:file|directory)>/;

/**
 * The options a command was given on the command line, global ones first, as `--name` for a switch
 * and `--name value` for a value, once per repeated value. Positional arguments and defaults are
 * left out, and a path value is recorded as `<path>`, because manifests hold no local paths. Render
 * manifests record it as `studio.cliFlags`.
 */
export function cliFlags(command: Command): string[] {
  const flags: string[] = [];
  for (const owner of [command.parent, command]) {
    if (!owner) continue;
    for (const option of owner.options) {
      const key = option.attributeName();
      if (owner.getOptionValueSource(key) !== "cli") continue;
      const name = option.long ?? option.short ?? key;
      const value: unknown = owner.getOptionValue(key);
      const shown = (item: unknown) => (PATH_ARGUMENT.test(option.flags) ? "<path>" : String(item));
      if (value === true) flags.push(name);
      else if (Array.isArray(value)) for (const item of value) flags.push(name, shown(item));
      else if (value !== false && value !== undefined) flags.push(name, shown(value));
    }
  }
  return flags;
}
