# SE Widget Studio Web

A personal, code-accessible workbench for StreamElements Custom Widgets. Submit HTML, CSS, JavaScript, and the real FIELDS schema through the API or web import screen, then use a private editing link to preview themes, run synthetic tests, and generate visual assets.

The Next.js application lives at this repository's root. Consumer widgets remain plain HTML/CSS/JS/FIELDS; they do not need React, a bundler, or changes to their production files. The shared simulation and renderer also remain available as a [local CLI](docs/CLI.md).

## What it does

- Imports versioned snapshots without modifying the original files.
- Runs widgets inside opaque-origin sandboxed iframes with runtime network access blocked. Google Fonts are the one exception, and widgets load them as in StreamElements: trusted server code fetches them into an append-only cache, and previews and jobs get them from there ([Google Fonts](docs/RUNTIME.md#google-fonts)).
- Substitutes `{{field}}` placeholders in HTML, CSS, and JavaScript, and reloads the widget when a field changes, as the StreamElements editor does.
- Generates controls from FIELDS, with themes, fixtures, scenes, framing, and a theme gallery.
- Saves immutable revisions and rejects stale full replacements instead of overwriting another editor's work.
- Runs deterministic browser scenarios and recipes for screenshots, thumbnails, contact sheets, and short silent videos.
- Uses the same shared engine for the web application, local CLI, and automated jobs.
- Ships built-in synthetic sample images, so a widget can be previewed, tested, and rendered without creating or uploading media.

There are no user accounts and no external database. In production, private Vercel Blob stores projects, revisions, uploads, and final artifacts; Workflows orchestrate jobs; short-lived Sandboxes run the browser/media worker. The editing link is a secret capability, not a public sharing link.

## Run locally

Requirements: Node.js `>=22.20 <23` or `>=24 <25`, npm `10.9.3`, and the committed lockfile. Browser jobs also require an already-installed Chrome/Chromium. Final video jobs require existing FFmpeg and ffprobe executables.

From the repository root, after authorizing dependency installation:

```sh
npm ci
npm run dev
```

Open `http://127.0.0.1:3000` and choose **Open demo project**, or import a [WidgetSnapshot JSON document](docs/API.md#snapshot-format). No Vercel credentials are needed locally. The default storage directory is `.studio-data`; keep it private and backed up if the projects matter.

Both `npm run dev` and `npm start` bind to `127.0.0.1`. The Studio that agents use by default is the production build on port 4310, which the `se-widget-studio` skill's client targets:

```sh
npm run build
npm run serve    # http://127.0.0.1:4310
```

Outside Vercel the Studio drops the hosted deployment's quotas (daily budgets, ten-minute jobs, 15-second videos, four video variants, 900 frames per job); a job instead waits for the machine-wide render slot and keeps the render disk guard (`lib/limits.ts`). The hosted deployment is paused since 2026-10-01.

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

## Sample media

[`sample-media/`](sample-media/README.md) holds 2 gallery images (webcam-style streamer photos, 1672x941) and 7 stage backdrops (1254x1254), all AI-generated. Reference one in catalog data as the whole string `sws-sample:<file>`, for example `"image": "sws-sample:gallery/streamer-1.jpg"`, an array for `multiple` image fields, or `"background": {"id": "plants", "image": "sws-sample:backdrops/plants.jpg"}`. The local CLI, the hosted preview, and hosted jobs resolve the same verified files; nothing is copied into the widget. Empty image fields stay empty unless you choose a sample or press **Fill empty image fields** in an editor, because StreamElements shows them empty too. The list of references, alt text, and backdrop tones is in [`sample-media/manifest.json`](sample-media/manifest.json).

## Safety and scope

Editing capabilities travel in an initial URL fragment and authorized request headers, not query parameters. Keep them out of Git, screenshots, logs, prompts, and widget data. Anyone holding a capability can read and edit that project. There is currently no account recovery, capability rotation, or project deletion API.

Source is retained as submitted in immutable revisions. A separate derived snapshot captures supported dependencies for offline rendering; uploaded code is never evaluated as Node.js configuration. Public HTTPS dependencies may be fetched during preparation under address, size, and time limits. Runtime fetches, module imports, and dynamic resource discovery are not supported, except for Google Fonts, which the Studio resolves from its cache. Use synthetic identities/events only—never real StreamElements tokens, cookies, webhooks, private messages, or channel data.

FIELDS defaults, theme, fixture, scene, and explicit overrides are separate layers. Presentation settings such as viewport, background, crop, and visual zoom are not injected into `fieldData`. Marketplace rules remain in dated presets under `presets/marketplaces`, with source URLs; they are not baked into the renderer.

This is a partial local simulation, not a guarantee of real StreamElements or OBS compatibility. Keep a final check in the actual target runtime. Hosted credentials, quotas, storage, and Sandbox execution also need separate hosted validation.

## Verify the repository

```sh
npm run typecheck
npm test
npm run build
npm run verify:bundle
```

`verify:bundle` checks that the traced sample media list, import, preview, job, and workflow functions and the npm package contain every file in `sample-media/manifest.json`.

For the production-browser workflow, keep this server running in one terminal:

```sh
STUDIO_STORAGE=local STUDIO_EXECUTION=local STUDIO_DATA_DIR=.studio-data/validation-server npm start -- --port 4317
```

Then run in another terminal, with an existing browser and FFmpeg/ffprobe available:

```sh
node scripts/verify-web.mjs
node --import tsx scripts/verify-field-precedence.mjs
node scripts/verify-font-control.mjs
```

The script accepts only loopback targets, creates synthetic projects/jobs, and writes screenshots, generated media, and a JSON report into a new `.studio-data/verification-*` directory. It is not a hosted-deployment check. Repeated runs consume the local store's personal daily budgets; use a new deliberate validation store when needed, without deleting unrelated data.

The field regression script verifies fixture precedence, scene persistence, and temporary overrides. For protected creation, start a separate local server on port 4318 with `STUDIO_CREATE_KEY=test-only-local-creation-key`, then run `node scripts/verify-protected-create.mjs`. This deliberately synthetic key must never be used on a hosted deployment. See the [validation record](docs/VALIDATION.md) for the latest local and hosted evidence.

After configuring and deploying the trusted Sandbox snapshot, run the bounded production check explicitly:

```sh
node scripts/verify-hosted.mjs \
  --base-url https://your-studio.example/ \
  --allow-hosted \
  --ffprobe /absolute/path/to/an/existing/ffprobe
```

It creates one synthetic project and at most three jobs (smoke, one 320×240 PNG, and one one-second silent MP4), then verifies authorization, optimistic concurrency, iframe policy, artifact hashes, image dimensions, and video streams. Evidence and the private resume capability are written under ignored `.studio-data/`; never publish `access.private.json`. The command neither downloads tools nor deletes remote data. Use `--resume` with that private file after an interrupted run instead of creating another project.

To wait for a push to go live instead of sleeping, run it first with `--wait-for $(git rev-parse HEAD)` in place of `--ffprobe`: it asks `GET /api/v1/version` every 10 seconds (`--wait-interval`), creates nothing, returns when the deployed commit matches, and exits 1 with the last answer after 10 minutes (`--wait-timeout`, in seconds). Chain the verification after it with `&&`.

With `--integration`, the same script calls no hosted API: it runs `tests/integration` inside a clone of the renderer snapshot, on its HeadlessChrome, to reproduce a failure of that browser without downloading it (see [Vercel](docs/VERCEL.md)).

## Known pitfalls

- This checkout's `dist/` and `skills/` are live for every agent session: the global skill links here, and consumer sessions run this `dist/`. Prove a test with `npm run mutate` in a worktree (`.claude/worktrees/<name>`, `node_modules` linked): it swaps a literal, rebuilds that worktree's `dist/` for a `src/` file, runs the test with a timeout, counts failures and cancellations, and restores the file byte for byte; in this checkout it refuses `src/` and `skills/` files. Without a worktree, mutate a copy, never `dist/` or the skill in place: copy `dist/` and `package.json` into a scratch folder, link `node_modules`, `sample-media`, and `examples` beside them, copy the test file to the same relative path, mutate the copy, and run the test there.
- The working tree is live too, so skill text that waits for a deploy never sits in it. Commit that text to its branch through a temporary index (`GIT_INDEX_FILE=<file> git read-tree main`, `git update-index --cacheinfo`, `git commit-tree`, `git update-ref`) instead of switching this checkout to the branch.
- The tutorial host's setup draws frames out of order (anchors, cues, and captions are measured at arbitrary times), so a frame must depend on its time alone. Whatever `#layout` reads back from the DOM, such as a field's rect to place a popup, has to be written earlier in the same `#layout`, never left over from the frame before. Test it by drawing frame 0 and then the frame in question: a test that renders in time order passes either way.
- Hosted jobs run the renderer snapshot's Chromium 139, not this machine's Chrome, and they differ: a font swap test passed on Chrome 154 and passed on Chromium 139 without its swap ever aborting a request, and `stylesheet-readiness.test.mjs` already fails on 139. Check a change to the frame runtime or the capture on 139 with `verify-hosted --integration` ([docs/VERCEL.md](docs/VERCEL.md)), and make a timing test assert that its scenario happened. That command uploads this checkout's `dist/`, so a mutation run through it mutates the live `dist/` in place: back the files up first, restore them as soon as the run ends, and say so.
- Running a web test file directly with `node --import tsx --test` also runs its `[browser]` tests, which open Chrome outside the render slot; pass `--test-skip-pattern='^\[browser\] '`, as the `web` suite does.
- On the Hobby plan, Vercel suspends the Blob store once a monthly usage quota is exceeded (store size stays tiny: operations are what run out), and every project route then fails. The API answers 503 naming the suspended store; `vercel blob list-stores` shows `Suspended`, and `vercel api /v1/storage/stores/<store id>` shows `"status": "limits-exceeded-suspended"`. Code cannot bring it back: the quota resets or the plan changes. Job polls (every 5 s from `studio-client.mjs run`, every 2.5 s from the editor) used to list the project's jobs (an advanced operation) and read every job record it ever had; they now call `GET /api/studio/projects/<id>/jobs/<jobId>`, which reads the project and that one record. The job list, the project view (`status`, the editor's load), and each artifact download still list and read every job, so never poll them.

## Guides

- [Install the bundled agent skill on another machine](skills/INSTALL.md)
- [Web API and snapshot schema](docs/API.md)
- [Vercel storage and Sandbox setup](docs/VERCEL.md)
- [Shared local CLI and packaging](docs/CLI.md)
- [Catalog configuration](docs/CONFIGURATION.md), [runtime](docs/RUNTIME.md), [media capture](docs/CAPTURE.md), and [tutorial videos](docs/TUTORIAL.md)
- [Agent and CI usage](docs/AGENT_USAGE.md)

The CLI guides describe trusted local configuration and its wider limits. Hosted JSON imports accept only the data schemas and stricter limits in the API reference.
