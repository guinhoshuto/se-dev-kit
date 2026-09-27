# Google Fonts in SE Widget Studio: implementation plan

| | |
| --- | --- |
| Status | **In progress. Stage 1 done (2026-09-27): `src/runtime/google-fonts-url.ts`, `src/fonts/css.ts` and their unit tests; the frame server route waits for the stage that makes `frame.ts` import the module.** |
| Decision | 2026-09-26, by the repository owner |
| Written | 2026-09-27, against `main` at `ae5fd9a`. Every `file:line` below was rechecked against that commit. Uncommitted parallel work (sample media) was changing `lib/importer.ts`, `lib/jobs.ts`, `lib/model.ts`, `lib/preview.ts`, `src/capture/renderer.ts`, `src/runtime/frame.ts`, `src/scenarios/runner.ts`, `src/server/server.ts`, `src/tutorial/timeline.ts`, `components/widget-preview.tsx` and `scripts/job-worker.mjs` at the time, so recheck line numbers in those files before implementing. |
| Gate | The `AGENTS.md` amendment in [section 6](#6-proposed-agentsmd-amendment-pending-user-approval) is **PENDING USER APPROVAL**. Stage 1 has no network code and can start now. Stage 2 and everything after it wait for the approval. |
| Estimate | About 16 working days in 8 stages. Each stage ships on its own. The fixes from the adversarial review are folded into the stages and were not re-estimated. |

## 1. Context

Widgets that use Google Fonts either fall back to another typeface or block outright. Behaviour on `ae5fd9a`:

- **Placeholder in a stylesheet URL.** `<link href="https://fonts.googleapis.com/css?family={{fontName}}:400,700">` (`se-custom-chat/index.html:1`) is fetched literally (`lib/importer.ts:155`). Google answers 400, `fetchPublicAsset` throws (`lib/importer.ts:61`) and `makeRevision` marks the revision `blocked` (`lib/projects.ts:59`).
- **Placeholder in a media reference.** `<source src="{{powerOnSound}}">` (`se-lava-lamp/index.html:3`) is resolved as a local path and fails with `Missing asset` (`lib/importer.ts:202`, then `:167`).
- **Unquoted placeholder in CSS.** `gap: {{msgSpacing}}px;` (`se-8bit/chat/widget.css:22`) makes `postcss.parse` in `rewriteCss` throw (`lib/importer.ts:99`), and the revision is blocked. Reproduced in memory: `Unknown word msgSpacing` (se-8bit) and `Unknown word alignment` (`se-custom-chat/style.css:16`).
- **No substitution anywhere.** The frame document is built from the raw HTML (`src/server/html.ts:53-108`), and the preview serializes without substituting (`lib/preview.ts:69-89`).
- **Fonts requested at runtime are blocked.** A `setFont()` driven by a `googleFont` field cannot load: the hosted Sandbox is `deny-all` (`lib/jobs.ts:149`), the capture context aborts every origin it does not allow (`src/capture/browser.ts:99-106`), and the preview CSP allows only `font-src data:` (`lib/preview.ts:84`).
- **The fallback is hidden.** The editor says `Ready · isolated runtime` (`components/widget-preview.tsx:65`) while the text is in fallback. `waitForLoadedAssets` rejects only faces whose status is `error` (`src/runtime/frame.ts:176`), so a face that never loads passes silently. The local CLI reports a generic `requestfailed … ERR_BLOCKED_BY_CLIENT` (`src/capture/browser.ts:128-131`).
- **The skill documents these as known gaps** (`skills/se-widget-studio/references/hosted-workflow.md:111`, `:115-126`).

Affected widgets: four of the six products marked done depend on placeholders (se-8bit, se-custom-chat, se-dreamychat, se-lava-lamp). se-windows (six themes, runtime `setFont()`), the glossy widgets, se-text-widgets, se-wheel, se-curve-text, se-imessage-chat, se-cloud-chat and se-shaped-marquee depend on runtime Google Fonts.

An earlier local patch (`--allow-google-fonts`, live fetch through Playwright) was never committed. It does not come back. [Section 8](#8-what-to-salvage-from-the-lost-patch) lists what is worth salvaging from it.

## 2. Decision (2026-09-26)

- Aim for full fidelity with StreamElements through a **server-side Google Fonts proxy with a content-addressed cache**.
- The production render Sandbox **stays `deny-all`**. Fonts reach it as job files. There is no ticket and no egress allowlist.
- **Nothing requires changing a widget.** No vendored fonts and no source edits (`AGENTS.md:8`).
- The allowlist is exactly `fonts.googleapis.com` `/css` and `/css2`, plus `fonts.gstatic.com` `/s/*`. `/icon` and `text=` return `FONT_UNSUPPORTED`.
- The local CLI keeps blocking Google Fonts, now with a clear `FONT_UNAVAILABLE` error and a hint to use the hosted Studio. No CLI flag is part of this plan.

Rejected alternatives:

- **Live fetch from the browser** (`route.continue` or `route.fetch`, the lost patch). It is not reproducible, and `route.fetch` would always fail in a `deny-all` Sandbox.
- **An egress allowlist to the Studio host, authenticated by a job ticket.**
  - A domain allowlist applies to the whole VM (`@vercel/sandbox` `network-policy.d.ts`), and Chromium runs with Playwright's default `--no-sandbox` (`src/capture/browser.ts:75-78`).
  - A ticket regenerated on each workflow retry breaks idempotency (`lib/jobs.ts:21-25`).
  - The origin would come from the request's `Host` header (`lib/http.ts:5-14`).
- **Vendoring fonts into widgets.** This contradicts the decision.

## 3. How it works for the user

1. **Upload.** You upload the widget as it is, through the skill or the editor. The revision is no longer blocked by `{{field}}`. On save, the Studio prewarms the cache with the Google URLs it can already know: static `<link>` and `@import`, and URLs with placeholders filled from the defaults and from each theme and scene. A prewarm failure is only a warning in `diagnostics`, and the revision stays `ready`.
2. **Preview.** The editor preview opens with the right font.
   - Static Google `<link>` and `@import` are turned into `data:` CSS on the server.
   - A runtime `setFont()` is intercepted by a shim in the iframe. The shim asks the editor bridge, which calls the API with its Bearer token. The token never enters the iframe.
   - Font files come from `/api/fonts/v1/f/<sha256>.<mac>.<ext>`. This route only reads the cache, returns immutable responses, and is served by the CDN.
   - The iframe CSP keeps `connect-src 'none'` and `frame-src 'none'`. Only `font-src` gains that path.
3. **Honest status.** The status bar reads either `Ready` or, for example, `Ready · Archivo 700 in fallback (reason)`. A family that Google refuses appears as a warning, and the text stays in fallback, as it would in StreamElements.
4. **googleFont control.** You type the family and commit it with Enter or by leaving the field. The preview remounts with the new font. The Studio never fetches prefixes such as `R` or `Ro` while you type.
5. **Revisions.** Saving creates an immutable revision, as today. Every font URL the revision has used, in preview or in jobs, is recorded in a per-revision lock (URL to status and SHA-256) that points into the global content-addressed cache. Upstream 4xx answers are recorded too.
6. **Jobs.** Both Generate assets and Run tests keep the Sandbox `deny-all` (`lib/jobs.ts:149`).
   - The job package carries the fonts that are already known: the revision lock, the static URLs, and cached entries from the previous revision's lock.
   - The trusted worker answers Chromium's requests to `fonts.googleapis.com` and `fonts.gstatic.com` with `route.fulfill` from those files. The page never reaches the network.
7. **Discovery passes.** If the widget asks for a URL that is not in the package, that pass becomes a discovery pass.
   - It keeps running every timeline without screenshots or encoding, and returns the full list of missing URLs.
   - The workflow fetches them through the proxy in a Function, writes them to the cache and the lock, uploads them to the same Sandbox, and runs again. The limit is four passes.
   - Progress shows `Fetching Google Fonts (pass 2/4)`.
8. **Output.** You get the PNG or MP4 with the real font. `manifest.json` gains a `fonts` section with `epoch`, `userAgent`, `servedDigest`, `served` (URL, status, SHA-256, bytes) and `issues`. The test report carries the same account.
9. **Re-renders.** A later render of the same revision serves everything from the lock, without contacting Google, and receives the same bytes.
10. **Failures.**
    - Google is down and the font is not cached: the job fails with `FONT_UNAVAILABLE`, naming the family, the URL and the reason, so you can retry.
    - A family that does not exist (Google answers 400): the job completes with a warning. StreamElements would show the fallback too.
11. **Placeholders.** Widgets with `{{field}}` (se-8bit, se-custom-chat, dreamy chat, se-lava-lamp) work. The Studio substitutes placeholders in HTML, CSS and JS with the effective `fieldData`, in both preview and render.
12. **Unchanged.** All other runtime network access stays blocked: emotes from `static-cdn.jtvnw.net`, three.js injected at runtime, and the jelly-ui module script. The local CLI still blocks Google Fonts, but now reports `FONT_UNAVAILABLE` with a hint instead of `requestfailed`.

## 4. Architecture at a glance

### Components

| Component | Runs in | Role |
| --- | --- | --- |
| `src/runtime/google-fonts-url.ts` | Browser and Node | Canonicalizes URLs, applies the allowlist, and parses families and axes. Shipped with the frame runtime. |
| `src/fonts/css.ts` | Node | Validates Google CSS with postcss, extracts the file list, and sniffs font bytes. |
| `lib/fonts.ts` | Vercel Functions, local web | `resolveGoogleFont()`: bounded fetch, append-only cache, negative cache, budget, and per-revision lock. Also `cssForPreview()`. |
| `src/fonts/resolver.ts` | Job worker (engine) | `FontResolver` replays a local lock and records what it served and what was missing. It never uses the network. |
| `serveFontRequest` in `createIsolatedContext` | Job worker | Answers Google requests with `route.fulfill` from the resolver. It never calls `route.continue` or `route.fetch`. |
| `settle()` in `src/runtime/frame.ts` | Widget frame | Waits for stylesheets, layout, `document.fonts.ready`, and `fonts.load` for each family in use, then reports per family. |
| Preview broker (shim in `frame.ts` plus `widget-preview.tsx`) | Editor | Holds a Google `href` in the iframe back, resolves it through the authenticated API, and loads the resulting `data:` CSS. |
| `app/api/fonts/v1/f/[file]` | Vercel | Public, cache-only font bytes. |
| `app/api/studio/projects/[id]/fonts` | Vercel | Authenticated resolve for the preview broker. |

### Storage layout (Blob)

| Key | Contents | Mutability |
| --- | --- | --- |
| `fonts/v1/objects/<sha256>` | CSS or font bytes | Write-once, never deleted |
| `fonts/v1/index/<sha256(epoch\|UA\|canonical URL)>.json` | URL → object, plus a `partial` flag | Write-once (`put` without overwrite; on conflict, re-read and serve the winner) |
| `fonts/v1/negative/<key>.json` | Upstream 4xx | Overwritable, 1 h TTL, outside the index. 429 and 5xx are never cached. |
| `projects/<id>/fontlocks/<revisionId>/<sha256(url)>.json` | `{url, status, sha256?, bytes?, contentType?}` | Write-once, one object per URL, capped per revision |
| `usage/fonts-<date>.json` | Separate `render` and `preview` budget buckets | CAS updates, reserved per batch |

### Codes

| Code | Raised by | Meaning | Outcome |
| --- | --- | --- | --- |
| `FONT_UNAVAILABLE` | Capture, job, local CLI | A font is needed, is not cached, and cannot be fetched (upstream down, budget exhausted, or local CLI) | Fails the capture or job |
| `FONT_SETTLE_TIMEOUT` | Capture | `settle()` exceeded its real-time deadline | Fails |
| `FONT_UNSUPPORTED` | Canonicalizer | `/icon`, `text=`, or a URL outside the allowlist | Reported with a clear message. Stage 4 decides whether it fails the capture. |
| `FONTS_MISSING` | Worker to workflow (internal) | A discovery pass found URLs outside the package | Triggers a refill. Never shown to the user. |
| `FONT_DISCOVERY_LIMIT` | Workflow | More than four passes, or not enough job time left | Fails |
| `upstream-4xx` (warning) | Everywhere | Google refused the family | Completes. Text stays in fallback, as in StreamElements. |

## 5. Stages

| # | Stage | Visible after it ships | Effort |
| --- | --- | --- | --- |
| 1 | Google Fonts core in the engine | Nothing | 1 d |
| 2 | Amendment, bounded transport, content-addressed cache | Nothing. The cache and transport exist. | 2 d |
| 3 | `{{field}}` placeholders, non-blocking import, prewarm on save | Placeholder widgets import as `ready` and are simulated in preview and capture | 2 d |
| 4 | Font readiness and reporting in the runtime | Honest preview status. Captures fail with `FONT_UNAVAILABLE` naming the family. | 2.5 d |
| 5 | Hosted render and test from the cache, with discovery passes | Hosted jobs render real Google Fonts | 3 d |
| 6 | Hosted preview: server CSS, editor broker, public cache route | Editor preview shows real Google Fonts. The importer stops capturing into `_import/`. | 2.5 d |
| 7 | Field updates as in StreamElements, googleFont control, tutorial | Videos change fonts as in StreamElements. The typing control no longer floods the proxy. | 1.5 d |
| 8 | Docs, skill, production acceptance | Documented and accepted | 1 d |

Only stage 6 turns off capture into `_import/`, so no stage regresses what already works. Items marked **(review fix)** come from the adversarial review. [Section 12](#12-review-findings-index) maps each finding to its fix.

### Stage 1: Google Fonts core in the engine (pure, no network). 1 day

**Status: done (2026-09-27).** `frame.ts` does not import the module yet, so `src/server/server.ts` was left unchanged; its fixed runtime list and the frame-server integration check move to the stage that adds the import (stage 4). The hosted preview already ships it, because `dist/runtime/` is copied whole.

**Files**

- `src/runtime/google-fonts-url.ts` (new; runs in the browser and in Node) **(review fix)**
- `src/server/server.ts:201-206` (add the compiled module to the frame server's fixed runtime list)
- `src/fonts/css.ts` (new, Node only)
- `tests/unit/google-fonts-url.test.mjs`, `tests/unit/google-fonts-css.test.mjs` (new)
- `tests/fixtures/google-fonts/*.css` (real Google CSS recorded once by hand; tests never use the network)

**Changes**

- **Where the URL module lives (review fix).** `frame.ts` imports this module, so it must sit in `src/runtime/`.
  - The preview ships only `public/engine/runtime/*` and `public/engine/version.js` (`scripts/copy-assets.mjs:18-20`), and the local frame server serves only `frame-bootstrap.js`, `frame.js` and `version.js` (`src/server/server.ts:201-211`). Anywhere else, the import returns 404 on both sides and the frame runtime never boots.
  - `dist/runtime/` is copied whole, so the preview needs no change. The frame server adds the file to its fixed list and still does not serve whole directories.
  - The module's only runtime import may be `../version.js`.
- **`canonicalGoogleFontsUrl()`.**
  - Scheme: HTTPS only. `http:` and protocol-relative `//` URLs are promoted to HTTPS. StreamElements pages are HTTPS, while in the loopback frame `//` resolves to `http:` because the frame runs on `http://127.0.0.1` (`src/server/server.ts:233`). Port 443 only, and credentials are rejected.
  - `fonts.googleapis.com`: only `/css` and `/css2`. It keeps `family` (repeatable, in order), `display` and `subset`, and drops and notes every other parameter.
  - `fonts.gstatic.com`: only `/s/<family>/v<N>/<file>.(woff2|woff|ttf|otf)`, with no query.
  - A `{{` in `family` becomes a local 400 without calling upstream.
  - Limits: URLs up to 2 KB and up to 20 families.
  - `/icon` and `text=` (gstatic `/l/` with a query) return `FONT_UNSUPPORTED` with a clear message. Supporting them would widen the decided allowlist.
- **`familiesFromUrl()`.** It understands v1 syntax (`|` or `%7C` separators, comma-separated weights) and css2 syntax (repeated `family=`, the axes `wght`, `ital,wght` and `opsz,wght`, and `a..b` ranges). The frame uses it to preload fonts.
- **Constants.**
  - `GOOGLE_FONTS_UA`: the current stable Chrome on Windows, as in the OBS browser source.
  - `FONT_CACHE_EPOCH = 'v1'`.
  - Maximum sizes: 1 MB of CSS and 4 MB per font file. The 4 MB limit respects the Function response limit that the code already acknowledges (`app/api/studio/projects/[id]/artifacts/[artifactId]/route.ts:9`). The design's 10 MB would not fit.
- **`validateGoogleCss()`** parses with postcss, which is already a dependency (`lib/importer.ts:7`).
  - It accepts `@font-face` rules whose `src` `url()` points only to gstatic `/s/`, with `format()` and `unicode-range`.
  - It accepts class rules without `url()` whose declarations are limited to `font-*`, `line-height`, `letter-spacing`, `text-transform`, `display`, `white-space`, `word-wrap`, `direction`, `font-feature-settings` and `-webkit-`/`-moz-` smoothing. Material Symbols served through css2 includes such rules.
  - It rejects `@import`, other at-rules, `data:`, `javascript:` and any other `url()`.
  - It returns the file list with `unicode-range` and descriptors.
- **`sniffFont()`** checks the magic bytes `wOF2`, `wOFF`, `OTTO`, `0x00010000`, `true` and `ttcf`.
- Origin rules use a generic `{host, pathPattern, validate}` interface, so emote or script CDNs can be added later without a second mechanism.

**Tests**

- URL canonicalization:
  - v1 with `|`, `%7C`, `+`, `%20` and raw spaces.
  - css2 with several `family=` in order, `ital,wght@0,400;1,700` and `opsz,wght@12..96,400..800`.
  - `display` kept, unknown parameters dropped, and `//` and `http:` promoted.
- Rejected URLs:
  - Host tricks: `fonts.googleapis.com.example.com` and `example.com/fonts.googleapis.com`.
  - Port 8443 and URLs with credentials.
  - `/icon`, and gstatic paths outside `/s/` or with a query.
  - URLs longer than 2 KB.
- `{{fontName}}` gives a local 400 without an upstream call.
- CSS validation:
  - It accepts `@font-face` with `unicode-range` and the Material Symbols class rules.
  - It rejects `@import`, non-gstatic `url()`, `data:`, `javascript:` and class rules with `url()`.
  - It extracts the file list.
- `sniffFont` accepts all six signatures and rejects HTML and JSON.
- The module loads from `dist/runtime/` through the frame server (one integration check).
- Tests run on Node 22 or 24, the `engines` range in `package.json` (`>=22.20 <23 || >=24 <25`).

### Stage 2: AGENTS.md amendment, bounded transport, content-addressed cache. 2 days

**Gate:** the amendment in section 6 must be approved first. It lands in this PR, before any code that fetches.

**Files**

- `AGENTS.md:10-11`
- `lib/importer.ts:41-74` (`fetchPublicAsset`)
- `lib/fonts.ts` (new)
- `lib/model.ts:16-18` (the `offline-ready` comment and `PreparedSnapshot.googleFonts?`)
- `lib/storage.ts:66-87` (immutable reads with an in-memory LRU)
- `lib/projects.ts:78-85` (`restoreProject` copies font locks) **(review fix)**
- `tests/web/fonts.test.ts` (new), `tests/web/import.test.ts`

**Changes**

- **`fetchPublicAsset(input, opts)`** gains `{maxRedirects, deadline, headers, maxBytes, allowedHosts}`. The current call sites (`lib/importer.ts:138`, `:155`) keep their behaviour. For fonts:
  - `maxRedirects: 0`: every 3xx is an error. Today it follows redirects up to the limit at `:42` (`:55-58`).
  - Fixed headers, using the User-Agent from stage 1.
  - `allowedHosts` limited to the two Google hosts.
  - It tries every validated public address in turn, prefers IPv4, and records which one it used. Today it pins `answers[0]` (`:50`); on the render path, one bad address would fail the job.
  - It checks the body length against `Content-Length`.
  - Timing: the 15 s at `:70` is a socket inactivity timeout. The overall limit is the deadline: 20 s by default (`:41`) and 45 s during preparation (`:118`).
- **`resolveGoogleFont(url, {store, epoch, userAgent, bucket, sampleText})`** in `lib/fonts.ts` returns `ok`, `upstream-4xx` or `unavailable`.
  - Keys follow the table in section 4. The index is written with `put` without overwrite. On `ConflictError` (detected from the message at `lib/storage.ts:79`), it re-reads and serves the winner.
  - Every read checks SHA-256, as `lib/materialize.ts:43-46` and `lib/preview.ts:59` already do.
  - Single-flight per instance, plus an in-memory LRU, because `BlobStore.get` always reads with `useCache: false` (`lib/storage.ts:69`).
  - Eager files: when a CSS response enters the cache, it downloads every file the CSS lists, up to 64 files and 8 MB. Above that, it downloads only the files covering the sample text plus Basic Latin, and marks the index entry `partial` with the full list, so later requests can fetch individual files. This keeps a new subset from depending on Google later for most families.
- **Budget.**
  - It lives in `usage/fonts-<date>.json`, separate from `dailyBudget`. With a new key, `dailyBudget` (`lib/projects.ts:33-39`) would compute `undefined + n = NaN` and the check would pass. A missing key starts at 0.
  - It is reserved per batch (one CSS with its files, or one refill pass), not per file. This avoids a storm of CAS retries in `mutateJson`, which allows 8 attempts (`lib/storage.ts:105-111`).
  - The `render` and `preview` buckets have separate limits.
- **Per-revision lock.** Entries are `{url, status, sha256?, bytes?, contentType?}` **(review fix: status)**. A 4xx is recorded in the revision's lock and stays immutable for that revision, independent of the 1 h negative-cache TTL. Writes are idempotent and uncontended (one object per URL). The lock also provides `lockForRevision()`, `servedDigest(entries)` and a cap on entries per revision.
- **`restoreProject` (review fix).** It clones `prepared` under a new revision id (`lib/projects.ts:81-83`) but does not copy `fontlocks/<revisionId>`. It now copies the lock entries too. This is cheap, because objects are content-addressed.
- **`lib/model.ts`.** `PreparedSnapshot` gains `googleFonts?: {epoch, userAgent, static: string[]}`. The epoch and User-Agent are pinned per revision, so bumping the global epoch never changes old revisions. The comment at `:17` changes to say that Google Fonts come from the cache and are pinned by the lock.

**Tests** (`tests/web/fonts.test.ts`, with an injected upstream and no network)

- Cache hits:
  - The first resolve writes the object and the index, and the second resolve never calls upstream.
  - Two concurrent resolves with different bytes both serve the winner.
- Upstream errors:
  - A negative 4xx expires after 1 h. 429 and 5xx are never cached.
  - A 3xx is refused, and the fixed User-Agent is sent.
  - A body truncated relative to `Content-Length` is refused.
- Budget and limits:
  - A missing budget key does not become `NaN`.
  - The 64-file limit marks the entry `partial`.
- Locks:
  - Writes are idempotent. A SHA-256 mismatch on read gives `unavailable`.
  - A 4xx entry with `status` is written and read back.
  - `restoreProject` copies the lock.
- `tests/web/import.test.ts`: `fetchPublicAsset` with `maxRedirects: 0` refuses a 3xx, and tries the second address when the first fails (injectable lookup). The current cases at `:16-25` keep passing.
- `npm run typecheck && npm test`.

### Stage 3: `{{field}}` placeholders as in StreamElements, non-blocking import, prewarm on save. 2 days

**Files**

- `src/config/placeholders.ts` (new)
- `lib/importer.ts:98-114` (`rewriteCss`), `:145-171` (`resolveReference`), `:177`, `:195-209`
- `lib/projects.ts:54-61` (`makeRevision`)
- `lib/preview.ts:28-38`, `:41-91`
- `app/api/studio/projects/[id]/preview/route.ts:35`
- `src/server/html.ts:53-108`
- `src/server/server.ts:24-31`, `:179-230`
- `src/studio-ui/bridge.ts:73-82`
- `src/studio-ui/capture-host.ts:3-16`, `:44-82`
- `src/scenarios/runner.ts:155-197`
- `tests/unit/placeholders.test.mjs` (new), `tests/web/import.test.ts`, `tests/integration/capture.test.mjs`

**Changes**

- **`substitutePlaceholders(text, fieldData)`.**
  - It replaces `{{name}}` (inner spaces optional) with the raw value from the effective `fieldData`: defaults, then theme, fixture, scene and override, in the same order as `lib/preview.ts:37`.
  - An unknown placeholder stays intact and produces a warning. There is no recursion.
  - It applies to HTML, CSS and JS, following the StreamElements documentation as read on 2026-09-26. Escaping still has to be confirmed on real StreamElements (section 9).
- **Sentinels in `rewriteCss` (review fix, was blocking).**
  - Before `postcss.parse` (`lib/importer.ts:99`), every `{{\s*[\w.-]+\s*}}` is replaced by a sentinel that is a valid CSS identifier, such as `__sws_tok_<n>__` (check that the prefix does not already occur in the source). The tokens are restored after `toString()`.
  - This covers all four call sites: widget CSS (`:209`), `style` attributes (`:205`), `<style>` (`:206`) and CSS assets (`:177`).
  - Tokens are restored before a reference reaches the resolver, so `resolveReference` sees `{{…}}`.
  - Checked in memory: the CSS of `se-8bit/chat/widget.css` and `se-custom-chat/style.css` parses and round-trips byte for byte.
- **`resolveReference`** (`:145-171`) returns every reference containing `{{` untouched. It neither downloads it nor treats it as a local path. Media field values are already captured by `rewriteFieldData` (`:210-219`), so a substituted `{{powerOnSound}}` becomes a captured path.
- **Static Google capture** into `_import/` continues as today (`:195-201`). It is switched off only in stage 6.
- **Preview.**
  - The route computes `previewState` before the HTML. Today `previewHtml` runs first (`route.ts:35`).
  - `previewHtml` substitutes HTML, CSS and JS with `state.fieldData` before parsing and inlining (`lib/preview.ts:69-77`).
  - **(review fix)** If a substituted value breaks CSS parsing, that CSS passes through unchanged with a warning, not a 422. A StreamElements browser would drop only the invalid declaration.
  - **(review fix)** After substitution, the importer's HTML refusals run again (`lib/importer.ts:182-183`: `base`, `iframe`, `object`, `embed`, `meta http-equiv`, `on*` handlers), because substituted values bypass the checks done at import.
  - **(review fix)** Until stage 6, `inline()` passes Google Fonts URLs through untouched instead of treating them as local paths. Today they would throw `Preview resource is missing` (`lib/preview.ts:52-57`) once a placeholder has turned into a real Google URL. The CSP blocks them, and the page reports a fallback warning.
- **Capture.**
  - `StudioServer` (`src/server/server.ts:24-31`) gains `registerFrameDocument(fieldData)`, which returns a `docKey`.
  - `openScene` registers `resolved.runtimeState.fieldData` before `captureHostLoadWithClock` (`src/scenarios/runner.ts:181`) and passes the key in the payload. `capture-host` forwards it, and `bridge.start` adds `doc=<key>` to the frame URL (`src/studio-ui/bridge.ts:74-76`).
  - The frame server builds the substituted HTML and serves the substituted CSS and JS at their existing paths, `/__sws/widget/<css path>?doc=<key>` and `/__sws/widget/<js path>?doc=<key>` (`src/server/html.ts:60-61`, `:77`). **(review fix)** A new `/__sws/doc/<key>/` prefix would break relative `url()` in the CSS, because `<base>` (`html.ts:76`) applies only to the HTML. `url(assets/x.png)` would return 404, and `waitForLoadedAssets` would throw `CSS background image failed to load` (`src/runtime/frame.ts:170-175`).
  - Without `doc` (the local dev UI), it substitutes with `project.fieldDefaults`.
  - **(review fix)** While building the document, the frame server drops external links that are not stylesheets, such as `<link rel="preconnect" href="https://fonts.gstatic.com">` (`se-custom-chat/index.html:2`). A preconnect opens a socket outside `context.route`. Hosted import already drops these links (`lib/importer.ts:197`).
- **Prewarm.**
  - It runs only in `makeRevision` (`lib/projects.ts:54-61`), never for the draft preview's `DraftStore` (`route.ts:16-22`, `:31-33`).
  - It collects Google URLs from static `<link>` and `@import` after substitution, for the defaults and for each theme and scene, and stores them in `prepared.googleFonts.static`.
  - It calls `lib/fonts` with at most 8 URLs and a deadline of min(10 s, time left until 55 s), because `maxDuration` is 60 (`app/api/v1/projects/route.ts:6`).
  - Failures become warnings in `diagnostics`.

**Tests**

- Unit tests for `substitutePlaceholders`: spaces, a missing field (stays intact and warns), numbers and booleans, repeated occurrences, and no recursion.
- Import of each placeholder pattern gives a `ready` revision:
  - Unquoted placeholders in declarations, inside `calc()`, and as a keyword (`align-items: {{alignment}}`).
  - `@import` with `{{fontFamily}}`.
  - `<link>` with `{{fontName}}`.
  - `<source src="{{powerOnSound}}">` with a `sound-input`.
  - Fixtures reproduce these patterns synthetically. Consumer widget files are not copied (`AGENTS.md:8`).
- Preview:
  - `previewHtml` substitutes and embeds the audio as `data:`.
  - A value that breaks CSS parsing gives a warning, not a 422.
  - A value that injects `<meta http-equiv>` or an `on*` handler is rejected.
  - A widget with a placeholder in its Google link previews without throwing.
- Prewarm runs only in `makeRevision`, and an injected upstream failure becomes a warning.
- Integration (capture):
  - A widget with `{{title}}` in HTML, in CSS `content` and in JS shows the theme value.
  - CSS that combines a placeholder and a relative `url()` loads the image.
- In production: importing se-custom-chat and se-lava-lamp gives `ready`.

### Stage 4: Font readiness and reporting in the runtime, with real-time deadlines in Node. 2.5 days

**Files**

- `src/runtime/frame.ts:14-23`, `:136-178`, `:271-276`, `:278-286`, `:290-332`, `:352-360`
- `src/studio-ui/bridge.ts:109-134`
- `src/studio-ui/capture-host.ts:84-92`
- `src/scenarios/runner.ts:54-119`, `:181-190`, `:272-289`
- `src/capture/renderer.ts:432-472`, `:619-633`, `:728-753`
- `src/capture/browser.ts:121-133`
- `components/widget-preview.tsx:56-72`
- `tests/integration/stylesheet-readiness.test.mjs` (reapplied from the lost patch)
- `tests/integration/font-readiness.test.mjs` (new)
- `tests/fixtures/fonts/<OFL family>.woff2` and `OFL.txt`
- `docs/CAPTURE.md:15`, `docs/RUNTIME.md:23`, `:74`

**Changes**

- **Stylesheet tracking**, reapplied from the lost patch (final version at transcript L1395): `stylesheetLoads`, `isStylesheetLink`, `trackStylesheet` (guards against the same `href` and against late loads), `watchStylesheets` (MutationObserver) and `waitForStylesheets`.
  - `watchStylesheets` starts right after `waitForDocument` (`frame.ts:306`).
  - Adjustment: `href` and `sheet.href` are read through the native getter, saved before any shim, and the tracked promise accepts external resolution. This prepares stage 6.
- **Synthetic load.** Plain Chrome fires `load` when the same `href` is reassigned, but not under `context.route` (transcript L1105 against L1370). When the sheet is already loaded, the runtime dispatches a synthetic `load` through `MessageChannel`, and a capture listener on `document` drops a duplicate native `load`. Widgets then see the same event in render as in StreamElements.
- **`settle()`** loops until quiet: `waitForStylesheets`, forced layout, `document.fonts.ready`, and `fonts.load` for each family actually used. Families come from three places:
  1. Text nodes, `content` of `::before` and `::after`, `value` of `input` and `textarea`, and open shadow roots, up to 2000 nodes, with computed weight and style.
  2. `(ctx.font, text)` pairs recorded by a wrapper around `fillText`, `strokeText` and `measureText` on `CanvasRenderingContext2D` and `OffscreenCanvasRenderingContext2D`.
  3. Families and weights from tracked Google URLs (`familiesFromUrl`), with sample text taken from the strings in `fieldData` and the DOM.
- **Why source 3 matters for canvas.** Some widgets call `fonts.load` before the stylesheet arrives (`se-text-widgets/magazine/script.js:176-181`, `se-curve-text/script.js:197-201`), and `replayUntil` advances with `fastForward` (`src/capture/renderer.ts:294`), which fires due timers at most once (`node_modules/playwright-core/types/types.d.ts:18660`). Without preloading, the only rAF would draw the fallback.
- **Clock.** `settle()` never yields through timers or rAF, because the clock is paused (`runner.ts:179`). It uses `MessageChannel`.
- **Report.** The report is per family, weight and style: `loaded`, or fallback with a reason (`stylesheet-blocked`, `upstream-4xx`, `not-in-cache`, `face-error`, `timeout` or `partial`). It adds `redrawNeeded` when a face loaded after the last canvas draw.
- **`waitForLoadedAssets`.**
  - `settle()` replaces the checks at `:138` and `:176`. The check at `:176` looked only at `error` and let never-loaded faces pass.
  - A failed Google stylesheet goes into the report. Other stylesheets still throw.
  - Listeners for `securitypolicyviolation` and `document.fonts` `loadingerror` are added. Today only script errors are observed (`:271-276`).
- **Commands.**
  - `host:update-fields` (`:352-360`) and `host:emit` (`:278-286`) run `settle()` before acknowledging, and send the report.
  - New command `host:settle`, also exposed as `__SE_WIDGET_STUDIO__.settle`, and a new event `frame:fonts`.
  - The bridge gains `settle()`. Its timeouts use the virtual `window.setTimeout` (`bridge.ts:112`), so the deadline must be real and kept in Node.
- **Runner.**
  - `captureHostSettle(page, realDeadline)` follows the style of `captureHostLoadWithClock` (`:54-98`), with `Date.now` and `setImmediate`, and fails with `FONT_SETTLE_TIMEOUT`.
  - `captureHostUpdateFields` and `captureHostDispatch` (`:100-119`) gain real deadlines.
  - `settle()` runs after `openScene`, after each `updateFields` or `dispatch` (`:272-281`), and before each `assert`.
- **Renderer.**
  - Stills: `settle()` runs between `replayUntil` (`:621`) and the screenshot (`:633`). If `redrawNeeded`, it runs `clock.runFor(16)` up to three times, with a `settle()` each time, and the manifest records `redrawMs`.
  - Video: `settle()` runs after each event (`:439-445`) and before the `fastForward` to the frame timestamp (`:449-452`), so that frame's rAF already draws with the font.
  - Before each frame, a light settle (stylesheets, layout, `fonts.ready`) also catches `href` swaps made by timers. It costs nearly nothing when nothing is pending.
  - Font errors are checked on the frame where they happen. Today they are checked only at the end (`:464-472`).
- **`observePage`** (`browser.ts:121-133`) classifies by URL (`request.url()` and `message.location().url`), because the text of `Failed to load resource … 400` omits the URL. Google URL failures go to the font report instead of `issues.errors`.
- **Preview.** `widget-preview.tsx` handles `frame:fonts`. The font wait in the preview has its own 6 s budget, below the 10 s `timeoutMs` (`lib/preview.ts:80`). When it expires, the family is reported as `fallback(timeout)` and the preview stays up.

**Visible in production after this stage:** the preview stops saying `Ready` over a hidden fallback, and captures fail with `FONT_UNAVAILABLE` naming the family instead of a generic `CAPTURE_RUNTIME_ERROR` (`renderer.ts:625-630`).

**Tests**

- `stylesheet-readiness`, reapplied (transcript L1146, L1358, L1379, L1409):
  - Stylesheets come from another origin.
  - Cases: slow swap, double swap, same `href` cached, round trip, `missing.css`.
  - New case: the same `href` gives exactly one `load`.
  - Mutating each guard must break the test (L1412).
- `font-readiness`, with a local Chromium and the OFL font served by a second loopback origin:
  - DOM text.
  - Canvas in the se-text-widgets pattern (`fonts.load` before the stylesheet, drawing in rAF), as still and video, with a hash equal to a reference drawn with the font from the start.
  - A family change through `updateFields` shows on the first frame after `atMs`.
  - A settle past its deadline ends in `FONT_SETTLE_TIMEOUT` without hanging.
  - A blocked Google URL gives `FONT_UNAVAILABLE` with the family name.
- **(review fix)** The second loopback origin goes through `route.continue` (`src/capture/browser.ts:101-103`), which is not the render path: that path uses `fulfill`, has no HTTP cache, and fires no `load` on a same-`href` reassignment (transcript L1370). Stage 4 counts as proven only after the canvas and same-`href` cases also pass through `FontResolver` and `route.fulfill` in stage 5.
- `npm test` on Node 22 or 24. The lost patch ran only on Node 26.9, outside `engines`.

### Stage 5: Hosted render and test served from the cache, Sandbox `deny-all`, discovery passes. 3 days

**Files**

- `src/fonts/resolver.ts` (new)
- `src/capture/browser.ts:82-114`
- `src/server/server.ts:128-141`
- `src/scenarios/runner.ts:148-170`, `:260-307`, `:309-360`
- `src/capture/renderer.ts:43-55`, `:384-475`, `:588-760`
- `scripts/job-worker.mjs`
- `lib/jobs.ts:16-29`, `:84-119`, `:137-212`
- `lib/model.ts:22-27`
- `lib/materialize.ts:37-50`, `:63`
- `workflows/render.ts:18-30`
- `tests/unit/font-route.test.mjs` (new), `tests/web/jobs.test.ts`, `tests/integration/google-fonts-render.test.mjs` (new)
- `scripts/verify-hosted.mjs:50-71`

**Changes**

- **`FontResolver`** (engine) replays a local lock (`lock-<n>.json` plus `objects/<sha>`) with a synchronous in-memory memo, because Playwright disables the HTTP cache when routes are active (`types.d.ts:3975`). It records what it served and what was missing, and never uses the network. It replays the recorded `status`, so a 4xx entry is answered with that 4xx **(review fix)**.
- **`createIsolatedContext({fonts})`.** `serveFontRequest` runs in the route handler (`:99-106`) before the abort. It accepts only GET requests to canonicalizable URLs.
  - Hit: `route.fulfill` with 200, the content type, `Access-Control-Allow-Origin: *` and `cache-control`. The CORS header is required, because `@font-face` loads in CORS mode from `http://127.0.0.1`.
  - Recorded 4xx: `fulfill` with the same status.
  - Miss: `abort('failed')`, and the miss is recorded.
  - It never calls `route.continue` or `route.fetch`.
- **Frame CSP** (`server.ts:128-141`). `style-src` and `font-src` also accept `http://fonts.googleapis.com` and `http://fonts.gstatic.com`. Without this, a `//fonts…` URL dies in the CSP before it reaches the route.
- **Plumbing.**
  - `OpenSceneOptions.fonts`: the fifth parameter of `openScene` is already `OpenSceneOptions` (`:148-161`), and the value is passed on at `:165-170`.
  - `runScenarios` and `runBrowserSmoke` accept `fonts`. Today they take only `browserPath` and `headed` (`:311`, `:342`).
  - `RenderOptions.fonts` (`:43-55`).
- **Discovery mode.**
  - On the first miss, the render stops taking screenshots and encoding, but keeps running every variant's timeline to collect all misses. Then it throws `FONTS_MISSING`.
  - The manifest gains `fonts: {mode: 'cache', epoch, userAgent, servedDigest, served, issues, redrawMs}` next to `runtime` (`:735`).
  - **(review fix)** The digest covers only what this render served, not the whole lock. The preview keeps adding lock entries, and two renders of the same revision must report the same digest. `servedDigest` complements `inputDigest` (`:740`), which does not cover fonts.
- **Test jobs discover too (review fix).** `runOneScenario` swallows every error into its results (`runner.ts:294-296`), so today `FONTS_MISSING` would become a scenario failure and never reach the workflow.
  - A typed `FONTS_MISSING` error is rethrown from `runOneScenario` and from the smoke run.
  - The worker's test branch (`scripts/job-worker.mjs:15-24`) merges the misses from the smoke run and the scenarios into `needsFonts`.
  - Tests use the same pass loop as renders.
- **`job-worker.mjs`.**
  - The fonts directory is derived from `dirname(inputPath)` (`:8`), which avoids touching `relocateProject` (`lib/materialize.ts:69-79`).
  - `argv` gains the pass number. `outputRoot` becomes `output/pass-<n>`, because the preflight without `--force` refuses existing targets (`renderer.ts:591`).
  - The worker writes `result-<n>.json`. `FONTS_MISSING` becomes `result.needsFonts` (at most 256 canonical URLs), with no artifacts.
  - The test report carries the font report.
- **Duplicate passes (review fix).** The worker takes `job/pass-<n>.lock` with the `wx` flag. A second worker for the same pass does not exit empty-handed, which would make `pollHostedJob` read a missing result after exit code 0 (`lib/jobs.ts:196`, `:200-201`) and fail the job. Instead, it waits, with a deadline, for the first worker's `result-<n>.json`. `pollHostedJob` also decides on whether `result-<n>.json` exists, not only on the exit code of the recorded command.
- **`launchHostedJob`.**
  - It builds the initial package: the revision lock, `prepared.googleFonts.static`, and entries from the previous revision's lock that are already cached (these without contacting Google).
  - Migration: in revisions with Google captured into `_import/`, `materializeSnapshot` rewrites those references back to their `sourceUrl`. Today `sourceUrl` is dropped (`lib/materialize.ts:37-50`, `:63`). This keeps a page from mixing the old TTF with the proxy's woff2.
  - It uploads the fonts with the rest of the job (`:164-171`) and runs pass 1.
- **`pollHostedJob`** returns `done`, `pending` or `refill`, and publishes from `output/pass-<n>/` (today from `output/`, `:204`).
- **`refillHostedJob`**, a new step in `workflows/render.ts`:
  1. Re-read the job. If `fontPass` has already advanced, exit.
  2. From pass 4 on, fail with `FONT_DISCOVERY_LIMIT`. Also respect `remainingJobTime` (`lib/jobs.ts:32-37`).
  3. **(review fix)** Canonicalize and cap `needsFonts` again: it comes from a Chromium that runs without a sandbox (`browser.ts:75-78`).
  4. Resolve the URLs through `lib/fonts` (`render` bucket), write them to the revision lock (including 4xx entries), and upload the new objects plus `lock-<n+1>.json`.
  5. Re-read the job before `runCommand`, run pass n+1, and `patchJob({fontPass, commandId, progress})`.
  6. If Google fails and nothing is cached, end with `FONT_UNAVAILABLE`, naming the family, the URL and the reason.
- **`patchJob`** (`:19-29`) keeps the first `commandId` today. It accepts a new `commandId` only when `patch.fontPass` is higher. `JobPatch` (`:16`) and `Job` (`lib/model.ts:22-27`) gain `fontPass`.
- **Local `runJob`** (`:84-119`) gets the same pass loop, for parity in the local web app and to test the loop without a Sandbox.
- **CLI.** It gets no flag. Without a resolver, it keeps blocking and reports `FONT_UNAVAILABLE` with a hint.

**Tests**

- Unit tests for `serveFontRequest` with a stub route, reusing the six cases from transcript L392/L669:
  - A hit is fulfilled with 200 and the CORS header.
  - A POST is aborted.
  - A recorded 4xx is fulfilled with that 4xx.
  - A miss is `abort('failed')`.
  - It never calls `continue` or `fetch`.
  - The memo avoids a second read.
- `jobs.test.ts`, with a mocked Sandbox:
  - The `networkPolicy` stays `deny-all`.
  - `needsFonts` leads to a refill that uploads the files and runs pass 2.
  - A refill retry does not run a duplicate command.
  - **(review fix)** A crash between `runCommand` and `patchJob` still ends `completed`.
  - The four-pass limit holds, and publishing reads from `output/pass-n`.
  - **(review fix)** A 400 family completes in two passes, and a second render of the same revision never calls upstream.
  - **(review fix)** A test job with a scenario whose `updateFields` switches `googleFont` discovers the font and passes.
  - The local `runJob` with a fake upstream completes in two passes.
- Integration (`google-fonts-render`, with a lock built from the fixture OFL woff2):
  - The se-windows pattern (static link, and `setFont()` reassigning the same `href`) does not hang.
  - The glossy pattern (link created by JS) works, and so do `//fonts…` URLs.
  - A 400 family ends `completed` with a warning.
  - A miss gives `FONTS_MISSING` with the exact list.
  - The canvas and same-`href` cases from stage 4 pass through `fulfill`.
  - The sink-proxy harness from the lost patch proves zero external attempts, with a `preconnect` link in the fixture **(review fix)**.
- In production: `verify-hosted` gains a synthetic fonts project (static link, `@import`, `setFont()` and a family that does not exist) with three jobs:
  1. The first render is `completed`, and `manifest.fonts.served` holds at least one CSS and one woff2 with SHA-256.
  2. **(review fix)** A second render of the same revision needs no refill, has an identical `servedDigest`, and its PNG matches the first within a pixel tolerance. Byte-identical PNG SHA-256 is informational only: each job gets a new Sandbox (`lib/jobs.ts:149`), and Skia rasterization may vary with the VM's CPU. Today the script checks only the download hash (`scripts/verify-hosted.mjs:245-246`) and the dimensions (`:99-104`).
  3. A smoke test with the missing family is `completed` with a warning.

### Stage 6: Hosted preview. Server-side CSS, editor bridge, public cache-only route. 2.5 days

**Files**

- `app/api/fonts/v1/f/[file]/route.ts` (new)
- `app/api/studio/projects/[id]/fonts/route.ts` (new)
- `lib/fonts.ts` (`cssForPreview`)
- `lib/preview.ts:41-91`
- `lib/importer.ts:145-171`, `:195-201`, `:209`, `:237`
- `app/api/studio/projects/[id]/preview/route.ts:16-35`
- `src/runtime/frame.ts` (the `fontBroker` shim)
- `components/widget-preview.tsx:31-75`
- `tests/web/preview-fonts.test.ts` (new), `tests/integration/preview-fonts.test.mjs` (new)

**Changes**

- **Public route `GET /api/fonts/v1/f/<sha256>.<mac>.<woff2|woff|ttf|otf>`.**
  - It serves only objects already in the cache. It never contacts Google and never spends budget, which keeps upstream fetches off a public endpoint.
  - **(review fix)** It verifies a short HMAC suffix (`<mac>`) before touching Blob. The suffix is a filter, not a capability: without it, every random SHA would cost an invocation and a Blob `get` (`lib/storage.ts:67-72`), and the production domain is public (`docs/VALIDATION.md:49`). A miss is answered with 404 and a short cache. Also enable a rate limit in the Vercel firewall.
  - It rejects any query string and any malformed path before reading, and verifies SHA-256 on read.
  - Headers: a font `Content-Type`, `Cache-Control` and `CDN-Cache-Control` immutable for one year, `Access-Control-Allow-Origin: *`, `Cross-Origin-Resource-Policy: cross-origin`, `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'`.
  - It does not use `endpoint()` or `guardRequest`: a font requested by the opaque iframe arrives with `Origin: null` and would be rejected (`lib/http.ts:15-18`).
  - The content is a font, not executable, which satisfies `AGENTS.md:9`.
- **Authenticated route `POST /api/studio/projects/:id/fonts`** takes `{url, sampleText, revisionId?}` and uses `endpoint()` and `getProjectAuthorized`.
  - It canonicalizes the URL and resolves it through `lib/fonts` (`preview` bucket), with a per-project rate limit on the server. The nonce and session id sit in the `srcdoc`, in the widget's own realm (`lib/preview.ts:79`, `:85`, `:89`), so the widget can forge `frame:font-request`.
  - It downloads the subsets that cover `sampleText`.
  - **(review fix)** It writes to the lock only when the revision is saved **and** the request carries no `fieldData` override. `isSaved` compares only the snapshot (`route.ts:31`).
  - It returns `{status, css}`, with every `url()` pointing to `${origin}/api/fonts/v1/f/<sha>.<mac>.<ext>`. `@font-face` rules for subsets not downloaded yet are removed from the CSS, and the result is marked `partial`. The response is `no-store`.
- **`lib/preview.ts`.**
  - `inline()` stops embedding Google resources. Today it embeds every asset (`:68`), under a 3 MB limit (`:61`).
  - Static Google `<link>` and `@import` are resolved on the server to `data:text/css` through `cssForPreview`, with `data-sws-original-href` and a time limit. If the time runs out, the original URL stays and the bridge resolves it on the client.
  - `_import/` assets whose `sourceUrl` is Google revert to the original URL.
  - `runtime.fontBroker = true`.
  - The CSP at `:84` gains `font-src data: ${origin}/api/fonts/v1/f/`. Everything else stays identical, including `connect-src 'none'` and `frame-src 'none'`, which `scripts/verify-hosted.mjs:200` checks.
  - The preview route gives `previewHtml` a font source bound to the real `getStore()`, drafts included. `DraftStore` (`route.ts:16-22`) stays limited to draft assets.
- **Importer.** Now, and only now, it stops downloading Google into `_import/` (`:195-201`, `:209`) and keeps the canonical URL. The warning at `:237` changes to say that Google Fonts come from the proxy and that all other runtime network access stays blocked.
- **`frame.ts`**, with `fontBroker` on:
  - It shims `HTMLLinkElement.prototype.href` (setter and getter) and `Element.prototype.setAttribute('href')` for Google URLs. The request is held back, and `frame:font-request {requestId, url, sampleText}` goes out.
  - `host:font-response` sets a `data:` URL through the native `href` setter. The getter still returns the original Google URL.
  - The broker resolves or rejects the tracked promise from stage 4. Without that, `sheet.href === href` never matches in broker mode, and the preview would fall into `Asset readiness timed out`.
  - A 4xx produces a synthetic `error` event.
  - A fallback MutationObserver catches links inserted through `innerHTML`. That case hits a CSP block before the redirect, and this is documented.
  - **(review fix)** After a link's first `load`, the runtime never touches the widget's `<link>` again. When `settle()` sees codepoints outside the loaded subsets, the extra subsets go into a runtime-owned stylesheet, or into `FontFace` objects built from `ArrayBuffer`, added to `document.fonts` with the same family and descriptors. Swapping the widget's `href` would fire its handlers again: se-wheel calls `start()` inside `link.onload` (`se-wheel/script.js:1007-1015`), and se-spinning-badge creates another link on `error` (`se-spinning-badge/widget.js:103-108`). In StreamElements, new text only downloads more subsets through `unicode-range`, with no new `load`. The same applies to a static link resolved on the server as `partial` (CJK).
- **`widget-preview.tsx`** handles `frame:font-request`: it validates the shape, limits requests to 32 per session (a UX limit, not a security one), fetches with the Bearer token and an `AbortController`, and answers `host:font-response` with `postMessage('*')`, as at `:62`. It shows the `frame:fonts` report in the status.

**Tests**

- Web, public route: it rejects a query string, an invalid path, a bad MAC, methods other than GET, and a missing SHA. It accepts `Origin: null`, sends the right headers, and never calls upstream.
- Web, `/fonts` route: it requires the Bearer token and enforces the per-project limit. Neither a draft nor a request with a `fieldData` override writes the lock.
- Web, `previewHtml`:
  - The CSP has the `font-src` path and still has `connect-src 'none'` and `frame-src 'none'`.
  - A static Google link becomes `data:` with `data-sws-original-href`, and no Google asset is embedded.
- Web, import: no `_import/` for Google.
- Integration: the HTML from `previewHtml` runs in a `sandbox="allow-scripts"` iframe inside a test page that implements the bridge against a fake upstream.
  - `setFont()` loads with zero `securitypolicyviolation`, and `frame:fonts` arrives as `loaded`. The getter returns the Google URL.
  - The same `href` gives a single `load`, a double swap works, and a 400 gives `error` plus a warning.
  - `stylesheet-readiness` passes in broker mode.
  - **(review fix)** The widget's `onload` handler runs exactly once when CJK text arrives after the first load.
- In production: open se-windows (six themes) and one glossy widget in the editor, in the normal view and the gallery, and see `Ready` with the right families.

### Stage 7: Field updates as in StreamElements, googleFont control, tutorial. 1.5 days

**Files**

- `src/config/schemas.ts:25-46` (`widget.fieldUpdate`)
- `lib/schema.ts` (the `widget` part of the snapshot)
- `src/studio-ui/capture-host.ts:44-92`
- `src/scenarios/runner.ts:54-119`, `:272-281`
- `src/capture/renderer.ts:432-452`
- `src/tutorial/timeline.ts:175-185`, `:647-659`
- `components/studio-editor.tsx:129`, `:140-146`
- `tests/integration/tutorial.test.mjs`, `tests/unit/tutorial.test.mjs`

**Changes**

- **`widget.fieldUpdate`: `'reload'` or `'event'`.** The proposed default is `'reload'`, to be confirmed in the real StreamElements editor.
  - In `'reload'` mode, a capture, tutorial or scenario `fields` event recreates the iframe with the merged `fieldData`: the document with placeholders substituted again (stage 3), a new `onWidgetLoad`, then `settle()`.
  - `'event'` keeps today's behaviour, which dispatches only `onWidgetUpdate` (`src/runtime/frame.ts:352-360`).
  - Why: among the Google Fonts widgets, only five listen to `onWidgetUpdate` (for example `se-windows/script.js:750`, the three glossy widgets and se-jelly-chat). The others read the font only in `onWidgetLoad` (for example `se-text-widgets/magazine/script.js:935`), so the font would never change in a video.
  - The hosted preview already remounts the iframe on every change (`components/widget-preview.tsx:31-43`, `:89`). This stage aligns capture with it.
- **Clock in reload mode (review fix).** Today, loading depends on `captureHostLoadWithClock`, which advances `page.clock.runFor` while it waits for the ready selector (`src/scenarios/runner.ts:80-89`). `bridge.start` uses a virtual `window.setTimeout` (`src/studio-ui/bridge.ts:77-80`), and `openScene` repositions the clock (`runner.ts:179-189`). Inside `renderVideoFrames` (`src/capture/renderer.ts:432-452`), that would shift `currentTime` or leave the load hanging. Reload is specified as:
  - A new `docKey`.
  - The load is awaited with a real-time deadline in Node and without `runFor`.
  - If the ready selector needs virtual time, that time is subtracted from the timeline explicitly and recorded, so the frame timestamps stay exact.
- **Latent tutorial bug.** `TEXT_TYPES` contains `'googleFont'` (`src/tutorial/timeline.ts:180`), but normalized types are lowercase `'googlefont'` (`src/config/fields.ts:62`, listed at `:20`). A tutorial step on a googleFont field falls into `TUTORIAL_FIELD_UNSUPPORTED` today (`timeline.ts:647`, `:655-659`). Fix the entry. `tutorial-host.ts` already renders unknown types as a text field.
- **Editor control.** Today `googlefont` falls into the default text input (`components/studio-editor.tsx:145`), and every keystroke calls `setFieldData` (`:129`) and remounts the preview. With the proxy, that would fetch `R`, `Ro` and so on, fill the cache and the budget, and multiply by six in the gallery. The new control commits only on blur or Enter, with a debounce of about 400 ms. Optionally, a `datalist` offers the families already in the project's lock.

**Tests**

- A tutorial with a widget that listens only to `onWidgetLoad`: in reload mode, the family changes on the first frame after `atMs`.
- **(review fix)** Frame timestamps before and after a reload match the timeline exactly.
- A widget that listens to `onWidgetUpdate` stays correct in event mode.
- A tutorial step on a googleFont field does not throw.
- Editor control: no preview POST while typing, and exactly one on blur.
- The verification scenario in `verify-hosted` (`updateFields` at `:64`) still passes in both modes.

### Stage 8: Docs, skill, production acceptance. 1 day

**Files**

- `docs/CAPTURE.md:12`, `:15`, `:39`
- `docs/RUNTIME.md:23`, `:74`
- `docs/VERCEL.md:20`, `:37`, `:39`
- `README.md:10`, `:38`, `:67`
- `docs/API.md:150`, `:169`
- `docs/CLI.md:191`
- `skills/se-widget-studio/SKILL.md`
- `skills/se-widget-studio/references/hosted-workflow.md:23`, `:111`, `:115-126`
- `skills/se-widget-studio/references/catalog-authoring.md`
- `skills/se-widget-studio/references/local-workflow.md`
- `skills/se-widget-studio/scripts/studio-client.mjs:243-252`, `:338-348`
- `tests/web/skill-client.test.ts`

**Docs.**

- Describe the proxy, the append-only cache, the per-revision lock, discovery passes, the font report and the new codes.
- Describe placeholders and `fieldUpdate`.
- Describe the known divergences: no FOUT; geometry measured with a cold cache (Playwright disables the HTTP cache under routes); `cssRules` readable and `data:` underneath in the preview; `/icon` and `text=` outside the allowlist.
- State that the local CLI blocks Google Fonts with `FONT_UNAVAILABLE`.
- Correct `docs/CAPTURE.md:15`, which claims that font readiness completes with the clock frozen. That was never true for a stylesheet swapped at runtime.

**Skill** (the skill's workflow does not change):

- `hosted-workflow.md`:
  - Replace `:111` ("The hosted runtime blocks external network access…") with: Google Fonts (`fonts.googleapis.com` `/css` and `/css2`, `fonts.gstatic.com` `/s/`) are served from the Studio cache and fetched on demand with no preparation; `/icon` and `text=` give `FONT_UNSUPPORTED`; all other runtime network access stays blocked and must be captured during preparation.
  - Rewrite "Known gaps" (`:115-126`): drop the Google Fonts bullet (`:117-121`) and the placeholder bullet (`:122-126`), and keep the CDN-script gap.
  - Add a short "Fonts" section:
    - Never ask to vendor a font or edit the widget because of it (`AGENTS.md:8`).
    - A job may show `Fetching Google Fonts (pass n/4)`.
    - Results are in `manifest.json` → `fonts` (`served` with URL and SHA-256; `issues`) and in the test report → `fonts`.
    - What each code means: `FONT_UNAVAILABLE` (retry later), `FONT_DISCOVERY_LIMIT`, `FONT_SETTLE_TIMEOUT`, `FONT_UNSUPPORTED`, and the `upstream-4xx` warning (fallback, as in StreamElements).
    - A later render of the same revision does not contact Google.
  - The asset example `fonts/widget.woff2` (`:23`) still applies to a widget's own font files, not to Google Fonts.
- `hosted-workflow.md` and `catalog-authoring.md`:
  - `{{field}}` is simulated in HTML, CSS and JS.
  - Themes and scenes may change `googleFont` freely.
  - Saving prewarms the cache, and prewarm warnings appear in `revision.diagnostics`.
  - `widget.fieldUpdate` (`'reload'` or `'event'`) belongs in catalog authoring.
- `local-workflow.md`: the local CLI blocks Google Fonts with `FONT_UNAVAILABLE`, and a widget that depends on them is validated in hosted mode. Do not reintroduce `--allow-google-fonts`.
- `SKILL.md`: add one line under hosted mode, "Google Fonts work as in StreamElements; never vendor fonts or edit the widget for them". `:37` (never install fonts locally) stays as it is.
- `studio-client.mjs`: after downloading the artifacts (`:338-345`), read `manifest.json` and print `fonts.issues` on one line. `status` (`:243-252`) already prints `diagnostics` and `warnings`, where prewarm warnings land. `tests/web/skill-client.test.ts` covers the summary.

**Production acceptance.** Compare against real StreamElements, and report the simulation separately from real validation (`AGENTS.md:17`):

- se-windows (six themes)
- one glossy widget
- se-text-widgets/sticker (CJK, M PLUS Rounded 1c)
- se-wheel (canvas, and `@import` with `opsz`)
- se-8bit and se-custom-chat (placeholders)
- se-cloud-chat and se-shaped-marquee (geometry)

**Tests.** Review the docs against the code. Run `npm run typecheck`, `npm test` and `npm run build` (`AGENTS.md:14`), then the full `verify-hosted` in production.

## 6. Proposed AGENTS.md amendment (PENDING USER APPROVAL)

**Status: PENDING USER APPROVAL. Do not apply until the owner approves the exact text.** It replaces `AGENTS.md:10-11` in the stage 2 PR.

This wording includes the review's corrections. The earlier draft said "preview pages may reach only…", but a `sandbox="allow-scripts"` iframe can still navigate itself, and the CSP does not block navigation. It also called the whole cache never-overwritten while the negative cache is overwritable.

```md
- Never weaken path containment, bridge nonce/source/origin validation, external-network blocking, or output preflight. Sole exception, the Google Fonts proxy: trusted server code may GET `https://fonts.googleapis.com/css`, `https://fonts.googleapis.com/css2`, and `https://fonts.gstatic.com/s/*` with a fixed User-Agent, no redirects, no forwarded client headers or credentials, bounded size and time, and validated content. It keeps the bytes in an append-only, content-addressed cache whose objects and URL index are never overwritten or deleted (short-lived negative entries for upstream 4xx answers live outside that index), and serves them to previews and renders. Widget code never connects to Google or any other external origin: preview pages load subresources only from the Studio's read-only engine path and its cache-only font path, and render Sandboxes stay `deny-all` and receive fonts only as job files that the trusted worker answers with `route.fulfill`. Every other origin, redirect, and WebSocket stays blocked.
- Never download browsers, FFmpeg, codecs, or fonts from runtime code, except Google Fonts stylesheets and font files that trusted server code fetches through the proxy above.
```

Why it is safe to approve:

- The network rule gains one named exception: GET only, two hosts, three path prefixes, no redirects, validated content.
- Widget code still never connects to Google or anywhere else. The Sandbox stays `deny-all`, so no sentence has to open the network there.
- It is accurate about the preview, which already imports `${origin}/engine/` (`lib/preview.ts:84-85`) and will add only the cache-only font path.
- "Store immutable revisions" (`AGENTS.md:15`) does not change. Revisions stay immutable, the lock only grows, and the cache is append-only.

## 7. Where the fonts come from, per surface

| Surface | Static `<link>` / `@import` | Runtime `setFont()` / JS link | Font files |
| --- | --- | --- | --- |
| Hosted editor preview | Resolved on the server into `data:` CSS | Shim, then editor bridge, then `POST …/fonts` | `GET /api/fonts/v1/f/<sha>.<mac>.<ext>` (cache only) |
| Hosted render or test job | `route.fulfill` from job files | `route.fulfill` from job files; a miss leads to a discovery pass | `route.fulfill` from job files |
| Local CLI | Blocked, `FONT_UNAVAILABLE` with a hint | Blocked, `FONT_UNAVAILABLE` with a hint | Blocked |

## 8. What to salvage from the lost patch

Nothing is left in the repository. The branch `feat/allow-google-fonts` points at `ed8765f` with no commits of its own, and its worktree (`/private/tmp/claude-501/-Users-guilhermeshuto-dev-firulas-se-windows/938e2463-4ab2-4348-b83d-249beae26737/scratchpad/se-dev-kit-gf`) is gone and shows as `prunable`. Grepping for the symbols returns nothing.

The only source is the Claude Code transcript of the 2026-09-25 se-windows session:

- Main transcript (1789 lines): `~/.claude/projects/-Users-guilhermeshuto-dev-firulas-se-windows/938e2463-4ab2-4348-b83d-249beae26737.jsonl`
- Subagents: `~/.claude/projects/-Users-guilhermeshuto-dev-firulas-se-windows/938e2463-4ab2-4348-b83d-249beae26737/subagents/workflows/wf_6d2b209f-dc1/`
  - `agent-aabe33b348cb562eb.jsonl`: patch docs and tests (200 lines), including the sink-proxy harness.
  - `agent-aae5d50a6a74da506.jsonl`: security review.
  - `agent-aff8e40e0458d6522.jsonl`: correctness review.

By default, Claude Code deletes local transcripts after 30 days. Extract what is needed before about 2026-10-25, or copy the files somewhere durable. `L<n>` below means line n of the main transcript unless another file is named.

**Reuse**

- **Stage 4, `src/runtime/frame.ts`.** `stylesheetLoads`, `isStylesheetLink`, `trackStylesheet` (same-`href` and late-load guards), `watchStylesheets` (MutationObserver on `childList` and on the `href`/`rel` attributes), `waitForStylesheets` (do/while), and the order "stylesheets, then forced layout, then `fonts.ready`" at the start of `waitForLoadedAssets`.
  - The edits are at L1118, L1146 and L1379. The final version is printed in full at L1395.
  - `frame.ts` has not changed since `ed8765f`, so it applies cleanly.
  - Two adjustments are needed: read `href` and `sheet.href` through the native getter saved before the shim, and accept resolution from the broker (stage 6). Without them, broker mode hangs.
- **Stages 4 and 6, `tests/integration/stylesheet-readiness.test.mjs`** (L1146, L1358, L1379, L1409).
  - Stylesheets must come from another origin (`localhost` against `127.0.0.1`), or the bug does not show (L1405 against L1418).
  - Cases: slow swap, double swap, same `href` cached, round trip, `missing.css`.
  - Mutating each guard breaks the test (L1412).
  - Still to add: the single synthetic `load` and broker mode.
- **Stage 5.** The `routeExternalRequest` skeleton (L659) and the six stub tests in `tests/unit/network-allowlist.test.mjs` (L392, L669) become `serveFontRequest`, which fulfills from the resolver and never calls `route.fetch`.
- **Stage 5.** The sink-proxy harness from `tests/integration/network.test.mjs` is in `agent-aabe33b348cb562eb.jsonl`, L71–L167 (Chromium with proxy bypass `<-loopback>,127.0.0.1`). It proves zero external attempts.
- The `manifest.network` idea (L338, L342) becomes `manifest.fonts`.
- **Learnings that become test assertions:**
  - The old stylesheet stays until the new one loads (L1094–L1095).
  - Under `context.route`, reassigning the same `href` fires no `load` (L1370), while A→B→A does (L1375).
  - Bungee fell into a silent fallback while `fonts.ready` still resolved (L1077–L1082).
  - With live network, one transient failure breaks a render (L1470).
  - Playwright does not route redirect hops (security review, `agent-aae5d50a6a74da506.jsonl`).

**Discard**

- The `--allow-google-fonts` flag, `GOOGLE_FONTS_ORIGINS` / `allowedExternalOrigins`, the live fetch, `GOOGLE_FONTS_UNUSED`, and the commander and `dev --open` plumbing (L321, L383, L669).
- `network.test` as a policy test.
- The patch's docs (`CLI.md`, `CAPTURE.md`, `RUNTIME.md`, `README.md`, `local-workflow.md`; `agent-aabe33b348cb562eb.jsonl` L146–L158, main L857, L869). They say "hosted jobs never allow it", which is the opposite of the decision.

**Factual correction to the design.** The final version of the patch did not use `route.continue`. It used `route.fetch({maxRedirects: 0})` and aborted on 3xx (L659). The redirect escape existed only in the earlier version (L321–L322). The flag still does not come back: in the `deny-all` Sandbox (`lib/jobs.ts:149`) `route.fetch` would always end in `abort('failed')`, and live network is not reproducible.

**Rebase and extraction**

- `runner.ts` and `renderer.ts` have changed since the patch. `openScene` already takes a fifth parameter, `OpenSceneOptions` (`src/scenarios/runner.ts:148-161`), which the tutorial uses (`src/capture/renderer.ts:396-404`). The patch's old `network` parameter becomes `OpenSceneOptions.fonts`.
- Most edits were made with `python3` heredocs run through Bash, in the patch worktree. Extract the inputs of `Edit`, `Write` and `Bash` in transcript order with `python3` or `jq`.
- L338 has no assertion of its own. Check it against the diff at L348.
- `dist/` is not part of the patch.

## 9. What can only be confirmed later

**On production Vercel**

- **Function egress** to `fonts.googleapis.com` and `fonts.gstatic.com`: DNS order (whether IPv6 answers come first), latency, and whether the CSS returned for `GOOGLE_FONTS_UA` is woff2 with `unicode-range`. The review's `curl` ran outside Vercel. The first production preview or render confirms it, and the manifest records the User-Agent and the address used.
- **Chromium `139.0.7258.5`** from the Sandbox snapshot (`docs/VALIDATION.md:51`). It must show:
  - that reassigning the same `href` under `context.route` fires no `load` (seen only in local Chrome, L1370);
  - how `document.fonts.status` moves when layout is forced;
  - whether `MessageChannel` stays outside Playwright's fake clock;
  - whether the `fillText`/`measureText` wrapper works.
  The fonts variant of `verify-hosted` confirms these.
- **Several passes in one Sandbox:**
  - Can a detached `runCommand` run again after the first command finishes?
  - Does `writeFiles` accept new files after that?
  - What does each pass cost (the workflow's 10 s sleep at `workflows/render.ts:23`, plus Chromium boot) within the 10-minute budget (`lib/jobs.ts:10`)?
  - What is the step duration limit for the refill?
- **Public font route:** whether the Vercel CDN honours `CDN-Cache-Control: immutable`, and whether an opaque `srcdoc` iframe (`Origin: null`) loads the font with `Access-Control-Allow-Origin: *` under a path-scoped `font-src`.
- **Limits and latency:** the real Function response size limit (acknowledged at `app/api/studio/projects/[id]/artifacts/[artifactId]/route.ts:9`) against the 4 MB per-file limit, and the latency of uncached `BlobStore.get` (`lib/storage.ts:69`) for dozens of objects per job.
- **Cost of a first CJK render** (se-text-widgets/sticker, M PLUS Rounded 1c, hundreds of subsets): invocations, Blob operations and passes. This calibrates the limits of 64 eager files, 8 MB and 4 passes.

**On real StreamElements and OBS** (report separately, `AGENTS.md:17`)

- Whether `{{field}}` is also substituted in JS, and with what escaping (quotes, spaces).
- What happens to a placeholder that has no field.
- Whether StreamElements injects the stylesheet for a `googleFont` field by itself, or only passes the name.
- Whether changing a field in the editor reloads the widget. This sets the default for `widget.fieldUpdate`.
- Whether OBS shows FOUT.
- The geometry of se-cloud-chat and se-shaped-marquee, which measure inside `fonts.ready.then` (`se-cloud-chat/script.js:392-393`, `se-shaped-marquee/widget.js:331-337`), with OBS's warm cache against the capture's cold cache.

## 10. Risks

- **First-render latency.**
  - Each extra pass costs at least the 10 s poll plus Chromium and scene boot.
  - A widget never opened in the editor may need two or three passes.
  - The limit is four passes within ten minutes, then `FONT_DISCOVERY_LIMIT`.
- **Discovery assumes deterministic capture.** A widget that requests different URLs on each run does not converge. The lock union and the pass limit mitigate this.
- **Google on the first render.** Renders depend on Google the first time a URL appears. That failure is loud (`FONT_UNAVAILABLE`), not silent. This is a deliberate divergence, since StreamElements would show the fallback.
- **CSS pinned by epoch.**
  - When Google updates a family, StreamElements moves to the new version and the Studio does not, until a revision with a new epoch appears.
  - The global `fonts/v1/` cache can never be deleted without breaking reproducibility, so storage grows, bounded only by the budgets.
- **Documented divergences:**
  - no FOUT;
  - in the preview, `link.sheet.cssRules` is readable and the `href` is `data:` underneath, where StreamElements would raise `SecurityError`;
  - a link inserted through `innerHTML` hits a CSP block before the redirect;
  - `@import` in a `<style>` created at runtime and `new FontFace(url)` are not redirected in the preview (they work in renders);
  - the system fallback font is the Sandbox's Linux one, and `scripts/sandbox-prepare.mjs:74` installs only fontconfig and freetype.
- **Canvas.**
  - Without the barrier, a canvas still comes out in fallback (`renderer.ts:294`; `types.d.ts:18660`). With preloading, the Studio shows the font.
  - In StreamElements, a canvas widget without animation can stay in fallback because of the widget's own race (`se-text-widgets/magazine/script.js:176-181`).
  - This divergence favours the intended result and is documented.
- **Cold HTTP cache.** Playwright disables the HTTP cache when routes are active (`types.d.ts:3975`), so every context starts cold. Widgets that measure geometry in `fonts.ready.then` may compute with fallback metrics. `settle()` fixes glyphs, not geometry. The resolver's synchronous memo shortens that window.
- **Preview shim.** It patches prototypes (`HTMLLinkElement.href`, `Element.setAttribute`), and synthetic `load`/`error` events may diverge in edge cases. If Chromium ever fires a native `load` for the same `href` under interception, a double `load` could occur. Deduplication covers it, but it needs a test on Chromium 139.
- **`'reload'` default.** Making `'reload'` the default changes tutorial videos of widgets that keep state across updates, such as se-windows. So it is configurable per widget and waits for confirmation in StreamElements.
- **Raw placeholders.** Substituting placeholders raw, as StreamElements does, can break CSS or JS when a value contains quotes. This is faithful to StreamElements, but it is a new class of error in the Studio and needs a clear message.
- **Budget.** An exhausted daily budget blocks new fonts for that day (`FONT_UNAVAILABLE` with reason `budget`). The `render` and `preview` buckets are separate, so the editor cannot starve renders.
- **Old revisions.** Revisions with Google captured into `_import/` (TTF, User-Agent `SE-Widget-Studio/0.2`, `lib/importer.ts:53`) depend on the migration in materialize and preview. If the migration misses an edge case, a page mixes TTF and woff2.
- **New surface.** The UI, the skill and the docs must learn it: the `frame:fonts` event, the `host:settle` and `host:font-response` commands, and the codes `FONT_UNAVAILABLE`, `FONT_SETTLE_TIMEOUT`, `FONT_UNSUPPORTED`, `FONTS_MISSING` and `FONT_DISCOVERY_LIMIT`.
- **Effort.** About 16 days, against the design's 8–10. Placeholders, canvas, passes, `fieldUpdate` and the googleFont control were added since. The review fixes were not re-estimated.

## 11. Out of scope

- Any other runtime origin:
  - the jelly-ui module script (refused at `lib/importer.ts:187`);
  - three.js injected at runtime (se-lava-lamp);
  - emotes and badges from `static-cdn.jtvnw.net` in chat fixtures;
  - the jQuery that events-tag expects StreamElements to provide.
  For these widgets, "upload without preparing anything" still does not hold. The generic origin interface from stage 1 leaves room for them later.
- Google Fonts `/icon` and `text=` (`FONT_UNSUPPORTED`).
- A local CLI mode that fetches or replays Google Fonts. It is deferred, and `--allow-google-fonts` does not return.
- FOUT simulation.
- Vendoring fonts or editing consumer widgets for fonts.

## 12. Review findings index

An adversarial review checked about 60 `file:line` references and found one blocking issue, seven important ones and nine minor ones. None of them reopens the proxy-with-cache decision. Each fix lives in the stage shown.

| Severity | Finding | Fix | Stage |
| --- | --- | --- | --- |
| Blocking | Unquoted `{{token}}` breaks `postcss.parse` (`lib/importer.ts:99`) before any placeholder handling, so se-8bit and se-custom-chat stay blocked | CSS-valid sentinels around parse, at all four call sites. A value that breaks parse becomes a warning. | 3 |
| Important | The lock does not record 4xx, so the discovery loop never converges for css2 weight lists | Lock entries carry `status`, and the resolver replays it | 2, 5 |
| Important | Test jobs have no discovery. `runOneScenario` swallows errors (`runner.ts:294-296`). | Typed `FONTS_MISSING` rethrown, and the same pass loop for `kind: 'test'` | 5 |
| Important | `/__sws/doc/<key>/` breaks relative `url()` in CSS | Keep `/__sws/widget/<path>?doc=<key>` | 3 |
| Important | `src/fonts/url.ts` is not served to the frame (`copy-assets.mjs:18-20`, `server.ts:201-211`) | Move it to `src/runtime/google-fonts-url.ts` and add it to the frame server's list | 1 |
| Important | The duplicate-pass lock makes a retried refill fail the job | The second worker waits for `result-<n>.json`, and polling decides on the result file | 5 |
| Important | Swapping the widget's `<link>` for extra subsets fires its handlers again (se-wheel, se-spinning-badge) | Never touch the widget's link after the first load. Use a runtime-owned stylesheet or `FontFace`. | 6 |
| Important | Reload mode does not define the clock mid-video | New `docKey`, real-time load deadline without `runFor`, explicit timeline accounting | 7 |
| Minor | The cache-only public route is still an unauthenticated Blob read | HMAC suffix filter, 404 with short cache, Vercel firewall rate limit | 6 |
| Minor | The amendment overpromised (navigation, and "never overwritten" alongside the negative cache). Substitution bypasses import refusals. | Reworded amendment, and HTML refusals re-run after substitution | 6 (§6), 3 |
| Minor | Stage 3 alone breaks preview for placeholders inside Google links | `inline()` passes Google URLs through until stage 6 | 3 |
| Minor | The saved revision's lock can be polluted (`isSaved` ignores `fieldData`; forged requests; unsandboxed Chromium) | Lock writes only without overrides, re-canonicalize and cap `needsFonts`, cap lock entries | 5, 6 |
| Minor | Equal PNG SHA-256 across Sandboxes may fail spuriously | Compare `servedDigest` plus pixels with tolerance. SHA is informational. | 5 |
| Minor | `font-readiness` uses `route.continue`, not the render path | Re-run the canvas and same-`href` cases through `fulfill` | 4, 5 |
| Minor | `restoreProject` does not copy font locks (`lib/projects.ts:81-83`) | Copy the lock entries on restore | 2 |
| Minor | The CLI frame serves `<link rel="preconnect">`, which opens a socket outside routing | Drop non-stylesheet external links in the frame server, and add one to the sink-proxy fixture | 3, 5 |
| Minor | A digest over the whole lock changes as the preview adds entries | `servedDigest` covers only what the render served | 5 |
