# Tutorial videos

Set `outputs.video.mode` to `"tutorial"` to record a "how to configure" video. The widget runs inside a replica of the StreamElements overlay editor: the top toolbar, the Layers/Settings sidebar built from the widget's FIELDS, the dotted overlay canvas, and the bottom bar with **Emulate**. A scripted cursor clicks through it, an optional chat panel sends messages to the widget, and the Emulate menu dispatches alert events.

The editor chrome was measured from the live StreamElements editor on 2026-09-25 (Nunito Sans, navy `#020923` toolbar, `#5787dc` accents, Angular Material fields). It is a local simulation: nothing is sent to StreamElements, and the replica can drift from future editor changes. Fonts are never downloaded; if Nunito Sans is not installed locally, the system UI font is used.

```json
{
  "outputs": {
    "screenshots": false,
    "video": {
      "enabled": true,
      "mode": "tutorial",
      "durationMs": 28000,
      "fps": 30,
      "format": "mp4",
      "codec": "h264",
      "tutorial": {
        "overlayName": "Studio Chat overlay",
        "layerName": "Studio Chat",
        "widget": {"x": 960, "y": 540, "scale": 1.6},
        "steps": [
          {"action": "caption", "text": "Select the widget layer"},
          {"action": "selectLayer"},
          {"action": "setField", "field": "cardTitle", "value": "Community Chat"},
          {"action": "chat", "user": "Mira", "text": "Looks great!", "badges": ["subscriber"]},
          {"action": "emulate", "event": "tip", "option": "$10", "name": "Nova"},
          {"action": "save"}
        ]
      }
    }
  }
}
```

The bundled example is `examples/basic-chat/recipes/tutorial-setup.json` with the 1920×1080 scene `tutorial-editor`.

## Layout

- The scene `output` is the video size. The editor is laid out at `output.width / uiScale` CSS pixels and scaled up; the default `uiScale` makes the editor look like a 1440-pixel-wide browser window.
- The scene `viewport` is the widget's size in overlay pixels. `tutorial.widget` places its center (`x`, `y`) inside the overlay (`tutorial.overlay`, default 1920×1080) and sets `scale`. The scene camera and background are ignored in tutorial mode.
- The chat panel appears on the right when a `chat` step exists or the scene fixture contains `message` events. Set `chat.enabled` to force it on or off.
- `liveEmulation` only controls the "Preview LIVE on stream" checkbox drawn in the Emulate menu.
- Still screenshots from the same recipe keep the normal stage layout; only the video uses the editor.

## Steps

Steps run in order. Each one advances an internal clock, and the whole script must fit inside `durationMs` (validation and `--dry-run` report the required duration).

| Action | Effect |
| --- | --- |
| `wait` | Pause for `ms`. |
| `caption` | Show a centered caption; `null` hides it. Captions do not take time. |
| `selectLayer` | Click the layer, then the **Settings** section. |
| `openGroup` | Expand a FIELDS group (ungrouped fields are in `General`). |
| `setField` | Open the field's group if needed and edit it the way a person would: select and type text and numbers; open the color picker for `colorpicker` fields (see below); drag sliders; open dropdowns and pick an option; toggle checkboxes. The widget receives `onWidgetUpdate` when the edit is committed. |
| `chat` | Add a message to the chat panel and dispatch a StreamElements-shaped `message` event. With `typed: true`, the cursor types it into the chat box first. `badges` accepts `broadcaster`, `moderator`, `vip`, and `subscriber`; `data` merges extra fields into `event.data`. |
| `emulate` | Open **Emulate**, hover the category, pick the submenu `option`, and dispatch the matching event: `follower`, `subscriber` (`1`, `Gift`, `Community gift`), `tip` (`$10`, `$50`), `cheer` (`1k`, `5k`), `raid` (`10`, `50`), `redemption`, or `merch`. `name`, `amount`, and `message` adjust the payload; `listener` and `payload` replace it. |
| `move` / `click` | Move to, or click, `layer`, `save`, `preview`, `emulate`, `open-editor`, `chat-input`, `group:<name>`, `field:<id>`, or an `{x, y}` point in editor pixels. |
| `save` | Click **Save** and show the "Overlay saved" toast. |

Fixture events still run at their `atMs` times, and fixture chat messages also appear in the chat panel.

### Color picker

A `setField` on a `colorpicker` field uses the editor's color picker instead of typing. StreamElements draws these fields with md-color-picker 0.2.6, and the recording follows the same sequence a person uses:

1. The cursor clicks the round swatch next to the field. The picker dialog grows out of the swatch over a dimmed backdrop, with the current value selected in its header, and the cursor rests for half a second so viewers can read it.
2. The cursor drags the hue strip to the target hue. This step is skipped for grays and black, and when the hue already matches.
3. The cursor presses near the target in the saturation/brightness square and drags the marker onto it.
4. The cursor drags the alpha strip, but only when the opacity changes.
5. The header shows the requested value. The cursor moves onto **Select**, which turns hovered, and presses it. The dialog shrinks back into the swatch.

The header and the alpha strip follow every drag live. The field text, its swatch, and the widget change only when the dialog finishes closing, which is when StreamElements writes the value and fires `onWidgetUpdate`.

- **Accepted values.** `value` must be `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb(r, g, b)`, or `rgba(r, g, b, a)`. Anything else, including color names, fails compilation.
- **Exact result.** The committed value is exactly the string in the step, letter case and notation included. The real picker samples a 255-pixel grid and cannot reach every hex (`#ff7ad9` would land on a neighbor). The replica computes marker positions from the target's HSV values and settles on the exact string before **Select**.
- **Timing.** A color edit usually takes 4 to 5.5 seconds, and up to about 7 seconds when the alpha strip is dragged too. Budget `durationMs` for it.

**Fidelity notes.** The dialog layout, colors, and animation curves come from the editor's public bundle: md-color-picker 0.2.6, Angular Material 1.1.20, and the editor CSS. They were measured in a headless reproduction on 2026-09-26, not in a logged-in editor. The replica differs from the real editor in these ways:

- While dragging, the real editor hides the pointer. The replica shows a small crosshair with an open center, so viewers can follow the drag and still see the marker under it. The tutorial's click ripple is drawn as a ring during a drag for the same reason.
- Over **Select** the replica keeps the arrow pointer, as it does on every other button; the real editor shows a pointing hand.
- The backdrop dims the whole editor, chat panel included. Captions stay above the backdrop. A caption that would run under the dialog slides just below it (or above it, when only that fits) while the dialog is open; the dialog itself stays centered, as in the real editor.
- If the editor is shorter than the dialog, the dialog is scaled down so every picker target stays on screen.
- The header's HEX/RGB tab follows the notation of the requested value.

Every frame is drawn from the timeline at the frame timestamp: the host page has no CSS transitions, and the cursor, menus, typing, and caret are derived from the time alone. Each cursor move starts from the previous target as laid out at that frame, not from the last rendered frame, so a low frame rate shows the same cursor positions as 30 fps at the shared timestamps. In local checks on 2026-09-25, repeated renders matched frame for frame, except for one run in which a single frame differed; treat frame hashes as a strong reproducibility signal, not a guarantee.

The hosted Studio still limits videos to 15 seconds, so longer tutorials must be rendered with the local CLI.
