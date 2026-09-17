# Validation record

Verified on 2026-09-17 UTC (2026-09-16 in America/Campo_Grande), against baseline `591b8abc355be7043b36bb6dc1f48b2e0679c4e6` plus the current UI, documentation, and browser-regression changes. This is a local validation record, not a hosted release certification.

## Story and results

The workflow is: import synthetic widget source → authorized project API → immutable revision → isolated browser preview → test/render jobs → verified downloadable media.

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm test` | Passed: 35 shared-engine tests and 31 web tests |
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

## Hosted boundary still open

A read-only project API probe at `https://se-dev-kit.vercel.app` returned HTTP `503` on 2026-09-17 UTC:

```text
Connect a private Vercel Blob store before using this deployment.
```

Storage mode now selects Blob, but the running deployment does not expose the credentials required by the storage guard. The plugin was reported installed and enabled; authenticated Vercel project tools were not available in this session. Project linking is not evidence that Blob or Sandbox is configured.

Before calling the hosted application complete:

1. Connect a private Blob store and make its credentials available to the production deployment.
2. Confirm `STUDIO_STORAGE=blob`, `STUDIO_EXECUTION=vercel`, and a usable `STUDIO_SANDBOX_SNAPSHOT_ID` prepared with the trusted browser/media baseline.
3. Publish the reviewed changes and redeploy with the correct environment.
4. Verify hosted project creation, private reload, a stale replacement conflict, preview, smoke test, image download, and short-video download using synthetic data and an explicit compute budget.

Sandbox credentials, snapshot existence, quotas, and hosted media generation remain unverified. No Vercel resources were provisioned, no production project was created, and no Git push or deployment was performed during this validation. Real StreamElements/OBS behavior requires a separate target-runtime check.
