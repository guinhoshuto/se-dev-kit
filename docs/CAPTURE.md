# Capture and media

## Deterministic browser context

Each scenario or variant gets a fresh, ephemeral Playwright context with:

- Fixed `en-US` locale and `UTC` timezone.
- Explicit viewport and device scale factor.
- A fixed clock installed before navigation.
- Seeded `Math.random` inside the widget frame.
- Service workers blocked.
- Non-loopback network requests blocked.
- No inherited cookies, local storage, or persistent browser profile.

The clock is paused before the widget starts. Document, font, image, and video readiness completes while virtual time remains frozen. If a configured ready selector is created by a widget timer, the runner advances time in deterministic 16 ms quanta only after those assets are ready; it never advances according to real I/O speed. The system clock is then restored to the configured fixed instant. Stills keep CSS/Web Animations enabled and sample them at `captureAtMs`; motion frames advance the paused clock at exact timestamps.

## Output plan and overwrite rules

The renderer calculates matrix cardinality before entering expansion loops. The default limit is 48 variants, enforced with integer-safe arithmetic; use `--allow-large-matrix` only after reviewing the reported count. It then rejects unsafe ids, duplicate filenames, crops outside the output canvas, an unsafe output root, symlinked output components, and any existing planned file without `--force`.

Before variants or frame paths are materialized, planning also counts total video frames and planned files. The default render-workload limit is 10,000 files, including numbered PNG frames and manifests. `RENDER_LIMIT_EXCEEDED` reports both totals. `--allow-large-render` is an explicit opt-in for a reviewed larger workload, but cannot bypass the safe-integer boundary. Dry runs enforce the same guard and report `totalFrames` and `totalTargets` in an accepted plan.

`--force` does not clear directories. Temporary files are created next to their final target and atomically renamed. Unrelated files remain untouched.

The renderer hashes production files, config, catalogs, adapter, and allowlisted assets before opening the browser, checks the snapshot before each variant and before the manifest, and aborts with `INPUT_CHANGED_DURING_RENDER` if an input changes. This prevents a long matrix from claiming one reproducible input state while using mixed bytes.

## Manifest

Every render writes a versioned `manifest.json` with:

- Studio version.
- Relative production filenames and SHA-256 input hashes.
- Resolved recipe and marketplace preset.
- Browser path/version.
- FFmpeg/ffprobe detection and versions.
- Per-variant parameters, relative artifacts, frame-manifest hashes, and media hashes.
- Per-artifact MIME type, byte count, actual image dimensions, and SHA-256.
- Deterministic seed, fixed time, locale, and timezone.
- Hashes for the adapter and every allowlisted local asset, including widget images, fonts, and media.
- Contact sheet path, hash, byte count, MIME type, and dimensions when one is produced.
- Final, unvalidated, or intermediate status.

Absolute widget paths, tokens, cookies, and real user data do not belong in the manifest.

## Video

The source of every recording is a finite `frame-%04d.png` sequence and `frames.json` containing FPS, timestamps, dimensions, and hashes. This intermediate remains available even after encoding.

FFmpeg is discovered through an explicit path or the current `PATH`. It is invoked with an argument array and `shell: false`. H.264 MP4 uses `libx264`, `yuv420p`, no audio, and fast-start metadata by default. VP9 WebM is also supported. ffprobe, when present, reads stream/container metadata before the temporary video is committed.

All 4:2:0 video outputs require even final width and height. This is checked during planning, before any PNG frame is written.

When FFmpeg is absent, no download is attempted. The output status is `intermediate`; pass `--allow-intermediate` only when the PNG sequence is an acceptable deliverable.

## Marketplace data

Marketplace requirements change independently of Studio releases. Profiles live in `presets/marketplaces/*.json` and include official source URLs plus `verifiedAt`. The core renderer records the selected profile but does not hard-code Etsy or another marketplace's limits.

Each preset may include a generic `validation` block. `validate` and recipe dry runs load the preset before any output is written and check matrix counts, formats, dimensions, opacity, duration, aspect ratio, audio, and declared file-size limits. `recipeDefaults` are published authoring defaults; they do not mutate an explicit recipe. A render manifest embeds the exact preset used.

The bundled Etsy profile was verified on 2026-08-05 and records the current maximum of 20 images and 2 videos. Etsy's dedicated video guide says 3–15 seconds while its listing guide says 5–15 seconds, so the operational profile uses the safer 5–15 second intersection. The official wording is “100 MB”; the preset records a decimal 100,000,000-byte interpretation explicitly. Recheck the linked official sources before a future listing campaign.
