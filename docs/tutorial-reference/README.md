# Tutorial editor reference

Measurements of the live StreamElements overlay editor that the tutorial replica (`src/server/tutorial-page.ts`, see [TUTORIAL.md](../TUTORIAL.md)) copies. They let a later session check the replica against the editor without measuring by trial and error, and tell when StreamElements changed its editor.

| File | What it is |
|---|---|
| `2026-09-25-recovered.json` | The measurements behind the replica, recovered from the DOM reads of the 2026-09-25 session. They were taken on a sold overlay, before the rule of measuring on a test overlay only; some answers were cut short, and their lost values are `null`. The viewport height (756) is inferred from the sidebar's bottom edge. |
| `2026-10-07-layers.json`, `2026-10-07-settings.json` | A re-measurement on the test overlay, with "Preview LIVE on stream" off and nothing saved, on an unsaved Custom widget layer with StreamElements' default code and fields. The window was 1864x1033, not 1440x756. |

## 2026-10-07 against the reference

Nothing the replica copies changed: every color, font, font size, weight, letter spacing, border, and radius matches, and so do the toolbar's height, the buttons' sizes, the sidebar's width, the section headers, the layer row, and the Open editor button. Every difference comes from the window size or from the widget, which is not the sold one:

- Window size: the toolbar is as wide as the window (1864), the Preview and Save buttons keep their distance from the right edge (x + 424, the width difference), the sidebar and canvas are taller, and the stage scale is 0.798 instead of 0.577.
- Widget: the default Custom widget has other fields. Its sliders are wider (298) and lower, its color picker sits further down, the first field at (60, 270) is a number input instead of a dropdown (`INPUT`, not `MD-SELECT-VALUE`), its field rows are taller (96), and it has no visible checkbox (the probe reads a hidden checked one, so its box is 0 and its colors are the checked colors). The group header is 320 wide, not 312, while the Layers section is open (no scrollbar).

`REFERENCE` in the unit test stays on the 2026-09-25 file, which has the 1440x756 point probes.

`tests/unit/tutorial-reference.test.mjs` fails when the replica's toolbar, sidebar, buttons, colors, or checkerboard drift from the reference file it names (`REFERENCE`).

## The editor's public bundle

The overlay editor's code is public: the editor page loads one script and one stylesheet (`/overlay/assets/index-<hash>.js` and `.css`), and its English strings are in `https://streamelements.com/assets/dashboard/i18n/en.json`. They answer questions that measuring the page cannot, without a logged-in session: the AngularJS templates of each field type (search the script for `ng-if="option.type === 'button'"`), what a control does when clicked (a controller such as `triggerEvent`), dialog sizes and animations in the CSS, and the exact button labels ("Set image", "Change image"). The button field, the media fields, and the asset manager of the replica were read from it on 2026-10-05.

It is third-party code: read it for behavior, sizes, and strings, keep the files outside git, and never copy its code or markup into the repository. What the bundle says a control sends is confirmed once on a test overlay before the replica relies on it. The button event in [RUNTIME.md](../RUNTIME.md#button-fields) was, by wrapping `HTMLIFrameElement.prototype.contentWindow` in the editor page to log what it posts to the widget, then restoring it.

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
