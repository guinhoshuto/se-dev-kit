# Validation record

Verified on 2026-09-17 UTC against application commit `cfa3032682371070ed26620e203c9c17fe129f01` plus this documentation update. Local and hosted results are recorded separately; neither is a real StreamElements/OBS certification.

## Story and results

The workflow is: import synthetic widget source → authorized project API → immutable revision → isolated browser preview → test/render jobs → verified downloadable media.

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm test` | Passed: 35 shared-engine tests and 36 web tests |
| `npm run build` | Passed: production Next.js app and Workflow routes |
| `node scripts/verify-web.mjs` | Passed: preview, field save, events, three themes, authorization, stale-write conflict, restore, smoke job, media downloads, mobile layout |
| `node --import tsx scripts/verify-field-precedence.mjs` | Passed: fixture beats theme; saved scene beats fixture; temporary override resets to scene |
| `node scripts/verify-protected-create.mjs` | Passed: missing/wrong keys rejected; demo and JSON creation accepted; creation key absent from storage, URLs, bodies, and iframe data |

Both UI regressions were reproduced before their fixes. The fixture control previously displayed `Theme title` while the preview displayed `Fixture title`; the import screen previously had no creation-key input. No security guard was removed to make either test pass.

The full browser run created fresh local evidence under `.studio-data/verification-x1ooEk/`: editor, gallery, and mobile screenshots; three 430×640 PNG images; three 215×320 thumbnails; a contact sheet; `preview.mp4`; and `report.json` containing artifact byte counts and SHA-256 hashes. The field run produced `.studio-data/field-verification-rFqFK1/`. These ignored output directories are local artifacts, not files included in a clone.

Downloaded PNG signatures, image dimensions, byte counts, and SHA-256 hashes were checked. The existing ffprobe executable confirmed one H.264 video stream, 430×640, `yuv420p`, 30 fps, exactly 3 seconds, and no audio stream in the MP4. Existing Chrome, FFmpeg, and ffprobe were used; no browser, codec, font, or dependency was downloaded for this validation.

## Reproduce locally

Use the existing installed dependencies and browser/media tools. Run the three repository commands above, then keep the production server running:

```sh
STUDIO_STORAGE=local STUDIO_EXECUTION=local STUDIO_DATA_DIR=.studio-data/validation-server npm start -- --port 4317
```

In another terminal:

```sh
node scripts/verify-web.mjs
node --import tsx scripts/verify-field-precedence.mjs
```

To verify the optional creation gate, use a separate local server:

```sh
STUDIO_STORAGE=local STUDIO_EXECUTION=local STUDIO_DATA_DIR=.studio-data/protected-validation STUDIO_CREATE_KEY=test-only-local-creation-key npm start -- --port 4318
```

Then run `node scripts/verify-protected-create.mjs`. Never reuse the synthetic test key for production. All browser scripts reject non-loopback targets. They create local test projects; they do not erase existing projects or output directories. Daily application budgets apply to repeated runs.

## Hosted production verification

The production alias `https://se-dev-kit.vercel.app` served commit `cfa3032682371070ed26620e203c9c17fe129f01` from a `READY` production deployment. The private Blob store, `STUDIO_STORAGE=blob`, `STUDIO_EXECUTION=vercel`, and `STUDIO_SANDBOX_SNAPSHOT_ID` were configured for Production and Preview.

The non-expiring baseline `snap_wCG9qtoC58k0ZcLQ61aSlS7MHjPS` was cloned and checked before assignment. Chromium `139.0.7258.5`, FFmpeg/ffprobe `n9.0.1-31-g3a7c002718-20260916`, embedded project identity, and `deny-all` networking passed; an external fetch was confirmed blocked. The baseline contains no widget source or Blob capability.

`node scripts/verify-hosted.mjs --base-url https://se-dev-kit.vercel.app/ --allow-hosted --ffprobe /opt/homebrew/bin/ffprobe` then created one synthetic project and exactly three jobs. It passed:

- authorized reload and unauthorized-read rejection;
- stale full-replacement rejection without changing the immutable revision;
- preview field override, bridge values, restrictive iframe CSP, and capability isolation;
- the deterministic browser smoke scenario;
- a private 320×240 PNG download, 9,170 bytes, SHA-256 `6700dedc8f53d65ce5cfe74a6f94138a21d161115be8c873c6a912f6740a8ad4`;
- a private 320×240 H.264 MP4 download, 6,484 bytes, exactly one second, no audio stream, SHA-256 `37f3cc24fe5be77e98d2e7c4cdd33ee9226e0fc0ba25b57762fc8604577ed554`.

The first hosted attempt exposed that a detached Sandbox command's initial `exitCode` remains `null` until the SDK `wait()` method refreshes it. Commit `cfa3032` added a bounded provider wait; the complete second run passed in about 70 seconds. Evidence is stored locally under ignored `.studio-data/hosted-verification-fQuiOC/` with mode `0600`; `report.json` contains no editing capability or signed URL. The accompanying `access.private.json` must remain private.

Hosted verification proves the configured Vercel API, Workflow, Blob, Sandbox, browser, image, and video path with synthetic data. It does not prove undocumented StreamElements payloads, live channel events, OBS browser-source behavior, marketplace acceptance, or future quota availability. Those remain separate target-runtime and operational checks.
