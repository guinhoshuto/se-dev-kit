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
| `setField` | Open the field's group if needed and edit it the way a person would: select and type text, numbers, and colors; drag sliders; open dropdowns and pick an option; toggle checkboxes. The widget receives `onWidgetUpdate` when the edit is committed. |
| `chat` | Add a message to the chat panel and dispatch a StreamElements-shaped `message` event. With `typed: true`, the cursor types it into the chat box first. `badges` accepts `broadcaster`, `moderator`, `vip`, and `subscriber`; `data` merges extra fields into `event.data`. |
| `emulate` | Open **Emulate**, hover the category, pick the submenu `option`, and dispatch the matching event: `follower`, `subscriber` (`1`, `Gift`, `Community gift`), `tip` (`$10`, `$50`), `cheer` (`1k`, `5k`), `raid` (`10`, `50`), `redemption`, or `merch`. `name`, `amount`, and `message` adjust the payload; `listener` and `payload` replace it. |
| `move` / `click` | Move to, or click, `layer`, `save`, `preview`, `emulate`, `open-editor`, `chat-input`, `group:<name>`, `field:<id>`, or an `{x, y}` point in editor pixels. |
| `save` | Click **Save** and show the "Overlay saved" toast. |

Fixture events still run at their `atMs` times, and fixture chat messages also appear in the chat panel.

Every frame is drawn from the timeline at the frame timestamp: the host page has no CSS transitions, and the cursor, menus, typing, and caret are derived from the time alone. In local checks on 2026-09-25, repeated renders matched frame for frame, except for one run in which a single frame differed; treat frame hashes as a strong reproducibility signal, not a guarantee.

The hosted Studio still limits videos to 15 seconds, so longer tutorials must be rendered with the local CLI.
