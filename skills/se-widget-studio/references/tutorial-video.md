# Tutorial videos

A tutorial video shows a buyer how to set up the widget. The widget runs inside a replica of the StreamElements overlay editor: the top toolbar, the Layers/Settings sidebar built from the widget's FIELDS, the overlay canvas, and the bottom bar with **Emulate**. A scripted cursor clicks through it, an optional chat panel sends messages to the widget, and the Emulate menu dispatches alert events.

The replica was measured from the live editor on 2026-09-25 and can drift from later editor changes. Its reference measurements and the read-only script that measures the editor again are in the Studio repository's `docs/tutorial-reference/`; measure on a test overlay only, never one that is sold or on stream. It is a Studio simulation, and nothing reaches StreamElements: report it as such, never as a recording of StreamElements.

## Recipe

Set `"mode": "tutorial"` on a recipe's video and write the script in `outputs.video.tutorial`:

```json
{
  "schemaVersion": 1,
  "id": "setup-tutorial",
  "name": "Setup tutorial",
  "scenes": ["tutorial-editor"],
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

This is the Studio's bundled example, and it runs 28 seconds.

- **Local Studio (the default).** Submit it with `run --kind render --selection <recipe-id>`; `video:<scene-id>` has no tutorial mode. A tutorial has no length cap there; plan its disk use as [studio-workflow.md](studio-workflow.md#plan-a-large-batch) describes.
- **For a store listing**, keep the tutorial within the store's video length (15 seconds on Etsy, see [known-limits.md](known-limits.md)): show fewer field groups rather than speeding up the moves, or split a longer walkthrough into several tutorial recipes, each starting with `selectLayer`. The Studio's `examples/basic-chat/recipes/listing-tutorial.json` is the model: each group opened, held for a second, and closed, then one chat message, in 14 of its 15 seconds, with the dated Etsy preset. Its `still` step (`camera: "full"`) keeps the whole editor with Colors open as a listing image (the panels slot of the thumbnail generator); put a `wait` before a still so the group has settled. The render manifest lists the stills under `stills`.
- **The paused hosted deployment** limits a video variant to 15 seconds at up to 30 fps.

## Layout

- The scene `output` is the video size; the bundled example uses a 1920x1080 scene. The editor is laid out at `output.width / tutorial.uiScale` CSS pixels and scaled up; the default `uiScale` looks like a 1440-pixel-wide browser window.
- The scene `viewport` is the widget's size in overlay pixels. `tutorial.widget` places its center (`x`, `y`) in the overlay (`tutorial.overlay`, 1920x1080 by default) and sets its `scale`. The scene camera and background are ignored: `tutorial.autoZoom` is the tutorial's camera.
- The chat panel appears on the right when a `chat` step exists or the scene fixture has `message` events; `tutorial.chat.enabled` forces it on or off. `tutorial.liveEmulation` only draws the "Preview LIVE on stream" checkbox in the Emulate menu.
- Screenshots from the same recipe keep the normal stage; only the video uses the editor.

## Steps

Steps run in order, and each one advances the tutorial clock.

| Action | Effect |
|---|---|
| `wait` | Pause for `ms`. |
| `caption` | Show a centered caption `text`; `null` hides it. Captions take no time. |
| `still` | Keep the editor at this point as `<variant>-still-<name>.png` (`name`: lowercase letters, numbers, and hyphens, unique). It takes no time and changes nothing in the video, and the PNG stays when the frames are deleted. By default it is a byte copy of the first frame at or after the step, camera zoom and pointer included; `camera: "full"` draws that instant with the whole editor and no pointer, the usual choice for a listing image. |
| `selectLayer` | Click the layer, then the **Settings** section. |
| `openGroup` | Expand a FIELDS group (ungrouped fields are in `General`). |
| `setField` | Set `field` to `value` as a person would: select and type text and numbers, drag sliders, open dropdowns and pick an option, toggle checkboxes, use the color picker for `colorpicker` fields, and pick the asset in the asset manager for single image, video, and sound fields (`""` presses the preview's clear button). The widget reloads when the edit is committed. |
| `pressButton` | Press the `button` field `field`: the widget receives `onEventReceived` with `detail.listener === "event:test"` and `detail.event` `{field, value, listener: "widget-button"}`, as in StreamElements. A button with `openUrl` is refused (StreamElements opens the page and sends no event). |
| `chat` | Add a message (`user`, `text`) to the chat panel and dispatch a StreamElements `message` event. `typed: true` types it into the chat box first; `badges` accepts `broadcaster`, `moderator`, `vip`, and `subscriber`; `data` merges extra fields into `event.data`. |
| `emulate` | Open **Emulate**, pick the submenu `option`, and dispatch `event`: `follower`, `subscriber` (`1`, `Gift`, `Community gift`), `tip` (`$10`, `$50`), `cheer` (`1k`, `5k`), `raid` (`10`, `50`), `redemption`, or `merch`. `name`, `amount`, and `message` adjust the payload; `listener` and `payload` replace it. |
| `move` / `click` | Move to, or click, a `target`: `layer`, `save`, `preview`, `emulate`, `open-editor`, `chat-input`, `group:<name>`, `field:<id>`, or an `{x, y}` point in editor pixels. |
| `save` | Click **Save** and show the "Overlay saved" toast. |

- A `setField` reloads the widget as StreamElements does, so whatever it built before, such as chat lines, is gone: change fields first, then chat and emulate (see [Field changes](catalog-authoring.md#field-changes)).
- A color `value` must be `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb(r, g, b)`, or `rgba(r, g, b, a)`; a color name fails. The committed value is exactly that string. A color edit takes 4 to 5.5 seconds, and up to about 7 when the opacity changes.
- A media `setField` takes about 3 seconds and lists the value first, then the built-in samples of the field's type. A `multiple: true` media field cannot be set by a step: put its value in the scene's `fieldData`.
- Fixture events still run at their `atMs`, and fixture chat messages also appear in the chat panel.
- The sidebar scrolls a group or field into view before the cursor reaches it, so scripts need no scroll steps.

## Duration

- The whole script must fit `durationMs`. One that does not fails with `TUTORIAL_TOO_LONG`, whose hint names the smallest `durationMs` that fits. The local CLI's `validate` and `render --dry-run` report it without rendering; the client has no dry run, so leave margin.
- The camera adds no time. For the disk check, tutorial frames count 0.3 bytes per output pixel (see "Plan a large batch" in [studio-workflow.md](studio-workflow.md#plan-a-large-batch)).

## Auto zoom

- On by default at 1.8x, in the style of Screen Studio: the camera follows the cursor in a close-up and pulls back so that the widget and what caused each reaction (a field commit, a chat line, an emulated event) stay in view. Popups (the color picker, the Emulate menu, dropdowns) are always fully in view. It returns to the full editor after **Save** and after 1.5 seconds without activity.
- `tutorial.autoZoom` takes `true` (the default), `false` (the full editor throughout), or `{"zoom": z}` with `z` from 1.2 to 2.5.
- With a scene `crop`, the camera works inside the crop, which is what the video exports.
- Dense scripts stay at 1.2x to 1.5x most of the time, because widget reactions win over close-ups. A widget drawn on a `<canvas>` can look soft when zoomed: lower `zoom` or turn the camera off.
- The camera, the pointer pulse, and the click ripple are Studio effects. The StreamElements editor has none of them, and the widget renders exactly as it does without them.

## Fidelity

- The editor's Nunito Sans and the chat's Inter ship with the Studio, so every machine and Sandbox draws the same glyphs. The widget's Google Fonts load as in any job (see "Fonts" in [studio-workflow.md](studio-workflow.md#fonts)).
- While a color is dragged, the replica shows a small crosshair where the real editor hides the pointer, and the picker's backdrop also dims the chat panel.
- A transparent widget that declares `color-scheme: dark` shows on an opaque `#121212` box in the replica (see the end of [catalog-authoring.md](catalog-authoring.md)).
- Repeated renders on the same machine are pixel-identical: the Studio's Chrome rasterizes in software. Two renders of the same tutorial give the same frame hashes in the render manifest (`frameSequence`) and the same MP4, so a frame whose hash differs did change. Renders from before 2026-10-05, or from another machine or Chrome version, can differ by one level on edges without any visible change; compare those by looking at them. The manifest also records each field change under `fieldUpdate`.

Changing the tutorial engine itself is Studio development (local mode); its full specification is `docs/TUTORIAL.md` in the Studio repository.
