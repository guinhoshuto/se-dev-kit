# Hosted workflow

The helper uses only Node.js built-ins and the Studio HTTP API. In the examples, `SKILL_DIR` means the directory containing this skill. Do not create a shell variable named `HOME` or expose access-file contents.

## Import a production widget

The helper autodetects either `widget.html + widget.css + widget.js + widget.json` or `index.html + style.css + script.js + fields.json`. It reads the production files without modifying them. With no `--access-out`, the private bundle is stored under the user's `~/.se-widget-studio` directory.

```sh
node "$SKILL_DIR/scripts/studio-client.mjs" import \
  --widget-root /absolute/path/to/widget \
  --name "Widget name"
```

Use `--catalog /absolute/path/to/catalog.json` when the widget needs Studio metadata. The catalog may contain top-level `channel`, `themes`, `fixtures`, `scenes`, `scenarios`, `recipes`, and `assets`; `widget` may contain only `viewport` and `ready`. Real production source always wins and cannot be overridden by the catalog. `--origin` selects another explicit deployment.

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

A `se-widget-studio.config.mjs` cannot be passed as `--catalog`. Build a JSON catalog from it and keep that file with the widget's other Studio-only files, never among its production files:

- Copy only `widget.viewport` and `widget.ready`. Drop `widget.root`, `widget.files`, `widget.assets`, and the top-level `output`; the helper or the strict hosted schema rejects them.
- Expand each `{glob}` into an array of the matching JSON objects. Wrap a plain field-data file, such as a production theme preset, as `{"schemaVersion": 1, "id": "<file name without .json>", "name": "<name>", "fieldData": <file contents>}`, because local mode derives that ID from the file name and scenes refer to it.
- Replace asset globs with one `{path, file, contentType}` entry per file, keeping `path` equal to the file's path relative to the widget root.
- Convert copies of the Studio's sample media first (next item), then rewrite the remaining local-only media values in `fieldData` from `/__sws/widget/<path>` to `<path>`; hosted import rejects absolute local paths. Hosted import rewrites only string media values, so check array-valued media fields (an `image-input` with `multiple: true`) that hold widget asset paths in a test job before rendering. Arrays of `sws-sample:` references need no check: import validates them and every mode resolves them.
- Test images that are copies of the Studio's sample media become `sws-sample:` references instead of uploads. For the images an agent generated for se-windows, a gallery value `/__sws/widget/studio/media/gallery/NN-<name>.jpg` (or `studio/media/gallery/NN-<name>.jpg`, if the previous rewrite already ran) becomes `sws-sample:gallery/<name>.jpg`, dropping the `NN-` prefix; a `background.image` `studio/media/backdrops/bd-<name>.jpg` becomes `sws-sample:backdrops/<name>.jpg`, dropping `bd-`. Add the backdrop's paired `color` from [the sample table](catalog-authoring.md#sample-media) when the background has none, and drop the matching `assets` entries. The sample files were recompressed, so renders are not byte-identical to renders made from the generated originals. Do this only in the JSON catalog you build, never in the widget directory. Where a widget has no test media at all, use samples from [catalog-authoring.md](catalog-authoring.md#sample-media) rather than creating images.
- Drop `outputs.video.keepFrames` from recipes: hosted jobs ignore it, and a deployment older than that key rejects it.
- Check the result against the per-revision limits below before importing; split it as described in "Plan a large batch" when it does not fit.

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

The output directory must not exist. The command never cleans or overwrites it. It stops on a terminal job status, verifies every download against server metadata, and writes a capability-free `job.json` report beside the artifacts. A job has a ten-minute execution budget. Do not submit a replacement job merely because polling was interrupted; use `status` to find the accepted job first.

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
- A render recipe has at most 48 variants, or four when video is enabled.
- Job artifacts: at most 100 MB per file and 250 MB per job.
- There is no account recovery, capability rotation, cancel endpoint, project listing, or delete endpoint.
- The hosted runtime blocks external network access while the widget runs. Dependencies must be captured during preparation.

These are application limits, not guaranteed provider quota. Do not provision paid capacity as an implicit retry.

## Known gaps

- Revision preparation captures stylesheets, scripts, images, and `url()`/`@import` references written in the widget's HTML and CSS, including a Google Fonts stylesheet written there with a literal family. Nothing the JavaScript requests at runtime is captured, and hosted previews and jobs have no network:
  - A Google Fonts stylesheet assigned by JavaScript (for example a `setFont()` driven by a `googleFont` field) does not load, and the text falls back to another font. If the script rewrites the same `<link>` that carried the captured font, that font is lost too.
  - A script injected from a CDN does not load, so whatever depends on it breaks.
  
  Treat every theme as affected until a hosted render shows the intended typeface. When this would change requested marketing media, stop before submitting render jobs, name the affected themes, and ask the user how to proceed; the local CLI blocks runtime network requests as well. Do not edit the widget or vendor fonts.
- StreamElements `{{field}}` placeholders are not substituted; preparation treats them as literal text:
  - In a resource reference (an HTML `src`, `poster`, `<script src>`, or `<link rel="stylesheet" href>`, or a CSS `url()`, quoted or not), a placeholder is resolved as a local asset and blocks the revision with `Missing asset`.
  - Inside an external `https://` URL it is fetched literally, and the revision is blocked when the remote answers with an error (Google Fonts answers HTTP 400).
  - An unquoted placeholder in a CSS declaration (`color: {{color}}`), including `<style>` and `style=""`, fails to parse and blocks the revision. Inside a quoted CSS string or a custom property value it stays literal.
  - In HTML text, non-resource attributes, and JavaScript it stays literal; an unquoted placeholder in JavaScript (`const size = {{size}};`) is a syntax error when the widget script runs.
