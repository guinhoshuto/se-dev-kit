---
name: se-widget-studio
description: Upload, edit, preview, test, capture, and render StreamElements Custom Widgets with the hosted SE Widget Studio or its locked local CLI. Use for widget links, themes, fixtures, screenshots, contact sheets, and short videos; do not use it as a real StreamElements API client.
---

# SE Widget Studio

Operate the shared Studio instead of building a widget-specific preview runtime. Resolve all referenced files relative to this `SKILL.md`.

## Choose the mode

- Use **hosted mode** when the user asks to upload a widget, create or open an editing link, manipulate a saved project, run remote smoke tests, or generate downloadable images/videos. Read [references/hosted-workflow.md](references/hosted-workflow.md) before the first hosted mutation.
- Use **local mode** when working inside a widget checkout, iterating without upload, validating a config, or rendering directly to a local output directory. Read [references/local-workflow.md](references/local-workflow.md).
- Read [references/catalog-authoring.md](references/catalog-authoring.md) when themes, fixtures, scenes, scenarios, recipes, crop, camera, matrix variants, or video settings must be created or changed.

## Preserve the source contract

- Inspect repository instructions and the working tree before reading or changing a consumer widget.
- Treat production HTML, CSS, JavaScript, and FIELDS as source. Never rewrite or copy them merely to make Studio work.
- Put Studio-only behavior in JSON catalogs or the consumer's existing versioned Studio configuration.
- Keep `fieldData` separate from background, viewport, output size, camera, crop, and device scale.
- Use only synthetic, public-safe channel data, identities, messages, and events. Never submit StreamElements tokens, cookies, webhooks, private messages, or viewer data.

## Hosted operation rules

Use `scripts/studio-client.mjs`; it defaults to `https://se-dev-kit.vercel.app` and accepts `--origin` when the user selected another deployment.

- Project capabilities and signed Blob URLs are secrets. Keep access bundles mode `0600`; never print, quote, attach, commit, or paste their contents.
- Creation may read `STUDIO_CREATE_KEY` from the environment. Never request its value in chat or pass it as a command-line argument.
- `pull` produces a capability-free draft with an opaque `etag`. Edit the complete `snapshot`, then `push`. A conflict must stop for reconciliation; never refetch and overwrite silently.
- `run` requires a new output directory, polls one accepted job, downloads authorized artifacts without forwarding the bearer token to Blob, and verifies byte counts and SHA-256.
- Open the private editor only when the user requests it, using `open-editor`; do not expose the fragment URL in a response or tool argument.
- Hosted actions consume personal project/job/storage/Sandbox quotas. Do not retry mutations automatically after an uncertain response. Resume or inspect the accepted project/job instead.

## Local operation rules

Use the installed, lockfile-pinned package through `npm exec -- se-widget-studio`; never run an unpinned remote package. Check current `--help`, then run `doctor` and `validate` before browser/media work. Dry-run recipe matrices before rendering. Never install a browser, FFmpeg, codecs, or fonts without explicit authorization. Require `--force` before replacing exact outputs, and never recursively clean a consumer directory.

## Completion evidence

Report the project ID and private access-file path, never its capability. For edits, report the new immutable revision. For jobs, report terminal status, exact local artifact paths, byte counts, hashes, and media validation. Keep local/hosted simulation separate from real StreamElements and OBS validation.
