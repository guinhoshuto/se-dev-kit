---
name: se-widget-studio
description: Upload, edit, preview, test, capture, and render StreamElements Custom Widgets with SE Widget Studio, run locally on this machine from the Studio checkout, which is the default. Use for widget links, themes, fixtures, screenshots, contact sheets, marketing batches, and videos; use the local CLI to develop SE Widget Studio itself or when PNG frames must be kept. Do not use it as a real StreamElements API client.
---

# SE Widget Studio

Operate the shared Studio instead of building a widget-specific preview runtime. Resolve all referenced files relative to this `SKILL.md`.

## Choose the mode

- Use the **local Studio** by default for every widget task: upload, editing links, saved projects, previews, smoke tests, screenshots, videos, and marketing assets. It is the Studio web app running on this machine at `http://127.0.0.1:4310`, driven by `scripts/studio-client.mjs`. Read [references/studio-workflow.md](references/studio-workflow.md) before the first import, including how to start the server and its limits.
- The **hosted deployment** (`https://se-dev-kit.vercel.app`) is paused: its storage is suspended and it is not maintained. Use it only when the user explicitly asks, with `--origin`, and read the hosted section of [references/studio-workflow.md](references/studio-workflow.md#hosted-deployment-paused) first.
- Use the **local CLI** to develop or debug SE Widget Studio itself, or when a render must keep its PNG frames (`--keep-frames`, for loop cuts, posters, or stills) and the widget needs no Google Fonts, which the CLI blocks. Read [references/local-workflow.md](references/local-workflow.md), including its section on developing the Studio.
- Read [references/catalog-authoring.md](references/catalog-authoring.md) when themes, fixtures, scenes, scenarios, recipes, crop, camera, matrix variants, or video settings must be created or changed.
- Read [references/tutorial-video.md](references/tutorial-video.md) before authoring or rendering a tutorial video (`"mode": "tutorial"`): a "how to configure" walkthrough of the widget in a replica of the StreamElements overlay editor.
- Read [references/known-limits.md](references/known-limits.md) before planning marketing media, and [references/marketing-assets.md](references/marketing-assets.md) when the media is for a store listing.

## Preserve the source contract

- Inspect repository instructions and the working tree before reading or changing a consumer widget.
- Treat production HTML, CSS, JavaScript, and FIELDS as source. Never rewrite or copy them merely to make Studio work.
- Put Studio-only behavior in JSON catalogs or the consumer's existing versioned Studio configuration.
- Keep `fieldData` separate from background, viewport, output size, camera, crop, and device scale.
- For test media, use the Studio's built-in sample images (`sws-sample:` references listed in [references/catalog-authoring.md](references/catalog-authoring.md#sample-media)) instead of generating, downloading, or uploading images, and never copy them into the widget. The client refuses them before any change when the selected Studio does not serve them; then stop and tell the user the Studio must be updated, rather than working around it.
- Use only synthetic, public-safe channel data, identities, messages, and events. Never submit StreamElements tokens, cookies, webhooks, private messages, or viewer data.

## Studio operation rules

Use `scripts/studio-client.mjs`; it defaults to the local Studio, `http://127.0.0.1:4310`, and accepts `--origin` (or `SE_WIDGET_STUDIO_URL`) for another Studio.

- The local Studio runs from the Studio checkout this skill belongs to (`<skill>/../..`), on `main`. If the client answers `No Studio is running at …`, start it as [references/studio-workflow.md](references/studio-workflow.md#start-the-local-studio) describes, then run the command again. Stop only a server you started, when the task ends.
- Project capabilities and signed URLs are secrets. Keep access bundles mode `0600`; never print, quote, attach, commit, or paste their contents.
- A `blocked` import already created the project and prints its diagnostics. Fix them with `pull`/`push` on that project; never import again.
- `pull` produces a capability-free draft with an opaque `etag`. Edit the complete `snapshot`, then `push`. A conflict must stop for reconciliation; never refetch and overwrite silently.
- `run` requires a new output directory, polls one accepted job on its own route, downloads authorized artifacts, and verifies byte counts and SHA-256.
- A local job is a heavy render: it waits for the machine-wide render slot, as the CLI does, and is refused by the disk guard when its frames would not fit. Run one job at a time.
- Open the private editor only when the user requests it, using `open-editor`; do not expose the fragment URL in a response or tool argument. If `open-editor` fails, stop and report its error: never assemble the URL yourself, and never open it through a browser automation tool, whose results repeat the address.
- Google Fonts work as in StreamElements, in preview and in jobs (see "Fonts" in [references/studio-workflow.md](references/studio-workflow.md#fonts)); never vendor fonts or edit the widget for them. Other runtime network requests stay blocked.
- Do not retry a mutation automatically after an uncertain response. Resume or inspect the accepted project or job instead.

## Local CLI rules

Invoke a pinned CLI, never an unpinned remote package: the consumer's locked dependency through `npm exec -- se-widget-studio` when the widget declares it, or a reviewed Studio checkout prepared with `npm ci && npm run build:engine` and run as `node <checkout>/dist/cli/index.js` on Node 24 (local captures and renders refuse a Node.js outside `engines`). Check current `--help`, then run `doctor` and `validate` before browser/media work. Dry-run recipe matrices before rendering and report their frame, file, and disk estimates. Never install a browser, FFmpeg, codecs, or fonts without explicit authorization. Require `--force` before replacing exact outputs, and never recursively clean a consumer directory.

## Completion evidence

Report the Studio origin, the project ID, and the private access-file path, never its capability. For edits, report the new immutable revision. For jobs, report terminal status, exact local artifact paths, byte counts, hashes, and media validation. Keep Studio simulation separate from real StreamElements and OBS validation.
