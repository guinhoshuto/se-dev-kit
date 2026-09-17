# SE Widget Studio Web

A personal, code-accessible workbench for StreamElements Custom Widgets. Submit HTML, CSS, JavaScript, and the real FIELDS schema through the API or web import screen, then use a private editing link to preview themes, run synthetic tests, and generate visual assets.

The Next.js application lives at this repository's root. Consumer widgets remain plain HTML/CSS/JS/FIELDS; they do not need React, a bundler, or changes to their production files. The shared simulation and renderer also remain available as a [local CLI](docs/CLI.md).

## What it does

- Imports versioned snapshots without modifying the original files.
- Runs widgets inside opaque-origin sandboxed iframes with runtime network access blocked.
- Generates controls from FIELDS, with themes, fixtures, scenes, framing, and a theme gallery.
- Saves immutable revisions and rejects stale full replacements instead of overwriting another editor's work.
- Runs deterministic browser scenarios and recipes for screenshots, thumbnails, contact sheets, and short silent videos.
- Uses the same shared engine for the web application, local CLI, and automated jobs.

There are no user accounts and no external database. In production, private Vercel Blob stores projects, revisions, uploads, and final artifacts; Workflows orchestrate jobs; short-lived Sandboxes run the browser/media worker. The editing link is a secret capability, not a public sharing link.

## Run locally

Requirements: Node.js `>=22.20 <23` or `>=24 <25`, npm `10.9.3`, and the committed lockfile. Browser jobs also require an already-installed Chrome/Chromium. Final video jobs require existing FFmpeg and ffprobe executables.

From the repository root, after authorizing dependency installation:

```sh
npm ci
npm run dev
```

Open `http://127.0.0.1:3000` and choose **Open demo project**, or import a [WidgetSnapshot JSON document](docs/API.md#snapshot-format). No Vercel credentials are needed locally. The default storage directory is `.studio-data`; keep it private and backed up if the projects matter.

Both `npm run dev` and `npm start` bind to `127.0.0.1`. To run the production build locally:

```sh
npm run build
npm start
```

The repository uses `playwright-core`. Normal startup, tests, and rendering never download Chromium, FFmpeg, codecs, or fonts. Install or select these tools deliberately; `SE_WIDGET_STUDIO_BROWSER`, `STUDIO_FFMPEG_PATH`, and `STUDIO_FFPROBE_PATH` can point to existing local executables.

## Environment modes

| Setting | Local development | Vercel deployment |
| --- | --- | --- |
| `STUDIO_STORAGE` | `local` (default outside Vercel) | `blob` |
| `STUDIO_EXECUTION` | `local` (default outside Vercel) | `vercel` |
| `STUDIO_DATA_DIR` | Optional; defaults to `.studio-data` | Not used as a fallback |
| Blob credentials | Not required | Private Blob integration token, or configured store ID and Vercel OIDC identity |
| `STUDIO_SANDBOX_SNAPSHOT_ID` | Not required | Required for jobs; trusted browser/media baseline |
| `STUDIO_CREATE_KEY` | Optional creation gate | Optional creation gate; clients send `X-Studio-Key` |

`.env.example` documents **local** values. Do not copy its `local` mode settings into Vercel. Hosted deployments reject local storage and local workers rather than silently using ephemeral disk. Configure production resources and variables, then redeploy; see [Vercel setup](docs/VERCEL.md). Installing a plugin or successfully building the app does not provision or validate those resources.

## API workflow

1. `POST /api/v1/projects` with a complete versioned snapshot.
2. Keep the returned capability secret; open `editorUrl` only in a trusted browser.
3. Read with `Authorization: Bearer <capability>`.
4. Replace the complete snapshot with `PUT` and the latest JSON response's `etag` as `If-Match`.
5. Submit a test or render job, poll its status, and download authorized artifacts.

The [API reference](docs/API.md) includes runnable import examples, schemas, uploads, previews, history, limits, and error handling. A `201` response may contain a `blocked` revision: inspect its diagnostics before attempting a preview or job.

## Safety and scope

Editing capabilities travel in an initial URL fragment and authorized request headers, not query parameters. Keep them out of Git, screenshots, logs, prompts, and widget data. Anyone holding a capability can read and edit that project. There is currently no account recovery, capability rotation, or project deletion API.

Source is retained as submitted in immutable revisions. A separate derived snapshot captures supported dependencies for offline rendering; uploaded code is never evaluated as Node.js configuration. Public HTTPS dependencies may be fetched during preparation under address, size, and time limits. Runtime fetches, module imports, and dynamic resource discovery are not supported. Use synthetic identities/events only—never real StreamElements tokens, cookies, webhooks, private messages, or channel data.

FIELDS defaults, theme, fixture, scene, and explicit overrides are separate layers. Presentation settings such as viewport, background, crop, and visual zoom are not injected into `fieldData`. Marketplace rules remain in dated presets under `presets/marketplaces`, with source URLs; they are not baked into the renderer.

This is a partial local simulation, not a guarantee of real StreamElements or OBS compatibility. Keep a final check in the actual target runtime. Hosted credentials, quotas, storage, and Sandbox execution also need separate hosted validation.

## Verify the repository

```sh
npm run typecheck
npm test
npm run build
```

For the production-browser workflow, keep this server running in one terminal:

```sh
STUDIO_STORAGE=local STUDIO_EXECUTION=local STUDIO_DATA_DIR=.studio-data/validation-server npm start -- --port 4317
```

Then run in another terminal, with an existing browser and FFmpeg/ffprobe available:

```sh
node scripts/verify-web.mjs
node --import tsx scripts/verify-field-precedence.mjs
```

The script accepts only loopback targets, creates synthetic projects/jobs, and writes screenshots, generated media, and a JSON report into a new `.studio-data/verification-*` directory. It is not a hosted-deployment check. Repeated runs consume the local store's personal daily budgets; use a new deliberate validation store when needed, without deleting unrelated data.

The field regression script verifies fixture precedence, scene persistence, and temporary overrides. For protected creation, start a separate local server on port 4318 with `STUDIO_CREATE_KEY=test-only-local-creation-key`, then run `node scripts/verify-protected-create.mjs`. This deliberately synthetic key must never be used on a hosted deployment. See the [validation record](docs/VALIDATION.md) for evidence and the remaining hosted checks.

After configuring and deploying the trusted Sandbox snapshot, run the bounded production check explicitly:

```sh
node scripts/verify-hosted.mjs \
  --base-url https://your-studio.example/ \
  --allow-hosted \
  --ffprobe /absolute/path/to/an/existing/ffprobe
```

It creates one synthetic project and at most three jobs (smoke, one 320×240 PNG, and one one-second silent MP4), then verifies authorization, optimistic concurrency, iframe policy, artifact hashes, image dimensions, and video streams. Evidence and the private resume capability are written under ignored `.studio-data/`; never publish `access.private.json`. The command neither downloads tools nor deletes remote data. Use `--resume` with that private file after an interrupted run instead of creating another project.

## Guides

- [Web API and snapshot schema](docs/API.md)
- [Vercel storage and Sandbox setup](docs/VERCEL.md)
- [Shared local CLI and packaging](docs/CLI.md)
- [Catalog configuration](docs/CONFIGURATION.md), [runtime](docs/RUNTIME.md), and [media capture](docs/CAPTURE.md)
- [Agent and CI usage](docs/AGENT_USAGE.md)

The CLI guides describe trusted local configuration and its wider limits. Hosted JSON imports accept only the data schemas and stricter limits in the API reference.
