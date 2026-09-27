# Agent usage

Humans, Codex, Claude Code, and CI use the versioned `skills/se-widget-studio` workflow. Widget work uses the hosted Studio through the skill's built-in Node.js client by default, against an explicitly selected Studio origin. Local operation, for developing SE Widget Studio itself, for an explicitly requested local render, or for CI, uses a pinned CLI: the consumer's exact package dependency when it declares one, or a reviewed Studio checkout. Do not let an agent recreate the runtime inside a widget or run an unpinned remote package.

## Local CLI setup

Only a consumer that declares `se-widget-studio` in its `package.json` uses this setup; most widget repositories do not and use hosted mode. Install a built local checkout, or a tarball packed from one (`npm run build:engine && npm pack`), as an exact dependency. A Git dependency does not work: `dist/` is not versioned and the package has no `prepare` script. Confirm that `package-lock.json` records the resolved artifact, then use the local binary:

```bash
npm ci
npm exec -- se-widget-studio doctor . --json
npm exec -- se-widget-studio validate . --json
npm exec -- se-widget-studio test . --json
```

`npm exec --` resolves the binary from the consumer's locked `node_modules`; it does not need a global installation.

## Codex and Claude Code

The reusable instructions live at `skills/se-widget-studio/SKILL.md`, with focused references and `scripts/studio-client.mjs`. Add or link that complete directory—not only `SKILL.md`—to the agent surface's normal personal or project skill location.

For a portable installation on another machine, clone a reviewed repository revision and run:

```bash
node skills/install.mjs --list
node skills/install.mjs --skill se-widget-studio
```

The installer copies into `$CODEX_HOME/skills` or `~/.codex/skills` by default, accepts `--skills-dir /absolute/path/to/skills` for another agent surface, and refuses to replace existing targets. See `skills/INSTALL.md` for the complete install and verification workflow. Use `--link` only for development when the checkout will remain available.

For hosted requests, the client can import either supported production layout, explicitly upload declared local assets, store the editing capability in a private mode-0600 access bundle, open the editor, pull/push complete revisions with optimistic concurrency, run tests/renders, and download hash-verified artifacts. It defaults to `https://se-dev-kit.vercel.app`; use `--origin` for a different reviewed deployment. No package installation is required for the hosted client beyond the supported Node.js runtime.

Hosted mode is the skill's default for widget work. Local requests are limited to developing SE Widget Studio itself or an explicitly requested local render; they use the exact package dependency above when the consumer declares it, or a reviewed Studio checkout prepared with `npm ci && npm run build:engine` and run as `node <checkout>/dist/cli/index.js`.

Before editing or capturing, agents should inspect repository instructions and the working tree. In hosted mode they check the revision with `status`, run a test job before render jobs, and compute video frame totals before submitting, as the hosted reference describes. In local mode they run `doctor` and `validate` and dry-run recipe matrices. In both, they report exact output paths. `--allow-large-matrix` and `--allow-large-render` require deliberate workload review; agents must report the variant, frame, and target totals before using them. `--allow-low-disk` likewise requires reporting the dry run's estimated peak and free space (`plan.disk.summary`) first. `--keep-frames` is only for runs whose PNG frames someone will inspect or post-process (loop cuts, posters, stills, a higher-quality re-encode). They must not install a browser, FFmpeg, codecs, or fonts without explicit user authorization.

## CI

CI uses `npm ci`, the same CLI arguments, a declared system browser path, and optional declared FFmpeg/ffprobe paths. Browser and media jobs must not download tools at runtime. Keep generated media in a temporary or explicit artifact directory and pass `--force` only when replacing the exact planned outputs is intentional.
