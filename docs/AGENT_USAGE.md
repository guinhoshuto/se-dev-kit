# Agent usage

Humans, Codex, Claude Code, and CI use the versioned `skills/se-widget-studio` workflow. Hosted operation uses its built-in Node.js client against an explicitly selected Studio origin. Local operation invokes the same exact package dependency for every agent. Do not let an agent recreate the runtime inside a widget or run an unpinned remote package.

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

The reusable instructions live at `skills/se-widget-studio/SKILL.md`, with focused references and `scripts/studio-client.mjs`. Add or link that complete directory—not only `SKILL.md`—to the agent surface's normal personal or project skill location.

For hosted requests, the client can import either supported production layout, explicitly upload declared local assets, store the editing capability in a private mode-0600 access bundle, open the editor, pull/push complete revisions with optimistic concurrency, run tests/renders, and download hash-verified artifacts. It defaults to `https://se-dev-kit.vercel.app`; use `--origin` for a different reviewed deployment. No package installation is required for the hosted client beyond the supported Node.js runtime.

For local requests, the skill still requires the exact package dependency and lockfile above.

Before editing or capturing, agents should inspect repository instructions and the working tree, run `doctor` and `validate`, dry-run recipe matrices, and report exact output paths. `--allow-large-matrix` and `--allow-large-render` require deliberate workload review; agents must report the variant, frame, and target totals before using them. They must not install a browser, FFmpeg, codecs, or fonts without explicit user authorization.

## CI

CI uses `npm ci`, the same CLI arguments, a declared system browser path, and optional declared FFmpeg/ffprobe paths. Browser and media jobs must not download tools at runtime. Keep generated media in a temporary or explicit artifact directory and pass `--force` only when replacing the exact planned outputs is intentional.
