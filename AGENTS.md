# Repository instructions

This repository contains SE Widget Studio Web and its shared StreamElements simulation engine. The Next.js app lives at the repository root. It is a personal application that runs locally by default (`npm run serve`, loopback only, local storage and jobs); its hosted deployment, using Vercel Blob, Workflows, and Sandbox, is paused since 2026-10-01. There is no external database.

- Use English for UI text, CLI help, field names, errors, tests, and documentation. Talk to the owner in Portuguese, including after reading English code, docs, or reports.
- Preserve strict TypeScript and ESM.
- Use React and Next.js for the application; consumer widgets remain plain HTML/CSS/JS/FIELDS.
- Never copy or rewrite consumer production widget files.
- Keep untrusted widgets in opaque-origin sandboxed iframes. Hosted uploads must never execute as Node configuration or be served as executable content on the editor origin.
- Never weaken path containment, bridge nonce/source/origin validation, external-network blocking, or output preflight. Sole exception, the Google Fonts proxy: trusted server code may GET `https://fonts.googleapis.com/css`, `https://fonts.googleapis.com/css2`, and `https://fonts.gstatic.com/s/*` with a fixed User-Agent, no redirects, no forwarded client headers or credentials, bounded size and time, and validated content. It keeps the bytes in an append-only, content-addressed cache whose objects and URL index are never overwritten or deleted (short-lived negative entries for upstream 4xx answers live outside that index), and serves them to previews and renders. Widget code never connects to Google or any other external origin: preview pages load subresources only from the Studio's read-only engine path and its cache-only font path, and render Sandboxes stay `deny-all` and receive fonts only as job files that the trusted worker answers with `route.fulfill`. Every other origin, redirect, and WebSocket stays blocked.
- Never download browsers, FFmpeg, codecs, or fonts from runtime code, except Google Fonts stylesheets and font files that trusted server code fetches through the proxy above.
- Require `--force` for exact output replacement; never recursively clean consumer output directories.
- Keep marketplace rules in dated JSON presets with official URLs.
- Keep built-in test media in `sample-media/` with its manifest. It is append-only: never change the bytes of a published `sws-sample:` reference; add a new file, manifest entry, and `tests/unit/sample-media.lock.json` entry instead. Only the owner's explicit request removes one: delete its file, move its manifest entry to `retired` with the date, and keep its lock entry; a retired reference never returns. After `npm run build`, run `npm run verify:bundle`.
- Run `npm run typecheck`, `npm test`, `npm run build`, and proportional browser/media checks. Preserve the legacy engine tests.
- `npm test` runs the `unit` and `web` suites in parallel and the suites that start Chrome (`integration`, `web:browser`) one file at a time; a test without its own timeout fails after two minutes. Every run logs to `.cache/test-logs/<run>/`: quote that log for a failure. A browser suite holds the machine-wide render slot `~/.cache/render-slot` while it runs. The slot has one implementation for every repo: `src/shared/render-slot.ts` is a byte-for-byte copy of `~/obsidian/AI/scripts/render-slot.ts` (background-creator keeps another); never edit the copy, edit the source and run `python3 ~/obsidian/AI/scripts/render_slot_copias.py --write`, and a unit test fails while they differ. A browser suite is skipped, with the reason, below 3 GiB of free disk, while another process holds the slot, and while the machine check every repo shares (`~/obsidian/AI/scripts/maquina_livre.py`: other renders, the game, free memory, swap and disk) says to wait, or, where it is missing, while another session renders. A run that prints `NOT COVERED` did not test it. Local `capture`, `record`, and `render` wait for the slot in the order they came, up to 4 hours (a Studio job, 30 minutes); `--dry-run` does not take it. Name a web test that starts Chrome `[browser] …`. A test removes every temporary folder it creates: the runner fails a suite that leaves one behind.
- Use Node 24 (`.node-version`). Node 26 is outside `engines`: renders on it have hung while Chrome launched or closed, and local `capture`, `record`, and `render` refuse it unless `--allow-unsupported-node` is passed. Where Node 24 is Homebrew's keg-only `node@24`, put it first for every command: `PATH=/opt/homebrew/opt/node@24/bin:$PATH`.
- Hunt an intermittent test with `npm run test:repeat -- <file> [count]`. After an interrupted run, `npm run kill-stale` kills only this checkout's orphan Chromes and test workers, and `npm run wait-free` waits until the machine check says the machine is free (or, where it is missing, until no other process holds the render slot and no other session renders). Never `pkill` Chrome.
- Store immutable revisions; full API replacement must use optimistic concurrency. Keep write capabilities out of iframe data, URLs sent to servers, and logs.
- Use local storage only outside Vercel. Vercel deployments must fail clearly if Blob or Sandbox configuration is missing; never silently fall back to ephemeral disk.
- Report local simulation separately from real StreamElements/OBS validation.

## The live checkout, `main`, and worktrees

- The live checkout is this repository's main directory (`~/dev/firulas/se-dev-kit`). The global `se-widget-studio` skill is a symlink to its `skills/se-widget-studio/`, consumer sessions run its `dist/`, and the local Studio (`npm run serve`, `http://127.0.0.1:4310`) runs its `.next/` build with its `.studio-data/`. Whatever is on disk there is live for every agent session, committed or not.
- The live checkout stays on a clean `main`. Never switch its branch, and never build anything there but `main`.
- Make every change in a worktree on a `wip/<task>` branch: `git worktree add .claude/worktrees/<task> -b wip/<task> main`. When disk is short, symlink the live `node_modules` into it instead of a second `npm ci` (`node_modules` is listed in `.git/info/exclude`). Test there; `npm run dev` in a worktree serves port 3000 and never touches port 4310.
- Work that waits for the owner's review (a render to watch, a UI to judge) stays committed on its branch, in its worktree, and is named in the final report.
- A finished change reaches `main` by merge, with the owner's yes. Then, in the live checkout, run `npm run build` (engine and web app), check that `dist/build-info.json` reports `"dirty": false`, and restart the local Studio if you started it; when another session's server is running, tell the user it serves the old build. Remove the worktree once its branch is merged or dropped: `git worktree remove .claude/worktrees/<task>`.
- Skill text that depends on a code change ships in the same commit as that change, and reaches `main` only with it. The skill never tells an agent to use a field, flag, or behavior that the local Studio on `main` rejects.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
