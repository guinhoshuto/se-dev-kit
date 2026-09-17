# Web API

This reference describes the routes implemented in this checkout. Use the application's own origin as the base URL, for example `http://127.0.0.1:3000` locally. The `/api/v1` routes cover project import/replacement and uploads; `/api/studio` routes also power the editor. They are not StreamElements API endpoints.

## Authorization and request rules

Project creation returns a random editing capability once. All subsequent project routes require `Authorization: Bearer <capability>`. There are no accounts, list-all-projects endpoint, recovery flow, capability rotation, or delete endpoint. Save the capability privately; the server retains its hash, not a recoverable copy.

Creation can optionally require `X-Studio-Key` when the operator configures `STUDIO_CREATE_KEY`. That workspace key grants creation only; it does not replace a project's editing capability. The web import screen accepts it in the **Workspace creation key** field without persisting it.

Send `Content-Type: application/json` for JSON requests. Bodies are capped at **4,000,000 bytes**, including base64 expansion. JSON responses use `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, and `X-Content-Type-Options: nosniff`.

Cross-origin browser API access is disabled. An `Origin` header, when present, must match the request's external origin; `Origin: null` is rejected. Server-side clients can omit `Origin`. Local mode accepts only loopback hosts. Do not work around these checks by proxying untrusted browser requests.

## Snapshot format

Submit a JSON object, not a ZIP, multipart upload, file paths, or executable configuration. The strict top-level shape is:

| Property | Contract |
| --- | --- |
| `schemaVersion` | Required; exactly `1`. |
| `name` | Required; trimmed, 1–100 characters. |
| `widget` | Required object with string `html`, `css`, `js` and JSON `fields`; optional `viewport` and `ready`. |
| `channel` | JSON object; defaults to `{"username":"streamer"}`. Synthetic data only. |
| `themes`, `fixtures`, `scenes`, `scenarios`, `recipes` | Arrays of versioned catalog objects; each defaults to `[]`, at most 48 entries each. |
| `assets` | Asset objects described below; defaults to `[]`. |

`widget.viewport` defaults to `{"width":430,"height":640}`. Its dimensions are integers from 1 to 4096; optional `deviceScaleFactor` is 0.25–2. Each raster dimension after device scaling must remain at most 4096. `widget.ready` accepts optional `selector` and `timeoutMs` (100–30,000); runtime timeout defaults to 10,000 ms.

`widget.fields` accepts object-form FIELDS, an array whose entries have `id` or `name`, or an object with a `fields` property. Object-form dropdown options map stored values to labels: `{"compact":"Compact"}`. Unsupported field types remain available as raw data.

All catalog entries require `schemaVersion: 1`, `id`, and `name`, and accept optional `description`. Catalog IDs are unique within each catalog and match `[a-zA-Z0-9_-]{1,100}`. Unknown keys in the versioned configuration objects are rejected; JSON field/event data remains open-ended.

| Catalog | Additional properties |
| --- | --- |
| Theme | Required `fieldData` JSON object. |
| Fixture | Optional JSON objects `channel`, `recents`, `fieldData`; `events` defaults to `[]`. Each event is `{atMs, listener, event}`, with a nonnegative integer timestamp and JSON payload. |
| Scene | Optional `theme`, `fixture`, `fieldData`, `background`, `viewport`, `output`, `camera`, `crop`, `captureAtMs`. Theme/fixture IDs must exist. |
| Scenario | Required `steps`; optional `theme`, `fixture`, `scene`. Supported actions are listed below. |
| Recipe | Required nonempty `scenes` array; optional `matrix`, `outputs`, `marketplacePreset`, `limit`. Use explicit existing theme IDs in `matrix.themes`; the local CLI's `"*"` theme shorthand is not accepted here. |

Scene and recipe presentation objects use these keys:

- `background`: required `id`; optional `label`, `color`, `image`, `checkerboard`. Images must be captured project resources or supported image data URLs.
- `viewport`: `width`, `height`, optional `deviceScaleFactor`. Recipe matrix viewports also require `id`, with optional `label`.
- `output`: `width`, `height`, optional `format` (`png` or `jpeg`) and `quality` (1–100).
- `camera`: required `id`, `scale` (0.05–20), `x`, `y`; optional `label` and `origin`.
- `crop`: nonnegative integer `x`, `y`, positive integer `width`, `height`.
- `matrix`: optional arrays `themes`, `backgrounds`, `viewports`, `cameras`.
- `outputs`: optional `screenshots`, `thumbnails`, `contactSheet`, `video`. Thumbnails require `width`, `height`, with optional `fit` (`contain` or `cover`) and `format` (`png` or `jpeg`). Video requires `enabled`, `durationMs`, `fps`; optional `format` (`mp4` or `webm`), `codec` (`h264` or `vp9`), `pixelFormat` (`yuv420p` or `yuva420p`), and `audio` (only `none`). MP4 requires H.264; WebM requires VP9; alpha requires VP9 WebM. Thumbnails/contact sheets cannot be combined with `screenshots: false`.

Scenario steps are strict objects:

```json
[
  {"action":"dispatch","listener":"message","event":{"data":{"displayName":"Preview viewer","text":"Synthetic message"}}},
  {"action":"updateFields","fieldData":{"title":"Preview"}},
  {"action":"wait","ms":100},
  {"action":"assert","selector":"#widget","exists":true,"visible":true,"count":1,"text":"Preview","attribute":{"name":"data-state","value":"ready"}}
]
```

For an `assert` step, only `action` and `selector` are required; include the checks you intend. The attribute check requires `name`, with optional `value`.

See [catalog examples](CONFIGURATION.md), [shared schemas](../src/config/schemas.ts), and [web-specific validation](../lib/schema.ts). Local CLI configuration supports additional trusted-code features and wider limits; it is not a hosted snapshot schema.

### Minimal working snapshot

```json
{
  "schemaVersion": 1,
  "name": "Synthetic title widget",
  "widget": {
    "html": "<main id=\"widget\"></main>",
    "css": "body{margin:0;color:#ffffff;background:#242032;font:32px Arial,sans-serif}main{padding:32px}",
    "js": "const apply=({detail})=>document.querySelector('#widget').textContent=detail.fieldData.title;window.addEventListener('onWidgetLoad',apply);window.addEventListener('onWidgetUpdate',apply);",
    "fields": {"title":{"type":"text","label":"Title","value":"Synthetic preview"}},
    "viewport": {"width":430,"height":640},
    "ready": {"selector":"#widget","timeoutMs":10000}
  },
  "scenes": [{"schemaVersion":1,"id":"portrait","name":"Portrait","captureAtMs":100}],
  "scenarios": [{"schemaVersion":1,"id":"title-smoke","name":"Title smoke","scene":"portrait","steps":[{"action":"assert","selector":"#widget","text":"Synthetic preview"}]}],
  "recipes": [{"schemaVersion":1,"id":"portrait-image","name":"Portrait image","scenes":["portrait"],"outputs":{"screenshots":true}}]
}
```

### Import unchanged production files from Node.js

Run this example from the Studio checkout after the local server is running. Set `WIDGET_ROOT` to an approved widget directory; set `STUDIO_URL` for a deployed origin. It only reads widget files. It writes the returned secret access bundle to a new, mode-0600 file under the ignored `.studio-data` directory; do not attach or publish that file.

```sh
WIDGET_ROOT=/absolute/path/to/widget node --input-type=module <<'NODE'
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

if (!process.env.WIDGET_ROOT) throw new Error('Set WIDGET_ROOT.');
const root = resolve(process.env.WIDGET_ROOT);
const base = new URL(process.env.STUDIO_URL ?? 'http://127.0.0.1:3000');
const read = name => readFile(resolve(root, name), 'utf8');
// For the alternative layout, select index.html, style.css, script.js, fields.json.
const [html, css, js, fields] = await Promise.all(
  ['widget.html', 'widget.css', 'widget.js', 'widget.json'].map(read)
);
const snapshot = {
  schemaVersion: 1, name: 'My widget',
  widget: {html, css, js, fields: JSON.parse(fields)}
};
const headers = {'Content-Type': 'application/json'};
if (process.env.STUDIO_CREATE_KEY) headers['X-Studio-Key'] = process.env.STUDIO_CREATE_KEY;
const response = await fetch(new URL('/api/v1/projects', base), {
  method: 'POST', headers, body: JSON.stringify(snapshot)
});
const created = await response.json();
if (!response.ok) throw new Error(`Create failed (${response.status}): ${created.error}`);
await mkdir('.studio-data', {recursive: true});
const accessFile = resolve('.studio-data', `access-${created.projectId}.json`);
await writeFile(accessFile, JSON.stringify({...created, origin: base.origin}), {flag: 'wx', mode: 0o600});
console.log({projectId: created.projectId, status: created.status, accessFile});
NODE
```

This file-only example does not discover a widget's themes or assets. Include those catalogs and dependencies in the snapshot when required. Missing assets produce a blocked revision; they do not modify the consumer directory. Open the saved `editorUrl` relative to `origin` in a trusted browser; do not send its fragment to a server or log it.

## Projects and immutable revisions

### Create

`POST /api/v1/projects` accepts the full snapshot and returns HTTP `201`:

```text
{ projectId, revisionId, status, editorUrl, token, etag }
```

`editorUrl` is a relative `/p/<projectId>#key=<capability>` link. `token` is the same capability and appears only in this creation response. Dependency preparation runs during creation. `status` can be `ready` or `blocked`; inspect the authorized project read for `diagnostics`. A blocked revision is retained for editing, but cannot run a job.

### Read

`GET /api/v1/projects/:id` returns HTTP `200`:

```text
{
  project: { id, name, revisionId, createdAt, updatedAt },
  revision: { id, projectId, createdAt, snapshot, status, diagnostics, prepared? },
  etag,
  revisions: [{ id, createdAt, status }],
  jobs: [...]
}
```

`snapshot` is the submitted, normalized source data. `prepared` is a derived offline-ready snapshot plus captured-asset metadata and warnings. Use `revision.snapshot`, not `prepared.snapshot`, as the starting point for a source edit. Treat `etag` as an opaque value from the **JSON body**; these routes do not expose an HTTP `ETag` response header.

`GET /api/studio/projects/:id/revisions/:revisionId` returns an authorized historical `Revision`.

### Full replacement

`PUT /api/v1/projects/:id` accepts a complete snapshot and requires `If-Match` containing the most recent JSON `etag` exactly as returned. Success returns a new `ProjectView` and new `etag`. The previous revision remains immutable.

This is replacement, not merge or PATCH: omitted catalogs/assets become empty arrays and other omitted optional properties take schema defaults. Preserve the full source snapshot when changing one field. Missing `If-Match` returns `428`; a stale value returns `409`. On conflict, fetch the latest snapshot, reconcile deliberately, and retry with its `etag`; never silently overwrite with a stale draft.

### Restore

`POST /api/studio/projects/:id/restore` requires the same authorization and `If-Match`, with body `{"revisionId":"<historical revision ID>"}`. It creates a new revision from the historical source and its already-prepared dependencies, then returns a `ProjectView`. It does not mutate history or refetch those dependencies.

## Assets and direct uploads

An asset is `{path, contentType?, ...source}`. Choose exactly one source:

- `content`: a string; optional `encoding` is `utf8` (default) or `base64`.
- `url`: a public HTTPS resource URL without credentials or custom ports. Preparation captures the resource and supported static dependencies; runtime networking remains disabled.
- `uploadId`: a completed upload belonging to this project.

Paths must be relative and normalized, without traversal, backslashes, query strings, fragments, percent escapes, control characters, or spaces. Paths starting with `.` and the reserved files `widget.html`, `widget.css`, `widget.js`, and `fields.json` are rejected. Submit HTML as widget source, not an HTML asset.

For files that do not fit comfortably in the JSON request:

1. Create the project first; if it references missing assets, it may initially be blocked.
2. `POST /api/v1/projects/:id/uploads` with `{"bytes":1234,"contentType":"image/png"}` and the project capability. The exact positive byte count is required.
3. A `201` reservation returns `{uploadId, url, method, headers, requiresAuthorization, expiresAt?}`. Send the raw file bytes using that method and **all returned headers**. This is not a multipart request.
4. If `requiresAuthorization` is `true`, resolve the relative URL against the Studio origin and include the project bearer header. If `false`, the absolute URL is a short-lived private Blob PUT capability: **do not forward your project Authorization header to Blob**.
5. Replace the project using its latest `etag`, including `{"path":"assets/preview.png","uploadId":"<reservation ID>"}` in `assets` and the corresponding source reference.

Local reservations point to `PUT /api/v1/projects/:id/uploads/:uploadId`; Blob reservations expire after five minutes. Uploads cannot overwrite existing binaries. Preparation checks project ownership, completion, and exact byte count. Reservations consume upload budget even if abandoned. An upload ID from another project cannot be used when creating a new project.

The JSON schema accepts up to 256 asset declarations, but preparation enforces at most **128 captured files**, including discovered dependencies. Dynamic URLs created inside JavaScript and ES module imports are not captured. Inline HTML event handlers, embedded frames/objects, import maps, and `srcset` are unsupported; keep widget behavior in classic JavaScript.

## Interactive preview

`POST /api/studio/projects/:id/preview` takes an object with optional `snapshot` (a complete unsaved draft), `sceneId`, `themeId`, and `fieldData`. `{}` previews the saved revision. Success returns `{html, state, backgroundImage?, sessionId, nonce}`; the response contains no project capability.

Draft preparation stays in request memory and does not create a revision. New external resources in field overrides must be included in a prepared snapshot. The effective fields merge shallowly as `FIELDS defaults → theme → fixture → scene → explicit fieldData`.

Prefer the supplied editor for interactive manipulation. A custom client must load `html` into `srcdoc` on an iframe with exactly the restricted `sandbox="allow-scripts"` policy, preserve its CSP, and implement the existing bridge's source/origin/session/nonce validation. Never inject preview HTML into the editor DOM or add `allow-same-origin`. See [the preview component](../components/widget-preview.tsx) and [runtime message handling](../src/runtime/frame.ts).

## Jobs and artifact download

`POST /api/studio/projects/:id/jobs` accepts:

```json
{"kind":"render","selection":"portrait-image"}
```

`kind` is `render` or `test`. For render, select a configured recipe ID, `scene:<sceneId>`, or `video:<sceneId>`. For tests, select a scenario ID or `all`; browser smoke checks also run. A job pins the project's current immutable revision when created. A later save does not change an existing job.

HTTP `202` means accepted, not complete. The response is a `Job` with `id`, `projectId`, `revisionId`, `kind`, `selection`, `status`, timestamps, `progress`, `artifacts`, and optional `error`/execution metadata. Poll `GET /api/studio/projects/:id/jobs` and find that ID. Statuses are `queued`, `running`, `completed`, `failed`, or `cancelled`; there is currently no cancel endpoint. Stop polling on a terminal state and report `error` for failures. Use a bounded polling deadline and avoid aggressive polling; jobs have a ten-minute execution budget measured from creation.

An accepted selection can still fail during execution. If the runner cannot start, POST returns HTTP `422` with the failed **Job object**, not the usual `{error}` wrapper. A failed media job can retain useful manifests/images. Final web video requires successful encoding and probing; without FFmpeg/ffprobe, use the [local CLI's explicit PNG-sequence intermediate](CAPTURE.md) instead. Web jobs do not retain temporary frame sequences.

Artifact entries have `{id, name, key, contentType, bytes, sha256}`. Use `GET /api/studio/projects/:id/artifacts/:artifactId` with the project capability, not the internal storage `key`:

- Local storage returns the bytes with attachment, content type, and no-store headers.
- Blob storage returns `307` to a private signed download URL valid for one minute. Follow it **without forwarding the Studio bearer capability**; never use a client's option that forwards credentials across redirect hosts. The signed URL is itself a temporary secret.

Check downloaded length and SHA-256 against artifact metadata. Write to a new, explicitly chosen output file, or ask for overwrite authorization; artifact names are not permission to write arbitrary paths. There is no API that overwrites a consumer's output directory.

## Application limits

These are application guardrails in the current source, not Vercel plan quotas or a promise of free capacity. Provider limits can be stricter. Daily counters are shared by this workspace, not per project or caller, and use UTC dates.

| Resource | Current application limit |
| --- | --- |
| JSON request / complete preview response | 4,000,000 bytes |
| Projects | 10 creations per UTC day; 100 total per store |
| Jobs | 50 per UTC day; 2 active globally; 1 active per project |
| Job execution | 10 minutes; active reservations expire after 11 minutes |
| Upload reservations | 100 MiB per UTC day; at most 10 MiB per file on Blob, 4,000,000 bytes locally |
| Prepared assets | 10 MiB per file; 100 MiB and 128 captured files per revision |
| Preview captured assets / background | 3 MiB for embedded assets; background also capped at 3 MiB |
| Ready timeout / scene capture time | 30 seconds / 15 seconds |
| Scenario | 100 steps; sum of explicit waits at most 30 seconds |
| Render recipe | At most 48 variants; at most 4 variants when video is enabled |
| Video | At most 15 seconds, 30 fps, and 900 total frames per job |
| Raster dimensions | At most 4096 per dimension for submitted widget/scene/crop/thumbnail dimensions after applicable scaling |
| Published job artifacts | 256 files; 100 MiB per file; 250 MiB total |

## Errors and safe automation

Most failures return `{"error":"English diagnostic"}`. Inspect HTTP status, and also inspect revision/job status on successful requests.

| HTTP status | Typical meaning |
| --- | --- |
| `400` | Invalid JSON, identifier, storage path, or local-upload route used in Blob mode. |
| `403` | Missing/invalid capability, creation key, host, or origin. |
| `404` | Missing project, revision, upload reservation, or artifact. |
| `409` | Stale save/restore, immutable object collision, or active job for this project. |
| `413` | Request/preview size or local upload size exceeds the limit. |
| `415` | JSON request missing `application/json` content type. |
| `422` | Invalid snapshot/options, blocked revision, bad upload size, or failed job startup. |
| `428` | Missing `If-Match` for replacement or restore. |
| `429` | Personal budget or global concurrency limit reached. |
| `503` | Storage configuration missing, local storage forbidden on Vercel, or storage contention. |
| `500` | Unexpected server operation failure; inspect protected server diagnostics. |

For humans, agents, and CI:

1. Read only explicitly scoped consumer files; never execute submitted `.mjs` configuration on the hosted server.
2. Submit synthetic, public-safe data. Reject live credentials, viewer information, and private URLs before upload.
3. Store access bundles outside version control with restricted permissions. Never print full creation responses, bearer headers, signed URLs, iframe payloads containing sensitive data, or editing-link fragments.
4. Check preparation status and diagnostics before running jobs. Preserve the complete source snapshot and use `If-Match`; do not retry conflicts blindly.
5. Poll within an explicit deadline, stop on terminal status, verify downloaded hashes, and report exact artifact paths and validation boundaries.
6. Do not provision paid capacity or download browser/media tools as an implicit retry. Follow the [operator deployment procedure](VERCEL.md).
