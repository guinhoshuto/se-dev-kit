# Known limits

What the Studio does not do yet, or does differently from StreamElements, and what to do instead. Each item names the evidence. Read this before planning marketing media; remove an item when its fix ships.

## Capture

- **`color-scheme: dark` on a transparent widget** shows on an opaque `#121212` box in screenshots, videos, and the tutorial replica (see the end of [catalog-authoring.md](catalog-authoring.md)). Do not work around it in the catalog; tell the user.
- **Runtime network.** Only Google Fonts load at runtime. A script the widget injects from a CDN (three.js, for example) does not load, so whatever depends on it breaks; stop before rendering marketing media and ask (see "Known gaps" in [studio-workflow.md](studio-workflow.md#known-gaps)).
- **Unproven font paths.** Canvas text (`fillText`) with a Google Font and a widget that reassigns the same stylesheet `href` have not been verified: look at the render before using it.

## Video

- **Store length.** An Etsy listing video lasts 5 to 15 seconds, at most 100 MB, between 2:1 and 1:2 (square included), and Etsy removes its audio (`presets/marketplaces/etsy-listing-2026-09.json`). The local Studio itself has no length cap: keep listing recipes within the preset, and set `marketplacePreset` so `validate` checks them.
- **Loops are never byte-identical.** Compositing leaves 1 to 4 levels of rounding between the first frame and its return; cut a loop at the first frame within 6/255 of frame 0 on all but 0.01% of the pixels (see [marketing-assets.md](marketing-assets.md#loops); `scripts/cut-loop.mjs` cuts a Studio job's MP4 within a mean of 1/255, or at a known period with `--period`).
- **Color.** Studio videos are converted with the BT.709 matrix and tagged BT.709 since 2026-09-29 (`a9904c8`); earlier ones are BT.601 without tags. A tool that re-encodes them lets FFmpeg read the tags instead of forcing `in_color_matrix`.
- **Frames are deleted.** Studio jobs never publish PNG frames, whatever `keepFrames` says. A poster or a mid-animation still of a stage video comes from `outputs.video.stills` (see [marketing-assets.md](marketing-assets.md#stills)), which jobs publish, and `scripts/cut-loop.mjs` cuts a loop from the MP4 itself.

## Machine

- **One render at a time.** Studio jobs and CLI renders wait for the machine-wide render slot (`~/.cache/render-slot`), and then for the machine check (the game, memory, a Remotion render from another tool): a CLI render before each recipe, a Studio job before it starts, 30 minutes at most for the slot and the check together.
- **Disk.** A 1080p PNG frame weighs 2 to 3 MB before encoding: 15 videos of 14 seconds peaked near 10 GB on 2026-09-26. Check the dry run's `plan.disk.summary` (CLI) or the estimate in [studio-workflow.md](studio-workflow.md#plan-a-large-batch) (Studio), and free space overall, before a batch.
- **Node 24.** Renders on Node 26 have hung while Chrome launched or closed; the CLI refuses it, and the local Studio runs on the Node that started it, so start it with Node 24.
