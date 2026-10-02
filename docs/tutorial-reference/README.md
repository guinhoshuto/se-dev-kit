# Tutorial editor reference

Measurements of the live StreamElements overlay editor that the tutorial replica (`src/server/tutorial-page.ts`, see [TUTORIAL.md](../TUTORIAL.md)) copies. They let a later session check the replica against the editor without measuring by trial and error, and tell when StreamElements changed its editor.

| File | What it is |
|---|---|
| `2026-09-25-recovered.json` | The measurements behind the replica, recovered from the DOM reads of the 2026-09-25 session. They were taken on a sold overlay, before the rule of measuring on a test overlay only; some answers were cut short, and their lost values are `null`. The viewport height (756) is inferred from the sidebar's bottom edge. |

`tests/unit/tutorial-reference.test.mjs` fails when the replica's toolbar, sidebar, buttons, colors, or checkerboard drift from the reference file it names (`REFERENCE`).

## Measure again

[`scripts/measure-se-editor.js`](../../scripts/measure-se-editor.js) reads computed styles and layout boxes, and never clicks, types, or dispatches events. It refuses any page that is not the editor of the overlay id it is given.

1. Use a test overlay only, never one that is sold or on stream. In the editor, leave "Preview LIVE on stream" unchecked; the script does not open Emulate.
2. Open the editor in a 1440x756 window, the viewport of these measurements. The point probes read what is drawn at fixed points, so another size still runs but compares only by selector.
3. Take two reads, one per view: `layers` with the Layers section open and the widget layer listed, and `settings` after you select the layer and open Settings. In the DevTools console, or an agent's page-script tool:

   ```js
   globalThis.SE_MEASURE = {testOverlayId: "<24-hex test overlay id>", view: "layers"};
   // then paste scripts/measure-se-editor.js; it evaluates to the JSON
   ```

4. Save each result as `docs/tutorial-reference/<date>-<view>.json` and compare it with the reference: `git diff --no-index docs/tutorial-reference/2026-09-25-recovered.json docs/tutorial-reference/<date>-layers.json`. The output leaves out the overlay id and the query string.

A difference is a change in the editor, not in the replica. Update the replica, point `REFERENCE` in the unit test at the new file, and update the "measured on" date in `TUTORIAL.md` together.
