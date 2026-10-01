# Known limits

What the Studio does not do yet, or does differently from StreamElements, and what to do instead. Each item names the evidence. Read this before planning marketing media; remove an item when its fix ships.

## Capture

- **Very short scenes hang.** A scene about 80 px tall makes the screenshot of the stage wait "for element to be stable" until its 30-second timeout, with or without fonts (found on 2026-09-27; the tests use 320×120). Give a thin widget, such as an alert bar, a scene at least 120 px tall and crop the output to the widget.
- **A still of a timer-driven animation comes out at rest.** `captureAtMs` does not sample a CSS animation that the widget starts from a timer; the still shows the resting state. Take the still from the video's frames instead: render with the local CLI and `--keep-frames` (the widget must need no Google Fonts), and pick the frame.
- **`color-scheme: dark` on a transparent widget** shows on an opaque `#121212` box in screenshots, videos, and the tutorial replica (see the end of [catalog-authoring.md](catalog-authoring.md)). Do not work around it in the catalog; tell the user.
- **Runtime network.** Only Google Fonts load at runtime. A script the widget injects from a CDN (three.js, for example) does not load, so whatever depends on it breaks; stop before rendering marketing media and ask (see "Known gaps" in [studio-workflow.md](studio-workflow.md#known-gaps)).
- **Unproven font paths.** Canvas text (`fillText`) with a Google Font and a widget that reassigns the same stylesheet `href` have not been verified: look at the render before using it.

## Video

- **Store length.** An Etsy listing video lasts 5 to 15 seconds, at most 100 MB, between 2:1 and 1:2 (square included), and Etsy removes its audio (`presets/marketplaces/etsy-listing-2026-09.json`). The local Studio itself has no length cap: keep listing recipes within the preset, and set `marketplacePreset` so `validate` checks them.
- **Loops are never byte-identical.** Compositing leaves 1 to 4 levels of rounding between the first frame and its return; cut a loop at the first frame within 6/255 of frame 0 on all but 0.01% of the pixels (see [marketing-assets.md](marketing-assets.md#loops)).
- **Color.** Studio videos are converted with the BT.709 matrix and tagged BT.709 since 2026-09-29 (`a9904c8`); earlier ones are BT.601 without tags. A tool that re-encodes them lets FFmpeg read the tags instead of forcing `in_color_matrix`.
- **Frames are deleted.** Studio jobs never publish PNG frames, whatever `keepFrames` says; frames for loop cuts, posters, or stills come from the local CLI with `--keep-frames`.

## Machine

- **One render at a time.** Studio jobs and CLI renders wait for the machine-wide render slot (`~/.cache/render-slot`); a render that does not take it, such as a Remotion render from another tool, is not covered: `npm run wait-free` in the Studio checkout waits for those too.
- **Disk.** A 1080p PNG frame weighs 2 to 3 MB before encoding: 15 videos of 14 seconds peaked near 10 GB on 2026-09-26. Check the dry run's `plan.disk.summary` (CLI) or the estimate in [studio-workflow.md](studio-workflow.md#plan-a-large-batch) (Studio), and free space overall, before a batch.
- **Node 24.** Renders on Node 26 have hung while Chrome launched or closed; the CLI refuses it, and the local Studio runs on the Node that started it, so start it with Node 24.
