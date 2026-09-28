# Repository instructions

This repository contains SE Widget Studio Web and its shared StreamElements simulation engine. The Next.js app lives at the repository root. It is a personal, link-accessed application using Vercel Blob, Workflows, and Sandbox; there is no external database.

- Use English for UI text, CLI help, field names, errors, tests, and documentation.
- Preserve strict TypeScript and ESM.
- Use React and Next.js for the application; consumer widgets remain plain HTML/CSS/JS/FIELDS.
- Never copy or rewrite consumer production widget files.
- Keep untrusted widgets in opaque-origin sandboxed iframes. Hosted uploads must never execute as Node configuration or be served as executable content on the editor origin.
- Never weaken path containment, bridge nonce/source/origin validation, external-network blocking, or output preflight. Sole exception, the Google Fonts proxy: trusted server code may GET `https://fonts.googleapis.com/css`, `https://fonts.googleapis.com/css2`, and `https://fonts.gstatic.com/s/*` with a fixed User-Agent, no redirects, no forwarded client headers or credentials, bounded size and time, and validated content. It keeps the bytes in an append-only, content-addressed cache whose objects and URL index are never overwritten or deleted (short-lived negative entries for upstream 4xx answers live outside that index), and serves them to previews and renders. Widget code never connects to Google or any other external origin: preview pages load subresources only from the Studio's read-only engine path and its cache-only font path, and render Sandboxes stay `deny-all` and receive fonts only as job files that the trusted worker answers with `route.fulfill`. Every other origin, redirect, and WebSocket stays blocked.
- Never download browsers, FFmpeg, codecs, or fonts from runtime code, except Google Fonts stylesheets and font files that trusted server code fetches through the proxy above.
- Require `--force` for exact output replacement; never recursively clean consumer output directories.
- Keep marketplace rules in dated JSON presets with official URLs.
- Keep built-in test media in `sample-media/` with its manifest. It is append-only: never change the bytes of a published `sws-sample:` reference; add a new file, manifest entry, and `tests/unit/sample-media.lock.json` entry instead. After `npm run build`, run `npm run verify:bundle`.
- Run `npm run typecheck`, `npm test`, `npm run build`, and proportional browser/media checks. Preserve the legacy engine tests.
- Store immutable revisions; full API replacement must use optimistic concurrency. Keep write capabilities out of iframe data, URLs sent to servers, and logs.
- Use local storage only outside Vercel. Vercel deployments must fail clearly if Blob or Sandbox configuration is missing; never silently fall back to ephemeral disk.
- Report local simulation separately from real StreamElements/OBS validation.

## The live skill and `main`

- The global `se-widget-studio` skill is a symlink to `skills/se-widget-studio/` in this checkout, and consumer sessions run this checkout's `dist/`. Whatever is on disk here is live for every agent session, committed or not.
- Work on `main`, without a worktree. Before ending a session, run `npm run build:engine` and commit, so `main` is clean and `dist/build-info.json` reports `"dirty": false`.
- Exception: work that waits for the owner's review (a render to watch, a UI to judge) is committed to a local branch (for example `tutorial-zoom`) and named in the final report, never left uncommitted on `main`. Return to `main` and rebuild `dist/` from it before ending the session.
- Skill text that depends on a code change ships in the same commit as that change: on the branch while the change waits for review, on `main` only once it is pushed and deployed. The skill never tells an agent to use a field, flag, or behavior that production rejects.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
