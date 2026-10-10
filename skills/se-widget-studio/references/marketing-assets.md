# Marketing assets

How to make store-listing media (cover images, field images, demo and tutorial videos) that survive review. These rules came from two QA rounds on the se-windows listing (2026-09-26), which found clipped shadows, a fallback font, letterboxing, and a 2.8:1 caption contrast that inspection by eye had missed. Read [known-limits.md](known-limits.md) first.

## Before rendering

- Start from the store's dated preset (`presets/marketplaces/`), set as the recipe's `marketplacePreset`, so `validate` checks size, length, and aspect. Etsy shows transparent pixels as black: listing images always get a backdrop.
- Use the Studio's `sws-sample:` backdrops and gallery images for test media (see [catalog-authoring.md](catalog-authoring.md#sample-media)).
- Render one variant first and look at it before a batch; estimate the batch's disk use (see [studio-workflow.md](studio-workflow.md#plan-a-large-batch)).

## Framing

- **Shadows.** Leave inside the viewport a margin at least as large as the element's offset plus its shadow's offset and blur (for a stacked card: the stack offset + `shadowY` + blur). A shadow that reaches the viewport edge is clipped in every output.
- **Transparent cutouts.** Render at camera scale 2 with an output of twice the viewport, so the viewport edge is the canvas edge. Check that the four edges are fully transparent (alpha 0): any opaque edge pixel means the cutout is clipped. The backdrop version reuses the same viewport and `fieldData`.
- **Cover stage.** A capture for a 16:9 cover stage is rendered 16:9; do not letterbox a square capture into it.
- **Fonts.** Look for the fallback font in every theme: a Google Font that did not load shows as the browser default, and the manifest's `fonts.issues` says why.

## Stills

- Take a still in the middle of an animation with `captureAtMs`, also when a widget timer starts the animation: the replay samples animations every 16 ms, as a browser frame does, so the still may trail the timer by up to 16 ms. A `captureAtMs` late in the timeline is slower, about 4.5 s per minute.

## Loops

- A listing cover video is one scene and one Studio job: start from the model recipe, `examples/basic-chat/recipes/listing-loop-video.json` (one 1920 × 1080 scene, a 15-second silent MP4, the Etsy maximum). Make one recipe per variant instead of one recipe for every variant: a job renders a single recipe, and six 15-second videos do not fit one.
- The widget must repeat on a timer (a gallery, a rotating card, an alert queue) with a rest after each change, and the video must end at rest: the last change has to settle before the 15 s end. A change that is still moving at the end is left out of the loop, and a video with fewer than two whole changes has none.
- Cut the job's MP4 with the skill's `scripts/cut-loop.mjs <video.mp4> [...]`: it writes `<video>-loop.mp4` and `<video>-loop.json` beside each input and never replaces either. It ends the loop where the last change settles and starts it a whole number of cycles earlier, inside the first rest, after checking that the two pictures match (mean luma difference at most 1/255); the line it prints gives the frames, the cycles, and the offset from the original (`original t = loop t + …`), which a poster time needs. It re-encodes the master (CRF 16, H.264) with `setparams` for the BT.709 tags; `-color_primaries` alone on the encoder does not tag the stream. `NO-LOOP` says why there is no cut: re-render longer or shorter, by whole cycles, within the store's limit. It needs `ffmpeg` and `ffprobe` on PATH.
- A widget that repeats exactly but not on even cycles (a chat that sends one message every 1–2 s on a 12 s cycle) comes out `NO-LOOP … uneven cycles`. Pass its period: `scripts/cut-loop.mjs --period 12000 <video.mp4>`. The loop still ends where the last change settles and starts one period earlier, where the picture must hold still for 8 frames; its first 8 frames blend from the original's continuation into that start, so the wrap is two consecutive frames of the original. The video must end with 8 still frames, the period must be a whole number of frames, and the start and end pictures must match within a mean of 4/255 (the same chat measured 0.85–1.7, another state 12 or more). Make the video one period plus the warm-up plus a rest, and let the widget's own timer keep the period exact.
- The `<video>-loop.json` record says what was cut: the `mode` (`cycles` or `period`), `loop.firstFrame` and `loop.originalOffsetMs` in the original, the frames and duration, how far apart the start and end pictures were (`match`), the encoder settings with the CRF (`encoding`), and both files' SHA-256. Keep it with the loop: it ties the master to the job's MP4 and its manifest.
- With the local CLI and `--keep-frames`, you can instead cut at the first frame that matches frame 0 within 6/255 on all but 0.01% of the pixels; it is never byte-identical.

## Tutorial videos

- Keep a listing tutorial within the store's video length; [tutorial-video.md](tutorial-video.md) has the model recipe (`examples/basic-chat/recipes/listing-tutorial.json`).

## Review

- Review in two rounds: a measured visual review (contrast, clipping, font, letterbox, edge alpha), the catalog fixes, then an independent check of the fixed media. Report each defect with the file and what was measured.
- The owner approves listing media; an automated review does not.
- Show the owner one page per widget: `se-widget-studio review <review-folder>/index.html <render-output>` (`--force` to rewrite it). Every image and video is under its review code (`LT-03`), the contact sheet cells too, and the owner quotes those codes; use the same codes in your report.
