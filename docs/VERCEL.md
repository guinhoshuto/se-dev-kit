# Personal Vercel deployment

This app uses Next.js, private Vercel Blob objects, Vercel Workflows and short-lived Vercel Sandboxes. It has no external database and no user accounts. Anyone holding an editing capability can access the project. Protect editing links like passwords; do not index or publish them. A Hobby deployment is intended for personal, non-commercial use within Vercel's current limits. No code in this repository upgrades a plan or purchases capacity.

## Configure storage and compute

1. Import this repository into a Vercel project and connect a **private** Blob store. Set `BLOB_READ_WRITE_TOKEN` using the integration, `STUDIO_STORAGE=blob` and `STUDIO_EXECUTION=vercel`.
2. Prepare the trusted Sandbox snapshot below and set its returned `STUDIO_SANDBOX_SNAPSHOT_ID` in the project. Workflows run using the deployment's Vercel identity. Local setup needs your own Vercel OIDC credentials; do not add them to Git.
3. Deploy the root directory with `npm run build`. Do not set the former nested `se-widget-studio` directory as the project root.
4. Test creation, replacement conflict, a browser scenario, screenshot and short video on the deployed URL. Local validation is not proof of hosted credential/quota setup.

Missing Blob or Sandbox settings fail explicitly. A Vercel deployment never silently stores data on ephemeral disk or starts a local background renderer. Uploaded source is data, not an executable Node.js configuration.

Linking a Vercel project or installing its editor plugin does not complete storage or renderer setup. Keep the local values in `.env.example` out of hosted environments. A `503` saying `Connect a private Vercel Blob store before using this deployment.` means the running deployment has neither a Blob integration token nor the supported store-ID/OIDC combination. Check the production environment, connect the private store, and redeploy after configuring it. Do not paste credentials into chat, client code, or Git.

If `STUDIO_CREATE_KEY` is enabled, use the optional **Workspace creation key** field on the import screen or send `X-Studio-Key` from your API client. The Studio does not persist this workspace key. It is separate from each project's private editing capability.

## Explicit browser/media snapshot setup

Normal app startup and render jobs **never** install browsers, fonts or media tools. Snapshot setup is a separate operator action. Obtain Linux x64 static FFmpeg and ffprobe binaries from a trusted source, verify their provenance/checksums, and keep their versions fixed. The script rejects non-Linux binaries; your macOS Homebrew executables cannot run in a Linux Sandbox.

```sh
npm ci
npm run build:engine
node scripts/sandbox-prepare.mjs --allow-downloads \
  --ffmpeg /absolute/path/to/linux-static/ffmpeg \
  --ffprobe /absolute/path/to/linux-static/ffprobe
```

This explicitly creates a Sandbox, installs lockfile-pinned dependencies, the Chromium build selected by `playwright-core@1.54.2`, and Linux browser libraries. It verifies a browser launch and both media binaries, records hashes/versions and creates an immutable snapshot. It consumes your Sandbox quota. Review Vercel's current limits before executing it. It does not upload widget content or credentials into the baseline. FFmpeg libraries must be statically linked or included in your own reviewed image. Review binary licensing for your use.

The returned JSON includes the snapshot ID. Retain it with your deployment notes. The app clones this baseline for each job, uploads only trusted engine files and the pinned immutable widget snapshot, disables all external network access, and executes the worker without Blob/API credentials. Jobs are terminated after ten minutes. Final assets and reports are copied back to private Blob with verified SHA-256 hashes. Sandboxes and intermediate frame sequences are then discarded. Final project revisions and output objects remain in Blob until explicitly removed by an operator.

Rebuild the baseline deliberately when updating Node, Playwright, FFmpeg or fonts. The script fixes Playwright at 1.54.2; review its guard when upgrading. Browser/system fonts can differ from local Chrome: compare final media using the same snapshot when repeatability matters.

## Local mode and intermediate video

Use `STUDIO_STORAGE=local` and `STUDIO_EXECUTION=local` outside Vercel. Jobs run in a separate credential-stripped Node process with a ten-minute timeout; the local Next process must remain running. Install Chrome and FFmpeg/ffprobe yourself or point `SE_WIDGET_STUDIO_BROWSER`, `STUDIO_FFMPEG_PATH`, and `STUDIO_FFPROBE_PATH` at existing executables. No downloads happen during rendering.

Web jobs require validated final video and report failure if FFmpeg/ffprobe are missing; successfully captured images and manifests remain available. To retain a PNG sequence when FFmpeg is unavailable, use the shared local CLI with `--allow-intermediate` and an explicitly selected output directory. The sequence and `frames.json` describe frame rate and encoding. Web job temporary frames are not retained permanently.

## Verification boundaries

The runtime simulates a documented subset of StreamElements. Offline rendering cannot test undocumented APIs, real channel events, StreamElements hosting or OBS parity. Never submit channel tokens, cookies, webhooks or real viewer data. Workflows are orchestration only: permanent results live in Blob, not short-lived Workflow logs. Monitor private Blob storage and compute usage; rendering high-resolution videos consumes substantially more resources than interactive preview.

Official references: [Sandbox SDK](https://vercel.com/docs/sandbox/sdk-reference), [Workflows](https://vercel.com/docs/workflows), [Blob](https://vercel.com/docs/vercel-blob), [Function limits](https://vercel.com/docs/functions/limitations). Hosting and marketplace terms can change; verify current quotas and eligibility in your Vercel dashboard before deployment.
