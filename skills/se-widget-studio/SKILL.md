---
name: se-widget-studio
description: Upload, edit, preview, test, capture, and render StreamElements Custom Widgets with the hosted SE Widget Studio, which is the default. Use for widget links, themes, fixtures, screenshots, contact sheets, marketing batches, and short videos; use the local CLI only to develop SE Widget Studio itself or when the user explicitly asks for a local render. Do not use it as a real StreamElements API client.
---

# SE Widget Studio

Operate the shared Studio instead of building a widget-specific preview runtime. Resolve all referenced files relative to this `SKILL.md`.

## Choose the mode

- Use **hosted mode** by default for every widget task: upload, editing links, saved projects, previews, smoke tests, screenshots, videos, and marketing assets. Read [references/hosted-workflow.md](references/hosted-workflow.md) before the first hosted mutation, including its limits and known gaps. Split a large batch as that reference describes instead of switching to local mode.
- Use **local mode** only to develop or debug SE Widget Studio itself, or when the user explicitly asks for a local render. Read [references/local-workflow.md](references/local-workflow.md), including its section on developing the Studio.
- Read [references/catalog-authoring.md](references/catalog-authoring.md) when themes, fixtures, scenes, scenarios, recipes, crop, camera, matrix variants, or video settings must be created or changed.
- Read [references/tutorial-video.md](references/tutorial-video.md) before authoring or rendering a tutorial video (`"mode": "tutorial"`): a "how to configure" walkthrough of the widget in a replica of the StreamElements overlay editor, which hosted jobs limit to 15 seconds.

## Preserve the source contract

- Inspect repository instructions and the working tree before reading or changing a consumer widget.
- Treat production HTML, CSS, JavaScript, and FIELDS as source. Never rewrite or copy them merely to make Studio work.
- Put Studio-only behavior in JSON catalogs or the consumer's existing versioned Studio configuration.
- Keep `fieldData` separate from background, viewport, output size, camera, crop, and device scale.
- For test media, use the Studio's built-in sample images (`sws-sample:` references listed in [references/catalog-authoring.md](references/catalog-authoring.md#sample-media)) instead of generating, downloading, or uploading images, and never copy them into the widget. The hosted client refuses them before any change when the selected deployment does not serve them; then stop and tell the user the deployment must be updated, rather than working around it.
- Use only synthetic, public-safe channel data, identities, messages, and events. Never submit StreamElements tokens, cookies, webhooks, private messages, or viewer data.

## Hosted operation rules

Use `scripts/studio-client.mjs`; it defaults to `https://se-dev-kit.vercel.app` and accepts `--origin` when the user selected another deployment.

- Project capabilities and signed Blob URLs are secrets. Keep access bundles mode `0600`; never print, quote, attach, commit, or paste their contents.
- Creation may read `STUDIO_CREATE_KEY` from the environment. Never request its value in chat or pass it as a command-line argument. If creation returns HTTP 403, ask the user to set it in the environment that runs the helper, and do not retry until they confirm.
- A `blocked` import already created the project and prints its diagnostics. Fix them with `pull`/`push` on that project; never import again.
- `pull` produces a capability-free draft with an opaque `etag`. Edit the complete `snapshot`, then `push`. A conflict must stop for reconciliation; never refetch and overwrite silently.
- `run` requires a new output directory, polls one accepted job on its own route, downloads authorized artifacts without forwarding the bearer token to Blob, and verifies byte counts and SHA-256.
- Open the private editor only when the user requests it, using `open-editor`, which also accepts the `access.private.json` that `scripts/verify-hosted.mjs` writes; do not expose the fragment URL in a response or tool argument. If `open-editor` fails, stop and report its error: never assemble the URL yourself, and never open it through a browser automation tool, whose results repeat the address.
- Google Fonts work as in StreamElements, in preview and in jobs (see "Fonts" in [references/hosted-workflow.md](references/hosted-workflow.md#fonts)); never vendor fonts or edit the widget for them. Other runtime network requests stay blocked.
- Hosted actions consume personal project/job/storage/Sandbox quotas. Do not retry mutations automatically after an uncertain response. Resume or inspect the accepted project/job instead.

## Local operation rules

Invoke a pinned CLI, never an unpinned remote package: the consumer's locked dependency through `npm exec -- se-widget-studio` when the widget declares it, or a reviewed Studio checkout prepared with `npm ci && npm run build:engine` and run as `node <checkout>/dist/cli/index.js` on Node 24 (local captures and renders refuse a Node.js outside `engines`). Check current `--help`, then run `doctor` and `validate` before browser/media work. Dry-run recipe matrices before rendering and report their frame, file, and disk estimates. Never install a browser, FFmpeg, codecs, or fonts without explicit authorization. Require `--force` before replacing exact outputs, and never recursively clean a consumer directory.

## Completion evidence

Report the project ID and private access-file path, never its capability. For edits, report the new immutable revision. For jobs, report terminal status, exact local artifact paths, byte counts, hashes, and media validation. Keep local/hosted simulation separate from real StreamElements and OBS validation.
