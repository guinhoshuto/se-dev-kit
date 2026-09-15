# Repository instructions

This repository contains SE Widget Studio Web and its shared StreamElements simulation engine. The Next.js app lives at the repository root. It is a personal, link-accessed application using Vercel Blob, Workflows, and Sandbox; there is no external database.

- Use English for UI text, CLI help, field names, errors, tests, and documentation.
- Preserve strict TypeScript and ESM.
- Use React and Next.js for the application; consumer widgets remain plain HTML/CSS/JS/FIELDS.
- Never copy or rewrite consumer production widget files.
- Keep untrusted widgets in opaque-origin sandboxed iframes. Hosted uploads must never execute as Node configuration or be served as executable content on the editor origin.
- Never weaken path containment, bridge nonce/source/origin validation, external-network blocking, or output preflight.
- Never download browsers, FFmpeg, codecs, or fonts from runtime code.
- Require `--force` for exact output replacement; never recursively clean consumer output directories.
- Keep marketplace rules in dated JSON presets with official URLs.
- Run `npm run typecheck`, `npm test`, `npm run build`, and proportional browser/media checks. Preserve the legacy engine tests.
- Store immutable revisions; full API replacement must use optimistic concurrency. Keep write capabilities out of iframe data, URLs sent to servers, and logs.
- Use local storage only outside Vercel. Vercel deployments must fail clearly if Blob or Sandbox configuration is missing; never silently fall back to ephemeral disk.
- Report local simulation separately from real StreamElements/OBS validation.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
