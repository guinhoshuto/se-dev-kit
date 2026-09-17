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

## Current hosted boundaries

- Complete JSON request/preview response: 4 MB.
- One active job per project, two globally; 50 jobs per UTC day.
- Video: up to 15 seconds, 30 fps, and 900 frames per job.
- A render recipe has at most 48 variants, or four when video is enabled.
- There is no account recovery, capability rotation, cancel endpoint, project listing, or delete endpoint.
- The hosted runtime blocks external network access while the widget runs. Dependencies must be captured during preparation.

These are application limits, not guaranteed provider quota. Do not provision paid capacity as an implicit retry.
