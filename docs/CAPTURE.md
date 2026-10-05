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

The clock is paused before the widget starts. Document, image, and video readiness completes while virtual time remains frozen. Font readiness is `settle()` in the frame: it waits for every stylesheet (including one a widget swaps at runtime), forces layout, awaits `document.fonts.ready`, and loads every family in use (DOM text, canvas text, and the families of Google Fonts URLs), yielding through `MessageChannel` tasks instead of timers; its real-time deadline is kept in Node and ends in `FONT_SETTLE_TIMEOUT`. Stills settle between the replay and the screenshot; when canvas text was drawn before its face loaded, the clock advances one 16 ms frame at a time, at most three times, and the manifest records `fonts.redrawMs`. Video settles after each event and runs a light settle (stylesheets, layout, `fonts.ready`) before each frame. If a configured ready selector is created by a widget timer, the runner advances time in deterministic 16 ms quanta only after those assets are ready; it never advances according to real I/O speed. The system clock is then restored to the configured fixed instant. Stills keep CSS/Web Animations enabled: the replay advances the paused clock to `captureAtMs` in steps of at most 16 ms and samples the animations after each, as a browser frame would, so an animation a widget timer starts shows at its progress, at most one step behind its timer. Those steps cost about 4.5 s per minute of `captureAtMs` on a laptop (45 s at the 600,000 ms maximum). Motion frames advance the paused clock at exact timestamps. A field change in a tutorial video or a scenario reloads the widget by default (`widget.fieldUpdate`, see [Runtime](RUNTIME.md#bridge-sequence)): the new frame loads the same way, in real time, with the clock paused where the timeline is, and any 16 ms quanta its ready selector needs are counted in the timeline.

## Output plan and overwrite rules

The renderer calculates matrix cardinality before entering expansion loops. The default limit is 48 variants, enforced with integer-safe arithmetic; use `--allow-large-matrix` only after reviewing the reported count. It then rejects unsafe ids, duplicate filenames, crops outside the output canvas, an unsafe output root, symlinked output components, and any existing planned file without `--force`.

Before variants or frame paths are materialized, planning also counts total video frames and planned files. The default render-workload limit is 10,000 files, including numbered PNG frames and manifests. `RENDER_LIMIT_EXCEEDED` reports both totals. `--allow-large-render` is an explicit opt-in for a reviewed larger workload, but cannot bypass the safe-integer boundary. Dry runs enforce the same guard and report `totalFrames` and `totalTargets` in an accepted plan.

The file count says nothing about bytes, so planning also estimates them. `plan.estimate` lists, per variant, the frames, `frameBytes` (PNG frames plus `frames.json`), and `persistentBytes` (still, thumbnail, and encoded video), then the contact sheet, the manifest, `totalBytes`, `finalBytes`, and `peakBytes`. It is a conservative estimate, not a guaranteed upper bound: 1.2 bytes per output pixel for every PNG still and stage-mode frame (measured desktop-theme renders used 0.70; photographic backdrops converted to PNG measured 0.84–1.34), 0.3 bytes per pixel for tutorial-mode frames (a 28-second tutorial measured 0.076), 0.05 bytes per pixel per frame for encoded video (capped by a preset's `maximumBytes`), and 256 bytes per frame record. `plan.estimate.bytesPerPixel` shows the rates used (`png`, `frame`, `video`). `plan.estimate.discardFrames` is `true` only when a video is enabled, FFmpeg and ffprobe were both found, and frames are not kept; otherwise the peak is the total, so the same recipe can report a different peak on a machine without ffprobe. The pixel count is `crop ?? output`; captures use CSS scale, so the device scale factor does not multiply it. When frames are discarded after encoding (below), only one variant's frames exist at a time, so the peak is the final size plus the largest variant's frames; when they are kept, the peak is the total. `plan.targets` lists every file the render may write, including the temporary PNG frames and `frames.json`; the files that remain are the render's `artifacts` and the manifest.

The estimate covers only the files this render writes in the output root. It does not count the browser profile and cache, system swap (which on macOS shares the APFS container), or other processes, so a tight machine still needs a separate check of overall free space before a long render.

`plan.disk` compares that peak with the free space that `statfs` reports for the nearest existing ancestor of the output root. A render may use at most 70% of it. Above that, the render stops before creating any file with `OUTPUT_DISK_LOW`, which states the estimated peak, the free space, and the limit. A dry run reports the same figures in `plan.disk.summary` and marks `withinBudget: false` instead of failing. `--allow-low-disk` renders anyway after you review the estimate.

`--force` does not clear directories. Temporary files are created next to their final target as `.<name>.sws-<random>.tmp` and atomically renamed. Each render tracks the exact temporary paths it creates; when it fails with an error, it deletes those paths and no others (a process that is killed, for example with Ctrl-C, cannot clean up), so a temporary file from another process stays. Unrelated files remain untouched.

The renderer hashes production files, config, catalogs, adapter, and allowlisted assets before opening the browser, checks the snapshot before each variant and before the manifest, and aborts with `INPUT_CHANGED_DURING_RENDER` if an input changes. This prevents a long matrix from claiming one reproducible input state while using mixed bytes.

## Manifest

Every render writes a versioned `manifest.json` with:

- `studio`: name and version, the engine commit and whether it was built from uncommitted changes (`commit`, `dirty`, from `dist/build-info.json`), and for a CLI render the options given on the command line (`cliFlags`, such as `["--recipe", "stills", "--keep-frames", "--output", "<path>"]`; path values are recorded as `<path>`). Hosted jobs record the deployment's commit and no `cliFlags`. `doctor` warns when that build is dirty or older than its checkout.
- Relative production filenames and SHA-256 input hashes.
- Resolved recipe and marketplace preset.
- Browser path/version.
- FFmpeg/ffprobe detection and versions.
- Per-variant parameters, relative artifacts, frame-manifest hashes, and media hashes.
- For each video variant, `frameSequence` (the exact `frames.json` content: FPS, duration, dimensions, and every frame's timestamp and SHA-256) and `framesRetained`, which says whether the PNG frames and `frames.json` are still on disk. When they were discarded, `frames` is `null`, `files.framesManifest` is absent, and `hashes.framesManifest` still records the SHA-256 of the `frames.json` that was written.
- For a tutorial video that changes fields, `fieldUpdate`: the mode (`reload` or `event`) and, for each change, its `atMs` and `virtualMs`, the virtual time a reload's ready selector used. Frames after `atMs + virtualMs` keep exact timestamps; a frame inside that window shows the widget as it was when the reload finished.
- Per artifact, `fonts` (the still) and `videoFonts` (the video): each family with its status, the font warnings, and `redrawMs`, when there is anything to report. A hosted render adds a top-level `fonts` with the cache `epoch` and `userAgent`, what it `served`, `servedDigest`, and every `issue`; see [Google Fonts](RUNTIME.md#google-fonts).
- Per-artifact MIME type, byte count, actual image dimensions, and SHA-256.
- Deterministic seed, fixed time, locale, and timezone.
- Hashes for the adapter and every allowlisted local asset, including widget images, fonts, and media.
- `widget.sampleMediaHashes`: the SHA-256 of every built-in `sws-sample:` image that FIELDS defaults, channel, or any catalog uses, computed from the verified bytes the server serves. They join the input digest only when a sample is used, so digests of sample-free projects are unchanged.
- Contact sheet path, hash, byte count, MIME type, and dimensions when one is produced.
- Final, unvalidated, or intermediate status.

Absolute widget paths, tokens, cookies, and real user data do not belong in the manifest.

## Video

The source of every recording is a finite `frame-%04d.png` sequence and `frames.json` containing FPS, timestamps, dimensions, and hashes, written to `<recipe>/<variant>/frames/`.

After FFmpeg encodes a variant and ffprobe validates the video, the renderer deletes that variant's frames before starting the next one. It deletes only the files listed in that variant's `frames.json`, each checked to be a regular file directly in the frame folder, and then `frames.json` itself. It then removes the frame folder and the variant folder only if they are empty; any other file keeps them. Nothing is removed recursively. The frame list and hashes stay in the manifest. Frames are kept when:

- `outputs.video.keepFrames` is `true`, or `record`/`render` receive `--keep-frames`;
- FFmpeg is absent (status `intermediate`), because the PNG sequence is then the output;
- ffprobe is absent (status `unvalidated`), because the encode was not validated.

If encoding or validation fails (`FFMPEG_FAILED`, `FFPROBE_FAILED`, `VIDEO_FILE_TOO_LARGE`, `VIDEO_DURATION_INVALID`, `VIDEO_FRAME_COUNT_INVALID`, a timeout), that variant's frames and `frames.json` stay and no manifest is written; earlier variants' frames were already removed. Before the first frames of a run are removed, a `manifest.json` left by an earlier run (only possible with `--force`) is deleted, so a later failure never leaves a manifest that points at missing frames. When ffprobe reports a frame count (MP4 does; WebM usually does not), it must equal the number of frames in the sequence, so frames are only removed when the video holds all of them. If removing the frames fails after a validated encode (for example a permission error), the render still succeeds, keeps `framesRetained: true`, and records the error in the manifest entry's `framesDiscardError`.

Discarding is the default because frames dominate disk use: on 2026-09-25, the kept frames of 21 videos filled 9.7 GB and stopped a session with `ENOSPC`; on 2026-09-26, a 28-second full-HD tutorial left 132 MB of frames.

FFmpeg is discovered through an explicit path or the current `PATH`. It is invoked with an argument array and `shell: false`. H.264 MP4 uses `libx264`, `yuv420p`, no audio, and fast-start metadata by default. VP9 WebM is also supported. Both convert the PNG frames with the BT.709 matrix in limited range and tag the stream BT.709 (matrix, primaries, and transfer): browsers decode untagged video as BT.709, and FFmpeg's default conversion is BT.601, which showed pure green 39 levels off. ffprobe, when present, reads stream/container metadata before the temporary video is committed.

All 4:2:0 video outputs require even final width and height. This is checked during planning, before any PNG frame is written.

Set `outputs.video.mode` to `"tutorial"` to record the widget inside a StreamElements overlay editor replica, with a scripted cursor, chat, and emulated events; see [Tutorial videos](TUTORIAL.md).

When FFmpeg is absent, no download is attempted. The output status is `intermediate`; pass `--allow-intermediate` only when the PNG sequence is an acceptable deliverable.

If the volume fills up anyway (`ENOSPC` from a write, a screenshot, or FFmpeg), the render deletes its own temporary files and stops with `OUTPUT_DISK_FULL`. The message says which variant and step were running, how many of its frames were written, how many variants finished (their final files remain; their frames were already removed after a validated encode), that `manifest.json` was not written for this run (a manifest from an earlier run is left as it was unless frames were already discarded, in which case it was removed), how many temporary files were removed, where any partial frames remain, and the free space against the estimate. Free space (the partial frame folder can be deleted if its frames are not needed), then rerun with `--force`.

## Marketplace data

Marketplace requirements change independently of Studio releases. Profiles live in `presets/marketplaces/*.json` and include official source URLs plus `verifiedAt`. The core renderer records the selected profile but does not hard-code Etsy or another marketplace's limits.

Each preset may include a generic `validation` block. `validate` and recipe dry runs load the preset before any output is written and check matrix counts, formats, dimensions, opacity, duration, aspect ratio, audio, and declared file-size limits. `recipeDefaults` are published authoring defaults; they do not mutate an explicit recipe. A render manifest embeds the exact preset used.

The bundled Etsy profile was verified on 2026-08-05 and records the current maximum of 20 images and 2 videos. Etsy's dedicated video guide says 3–15 seconds while its listing guide says 5–15 seconds, so the operational profile uses the safer 5–15 second intersection. The official wording is “100 MB”; the preset records a decimal 100,000,000-byte interpretation explicitly. Recheck the linked official sources before a future listing campaign.
