import assert from "node:assert/strict";
import test from "node:test";
import {Command} from "commander";

import {cliFlags} from "../../dist/cli/flags.js";

/** A program shaped like the CLI: global options, a command with a positional root, switches, values, and a repeatable option. */
function parse(argv) {
  let flags;
  const program = new Command().exitOverride().option("--config <file>").option("--json");
  program
    .command("render")
    .argument("[root]", "Widget root", ".")
    .option("--recipe <id>", "Recipe", (value, previous) => previous.concat(value), [])
    .option("--limit <count>", "Limit", (value) => Number(value))
    .option("--force")
    .option("--keep-frames")
    .option("--output <directory>", "Output", "studio-output")
    .action((_root, _options, command) => {
      flags = cliFlags(command);
    });
  program.parse(argv, {from: "user"});
  return flags;
}

test("cliFlags records the options given on the command line, globals first, without positionals, defaults, or local paths", () => {
  assert.deepEqual(
    parse(["render", "/widgets/chat", "--recipe", "stills", "--keep-frames", "--json", "--recipe", "clip", "--limit", "12", "--config", "/widgets/chat/studio.mjs"]),
    ["--config", "<path>", "--json", "--recipe", "stills", "--recipe", "clip", "--limit", "12", "--keep-frames"]
  );
  assert.deepEqual(parse(["render"]), [], "the default --output and the empty --recipe list were not given");
  assert.deepEqual(parse(["render", ".", "--output", "studio-output", "--force"]), ["--force", "--output", "<path>"], "a value equal to the default was still given");
});
