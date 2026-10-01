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

- A still in the middle of an animation comes from the video's frames, not from `captureAtMs`, when the animation is started by a timer (see [known-limits.md](known-limits.md#capture)).

## Loops

- Make the video last a whole number of the widget's cycles.
- Render with frames kept (local CLI, `--keep-frames`), then cut at the first frame that matches frame 0 within 6/255 on all but 0.01% of the pixels; it is never byte-identical.
- Encode the master from the kept frames (CRF 16 for H.264), with `setparams` for the BT.709 tags; `-color_primaries` alone on the encoder does not tag the stream. The se-windows repository's `studio/tools/cut_loop.py` implements this cut.

## Tutorial videos

- Keep a listing tutorial within the store's video length; [tutorial-video.md](tutorial-video.md) has the model recipe (`examples/basic-chat/recipes/listing-tutorial.json`).

## Review

- Review in two rounds: a measured visual review (contrast, clipping, font, letterbox, edge alpha), the catalog fixes, then an independent check of the fixed media. Report each defect with the file and what was measured.
- The owner approves listing media; an automated review does not.
