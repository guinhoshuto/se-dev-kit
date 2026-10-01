# Hosted workflow

The helper uses only Node.js built-ins and the Studio HTTP API; `--config` also uses the engine of the Studio checkout the skill runs from. In the examples, `SKILL_DIR` means the directory containing this skill. Do not create a shell variable named `HOME` or expose access-file contents.

## Import a production widget

The helper autodetects either `widget.html + widget.css + widget.js + widget.json` or `index.html + style.css + script.js + fields.json`. It reads the production files without modifying them. With no `--access-out`, the private bundle is stored under the user's `~/.se-widget-studio` directory.

```sh
node "$SKILL_DIR/scripts/studio-client.mjs" import \
  --widget-root /absolute/path/to/widget \
  --name "Widget name"
```

Use `--catalog /absolute/path/to/catalog.json` when the widget needs Studio metadata. The catalog may contain top-level `channel`, `themes`, `fixtures`, `scenes`, `scenarios`, `recipes`, and `assets`; `widget` may contain only `viewport`, `ready`, and `fieldUpdate` (see [catalog-authoring.md](catalog-authoring.md#field-changes)). Real production source always wins and cannot be overridden by the catalog. `--origin` selects another explicit deployment.

Local assets are opt-in; the helper never scans or uploads the rest of the widget directory. Declare each required file with a safe destination and a path relative to the widget root:

```json
{
  "assets": [
    {"path": "assets/logo.png", "file": "assets/logo.png", "contentType": "image/png"},
    {"path": "fonts/widget.woff2", "file": "fonts/widget.woff2", "contentType": "font/woff2"}
  ]
}
```

These skill-only `file` entries are uploaded through private reservations after project creation and become ordinary immutable `uploadId` assets in the final revision. Files are contained under the widget root, limited to 10 MiB each and 100 MiB total. Public `url` and inline `content` asset sources use the hosted API schema directly.

Creation is an external mutation. Confirm the intended widget root and target origin before running it. The command prints only safe identifiers and the access-file path. If the response is uncertain, do not import again; inspect the access file or service state first.

If `import` prints `"status": "blocked"`, the project already exists and the output lists its `diagnostics` (`status` shows them again). Fix the catalog, then `pull` and `push` on that same project; do not import again.

When the catalog uses `sws-sample:` references, `import` and `push` first check them, before any change: offline against `sample-media/manifest.json` of the Studio repository (`$SKILL_DIR/../../sample-media/manifest.json`, present when the skill runs from a checkout or a linked skill directory), then against `GET /api/v1/sample-media` on the selected origin. If the deployment answers that it does not support them or does not serve a reference, nothing is created or pushed: stop and tell the user that the deployment must be updated first. Do not upload, draw, or generate images as a workaround.

### Widgets with a local Studio config

Import a widget that has a `se-widget-studio.config.mjs` with `--config` in place of `--widget-root` and `--catalog`. The helper reads the config with the engine of the Studio checkout the skill runs from, exactly as the local CLI does, and nothing in the widget directory changes:

```sh
node "$SKILL_DIR/scripts/studio-client.mjs" import \
  --config /absolute/path/to/widget/se-widget-studio.config.mjs \
  --recipes gallery-stills,hero-video
```

- Each catalog glob becomes an array; a plain field-data file, such as a production theme preset, gets the ID local mode derives from its file name. `widget.viewport`, `widget.ready`, and `widget.fieldUpdate` are kept; `widget.root`, `widget.files`, `widget.assets`, and `output` are not sent.
- Every file the local Studio serves besides the production sources (the `widget.assets` matches and the files the widget source references) becomes a private upload under its path relative to the widget root, except an image that copies a built-in sample (see the last item). A field value such as `studio/media/gallery/01.jpg`, alone or in an array, names that file in the local CLI, the hosted preview, and hosted jobs alike. `/__sws/widget/<path>` values become `<path>`, a recipe matrix `"*"` becomes every theme ID, and `outputs.video.keepFrames` is dropped because hosted jobs ignore it.
- `--recipes` keeps only those recipes and the scenes, themes, and fixtures they use, and leaves scenarios out. Without it, a config that exceeds a per-revision limit is refused with the counts; group recipes as in "Plan a large batch".
- The helper refuses production files outside the two layouts above, `widget.adapter`, and `widget.assets` that match an HTML file. It warns on stderr when the checkout's engine build is dirty or older than its source: run `npm run build:engine` in the checkout, then import. A copied skill has no checkout, so `--config` fails there; build the catalog by hand following these rules and pass `--catalog`.
- `catalog --config <file> [--recipes <ids>] --out <new-json>` writes the same catalog without contacting any Studio. Use it to inspect what an import would send, to take the arrays of the next recipe group when you `pull` and `push` (keep the draft's `assets`), or to edit before `import --widget-root <root> --catalog <json>`.
- Test media are the Studio's sample images, never uploads: uploads count against the upload quota, cannot be deleted, and share the editor preview's 3 MiB budget, so a widget whose uploads exceed it imports and renders but does not preview. `import --config` and `catalog --config` replace every image that copies a sample, byte for byte or as the generated original the sample was recompressed from (the se-windows `studio/media/` test images), with its `sws-sample:` reference in every value that names it, leave the file out of the uploads, and print a `Sample copy:` line for it on stderr. A copy that the widget's own HTML, CSS, JavaScript, or FIELDS load stays an upload. Renders from a recompressed sample are not byte-identical to renders from the original. Before the first import of a widget with test media, run `catalog` and read its `assets`: replace any other test image listed there with a sample from [the sample table](catalog-authoring.md#sample-media) in the JSON that `catalog` writes, never in the widget directory, adding the backdrop's paired `color` to a background that has none and dropping the image's `assets` entry; then import that JSON with `--catalog`. Upload a test image only when the user asks for those exact pixels. Where a widget has no test media at all, use samples rather than creating images.

## Open and manipulate

Open the fragment-based private editor without putting its capability in the shell command:

```sh
node "$SKILL_DIR/scripts/studio-client.mjs" open-editor --access /absolute/private/access.json
```

For code-driven manipulation, pull a complete capability-free draft into the writable workspace:

```sh
node "$SKILL_DIR/scripts/studio-client.mjs" pull \
  --access /absolute/private/access.json \
  --draft-out /absolute/workspace/.studio-data/widget-draft.json
```

Edit only `snapshot` in that JSON. Preserve `origin`, `projectId`, `revisionId`, and `etag`. Push the full replacement:

```sh
node "$SKILL_DIR/scripts/studio-client.mjs" push \
  --access /absolute/private/access.json \
  --draft /absolute/workspace/.studio-data/widget-draft.json
```

`push` uses the draft's original `etag`. HTTP 409 means another revision won; pull a fresh draft, compare, and reconcile deliberately. Previous revisions remain immutable.

Use `status --access ...` for a safe summary of the current revision, diagnostics, and jobs. It never prints source or capabilities.

## Test and render

Use a scenario ID or `all` for tests. Use a recipe ID, `scene:<scene-id>`, or `video:<scene-id>` for rendering.

```sh
node "$SKILL_DIR/scripts/studio-client.mjs" run \
  --access /absolute/private/access.json \
  --kind test \
  --selection all \
  --output-dir /absolute/new/test-output

node "$SKILL_DIR/scripts/studio-client.mjs" run \
  --access /absolute/private/access.json \
  --kind render \
  --selection listing-video \
  --output-dir /absolute/new/render-output
```

The output directory must not exist. The command never cleans or overwrites it. It stops on a terminal job status, verifies every download against server metadata, and writes a capability-free `job.json` report beside the artifacts. When the render manifest or the test report lists Google Fonts issues, it prints them on one stderr line and adds them as `fontIssues` to its JSON and to `job.json`; read them before using the media. A job has a ten-minute execution budget. Do not submit a replacement job merely because polling was interrupted; use `status` to find the accepted job first. `run` polls every 5 s and reads only that job's record; never watch a job by calling `status` in a loop, because each `status` reads the project's whole revision and job history from storage, and that storage has a monthly operation quota.

## Plan a large batch

Hosted mode is the default even for marketing batches. Plan them inside the boundaries below instead of switching to local mode:

- Keep every video job within 900 frames in total: variants × round(durationMs × fps / 1000). At 30 fps that is two 15-second variants, three 10-second variants, or four 7.5-second variants. The hosted client has no dry run and the worker rejects an oversized recipe only after the job is accepted, so the failed job still counts against the daily limit. Compute the total before submitting and move further variants into further recipes.
- Keep the largest variant's frames within the Sandbox's disk. The worker estimates the peak disk use of a render as the final media plus the frames of its largest variant, at 1.2 bytes per output pixel per frame (0.3 in tutorial mode), and refuses it when that exceeds 70% of the Sandbox's free space. A 15-second, 30 fps full-HD variant estimates about 1.1 GiB and needs about 1.6 GiB free. The failure arrives after the job is accepted, as `OUTPUT_DISK_LOW: Recipe … needs an estimated peak of … which has … free`, and counts against the daily limit. Resolve it by shortening the variant or lowering the output resolution; there is no hosted override.
- Submit the first video job with a single variant to measure its runtime against the ten-minute budget.
- When the catalog exceeds a per-revision limit, group recipes so that each group's scenes, themes, and assets fit one revision. Import once; for each later group, `pull`, replace the catalog arrays in `snapshot`, `push`, and run that group's jobs. Each job stays pinned to the revision it was submitted against. Prefer this to one project per group, because projects cannot be listed or deleted.
- Count every planned job, tests included, against the 50-jobs-per-UTC-day limit before starting, and submit one job at a time per project.
- `scene:<id>` renders one still of a catalog scene, and `video:<id>` always records a 5-second, 30 fps H.264 MP4 without alpha. Use a recipe for any other duration, a WebM, a transparent video, or a matrix.
- Give every job its own new output directory.

## Current hosted boundaries

- Complete JSON request/preview response: 4 MB.
- A revision holds at most 48 themes, fixtures, scenes, scenarios, and recipes each, and at most 128 asset files and 100 MB of assets, 10 MB per file.
- Interactive editor preview: captured assets and the `sws-sample:` images the previewed scene uses share one 3 MiB budget. The preview response carries them as base64 together with the stage background image and must stay under 4,000,000 bytes, so plan for well under 3 MB of raw media in total, background included; an image the widget HTML or CSS references directly is embedded more than once. When a revision is too large to preview, preview a smaller revision; render jobs keep the 100 MB revision budget. Sample media never count toward the 128-file or 100 MB revision budget or the upload quota.
- `sws-sample:` references need a deployment that ships sample media, announced by `GET /api/v1/sample-media`. An older deployment blocks such a revision with an unrelated path error (`Asset paths must be relative…`) or passes gallery arrays to the widget unresolved; the client check above prevents both.
- A saved revision pins each sample it uses to its SHA-256. If a deployment ever served different bytes for that reference, preview and jobs fail with `Sample media changed since this revision was saved` instead of rendering other pixels.
- One active job per project, two globally; 50 jobs per UTC day.
- Video: up to 15 seconds and 30 fps per variant, and 900 frames per job. A render is also refused when its estimated peak disk use exceeds 70% of the Sandbox's free space (see "Plan a large batch").
- Video input: jobs run HeadlessChrome 139, a Chromium build without H.264 (checked on 2026-09-28: `canPlayType` answers `""` for `avc1` and `"probably"` for `vp9`). An MP4, M4V, or MOV that the widget plays, whether a `video-input` value, an asset, or a `src` in the HTML, fails to load, and the whole job fails with `Video failed to load: …`. Use WebM (VP9) test media in hosted catalogs. The editor preview runs in your own browser and may still play the MP4. Video output is not affected: FFmpeg encodes the MP4 of recipes and `video:<id>`.
- A render recipe has at most 48 variants, or four when video is enabled.
- Job artifacts: at most 100 MB per file and 250 MB per job.
- There is no account recovery, capability rotation, cancel endpoint, project listing, or delete endpoint.
- Google Fonts (`fonts.googleapis.com` `/css` and `/css2`, `fonts.gstatic.com` `/s/`) are served from the Studio cache and fetched on demand, with no preparation. `/icon` and `text=` URLs are outside that list (see "Fonts"). All other runtime network access stays blocked and must be captured during preparation.

These are application limits, not guaranteed provider quota. Do not provision paid capacity as an implicit retry.

## Known gaps

- Revision preparation captures stylesheets, scripts, images, and `url()`/`@import` references written in the widget's HTML and CSS. Apart from Google Fonts (see "Fonts"), nothing the JavaScript requests at runtime is captured: a script injected from a CDN (for example three.js) does not load, so whatever depends on it breaks. When this would change requested marketing media, stop before submitting render jobs, name the affected themes, and ask the user how to proceed; the local CLI blocks runtime network requests as well. Do not edit the widget.

## Fonts

- Google Fonts work as in StreamElements, in the editor preview and in jobs: a stylesheet written in HTML or CSS, or one a script assigns at runtime (a `setFont()` driven by a `googleFont` field). Themes and scenes may change `googleFont` freely. Never ask to vendor a font or edit the widget because of it.
- A widget may point its font link at another family before the first one has loaded (a default font at startup, then the theme's in `onWidgetLoad`): Chrome aborts the first request, and the job serves the new font. Jobs before 2026-09-29 failed on this with `FONT_UNAVAILABLE … net::ERR_ABORTED`; run them again.
- Material Icons (`/icon`) and `text=` stylesheets written in the widget's HTML or CSS are copied into the revision at import, like any public HTTPS dependency, and render from that copy as in StreamElements; the copy does not change after import. The same URLs built at runtime, by a script or through a `{{field}}` placeholder, are not captured: jobs fail with `FONT_UNSUPPORTED`, and the editor preview cannot load them either.
- StreamElements `{{field}}` placeholders are substituted with the effective `fieldData` in HTML, CSS and JS, in preview and in jobs.
- Saving a revision prewarms the font cache, and prewarm warnings appear in the revision diagnostics. A job may show `Fetching Google Fonts (pass n/4)`; a later render of the same revision does not contact Google.
- Results are in the job's `manifest.json` → `fonts` (`served` with URL and SHA-256; `issues`) and in the test report → `fonts`; `run` repeats the issues as `fontIssues`.
- Codes: `FONT_UNAVAILABLE` (Google or the cache could not serve the font; retry later), `FONT_DISCOVERY_LIMIT`, `FONT_SETTLE_TIMEOUT` and `FONT_UNSUPPORTED` (an `/icon` or `text=` URL built at runtime). The `upstream-4xx` warning means Google refused the family and the text uses the fallback, as StreamElements would.
- The `fonts-ready-forced` and `fonts-ready-stalled` warnings mean `document.fonts.ready` did not resolve by itself in the widget frame although no font was loading, as in a frame the browser was not rendering: the capture forced a layout, or went on without it. Look at the media before using it. A `FONT_SETTLE_TIMEOUT` names the stylesheets still waited for, the Google Fonts requests without a response, the faces by status, and, in a video, where it happened.
- Production was verified on 2026-09-27 with the verification fixture only. Canvas text (`fillText`) and reassigning the same stylesheet `href` are not yet proven there: look at the hosted render before relying on them for marketing media.
- The asset example `fonts/widget.woff2` above is for a widget's own font files, not for Google Fonts.
