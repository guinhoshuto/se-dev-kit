# Agent usage

Humans, Codex, Claude Code, and CI should invoke the same exact local dependency. Do not let an agent recreate the runtime inside a widget or run an unpinned remote package.

## Consumer setup

Install a reviewed tarball, local checkout, or Git commit as an exact dependency. Confirm that `package-lock.json` records the resolved artifact, then use the local binary:

```bash
npm ci
npm exec -- se-widget-studio doctor . --json
npm exec -- se-widget-studio validate . --json
npm exec -- se-widget-studio test . --json
```

`npm exec --` resolves the binary from the consumer's locked `node_modules`; it does not need a global installation.

## Codex and Claude Code

The reusable instructions live at `skills/se-widget-studio/SKILL.md`. Add that directory to the agent surface's normal personal or project skill location, or copy the file into the consumer repository's supported skills directory. The skill is instructions only; it still requires the exact package dependency and lockfile above.

Before editing or capturing, agents should inspect repository instructions and the working tree, run `doctor` and `validate`, dry-run recipe matrices, and report exact output paths. `--allow-large-matrix` and `--allow-large-render` require deliberate workload review; agents must report the variant, frame, and target totals before using them. They must not install a browser, FFmpeg, codecs, or fonts without explicit user authorization.

## CI

CI uses `npm ci`, the same CLI arguments, a declared system browser path, and optional declared FFmpeg/ffprobe paths. Browser and media jobs must not download tools at runtime. Keep generated media in a temporary or explicit artifact directory and pass `--force` only when replacing the exact planned outputs is intentional.
