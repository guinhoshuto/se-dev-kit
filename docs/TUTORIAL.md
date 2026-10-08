# Tutorial videos

Set `outputs.video.mode` to `"tutorial"` to record a "how to configure" video. The widget runs inside a replica of the StreamElements overlay editor: the top toolbar, the Layers/Settings sidebar built from the widget's FIELDS, the dotted overlay canvas, and the bottom bar with **Emulate**. A scripted cursor clicks through it, an optional chat panel sends messages to the widget, and the Emulate menu dispatches alert events.

The editor chrome was measured from the live StreamElements editor on 2026-09-25 (Nunito Sans, navy `#020923` toolbar, `#5787dc` accents, Angular Material fields). It is a local simulation: nothing is sent to StreamElements, and the replica can drift from future editor changes. The measurements, and a read-only script to take them again on a test overlay, are in [tutorial-reference/](tutorial-reference/README.md); a unit test keeps the replica's chrome on them. The editor's Nunito Sans and the chat's Inter ship with the Studio under the SIL Open Font License (`src/studio-ui/fonts/`, Latin and Latin Extended), and every face loads before the first frame, so every machine and Sandbox draws the same glyphs; nothing is downloaded at runtime. Other scripts fall back to the system font.

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
- The scene `viewport` is the widget's size in overlay pixels. `tutorial.widget` places its center (`x`, `y`) inside the overlay (`tutorial.overlay`, default 1920×1080) and sets `scale`. The scene camera and background are ignored in tutorial mode; `tutorial.autoZoom` is the tutorial's own camera (see [Auto zoom and click pulse](#auto-zoom-and-click-pulse)).
- The chat panel appears on the right when a `chat` step exists or the scene fixture contains `message` events. Set `chat.enabled` to force it on or off.
- `liveEmulation` only controls the "Preview LIVE on stream" checkbox drawn in the Emulate menu.
- Screenshots from the same recipe (`outputs.screenshots`) keep the normal stage layout; only the video uses the editor. A still of the editor comes from a `still` step (see [Stills](#stills)).

## Steps

Steps run in order. Each one advances an internal clock, and the whole script must fit inside `durationMs` (validation and `--dry-run` report the required duration).

| Action | Effect |
| --- | --- |
| `wait` | Pause for `ms`. |
| `caption` | Show a centered caption; `null` hides it. Captions do not take time. |
| `still` | Save a PNG of the editor at this point of the script as `<variant>-still-<name>.png`, as the video shows it or, with `camera: "full"`, the whole editor without the pointer (see [Stills](#stills)). Stills do not take time. |
| `selectLayer` | Click the layer, then the **Settings** section. |
| `openGroup` | Expand a FIELDS group (ungrouped fields are in `General`). |
| `setField` | Open the field's group if needed and edit it the way a person would: select and type text and numbers; open the color picker for `colorpicker` fields (see below); set image, video, and sound fields from the asset manager (see [Media fields](#media-fields)); drag sliders; open dropdowns and pick an option; toggle checkboxes. When the edit is committed, the widget reloads with the new value, as in StreamElements (`widget.fieldUpdate: "reload"`, the default), or receives `onWidgetUpdate` with `"event"`. |
| `pressButton` | Open the field's group if needed and press a `button` field, which sends the widget the event StreamElements sends (see [Buttons](#buttons)). |
| `chat` | Add a message to the chat panel and dispatch a StreamElements-shaped `message` event. With `typed: true`, the cursor types it into the chat box first. `badges` accepts `broadcaster`, `moderator`, `vip`, and `subscriber`; `data` merges extra fields into `event.data`. |
| `emulate` | Open **Emulate**, hover the category, pick the submenu `option`, and dispatch the matching event: `follower`, `subscriber` (`1`, `Gift`, `Community gift`), `tip` (`$10`, `$50`), `cheer` (`1k`, `5k`), `raid` (`10`, `50`), `redemption`, or `merch`. `name`, `amount`, and `message` adjust the payload; `listener` and `payload` replace it. |
| `move` / `click` | Move to, or click, `layer`, `save`, `preview`, `emulate`, `open-editor`, `chat-input`, `group:<name>`, `field:<id>`, or an `{x, y}` point in editor pixels. |
| `save` | Click **Save** and show the "Overlay saved" toast. |

Fixture events still run at their `atMs` times, and fixture chat messages also appear in the chat panel.

### Stills

A `still` step (`{"action": "still", "name": "colors-open", "camera": "full"}`) keeps the editor at one instant of the video as a PNG, for a listing image of the editor with a group open. It changes nothing in the video: the step takes no time, and the instant is the first video frame at or after the step's time (the last frame when the video ends first), at the video's size and crop. Put a `wait` before it so an opening group or menu has settled.

- **`camera: "video"`** (the default). The PNG is a byte copy of that frame, with the camera, pointer, and captions as the video shows them; with auto zoom that is often a close-up.
- **`camera: "full"`**. The same instant is drawn again with the camera on the whole editor (or the whole crop) and without the pointer and click ripple, then screenshotted; captions, menus, and the widget stay as they are at that instant. The next frame draws the video again, so the video is the same with or without it.

- **Name.** `name` is lowercase letters, numbers, and single hyphens, unique within the script; the file is `<variant>-still-<name>.png` next to the video. A malformed name fails `validate`; a repeated one fails `--dry-run` and the render, before any file is written.
- **Kept.** Stills stay when the frames are deleted after the encode, and Studio jobs publish them with the video. Like every planned target, an existing still needs `--force`.
- **Manifest.** The variant's entry lists them under `stills`: `name`, `camera`, the step's `atMs`, the `frame` it shows and its `timestampMs`, and the `file` with its size and SHA-256. For a `video` still that hash equals the frame's hash in `frameSequence`.
- **Disk.** The estimate counts each still as one tutorial frame, kept in the final size.

The listing example `examples/basic-chat/recipes/listing-tutorial.json` keeps `colors-open`, the whole editor with the Colors group open.

The sidebar has no scrollbar, and like the real one it stays where it was left. When the cursor heads for a group header or a field row outside it (a long open group pushes the next ones below the editor), the sidebar scrolls just enough, eased over the first 450 ms of the move, to show it with a 24 px margin, which keeps a field's label in view too. A target already in view does not scroll it, so scripts take the same time either way. When an open group closes and the content gets shorter, the browser clamps the scroll, as the real editor does. A select menu opens over its field wherever the scroll left it, and stays 8 px inside the editor, as md-select does.

### Color picker

A `setField` on a `colorpicker` field uses the editor's color picker instead of typing. StreamElements draws these fields with md-color-picker 0.2.6, and the recording follows the same sequence a person uses:

1. The cursor clicks the round swatch next to the field. The picker dialog grows out of the swatch over a dimmed backdrop, with the current value selected in its header, and the cursor rests for half a second so viewers can read it.
2. The cursor drags the hue strip to the target hue. This step is skipped for grays and black, and when the hue already matches.
3. The cursor presses near the target in the saturation/brightness square and drags the marker onto it.
4. The cursor drags the alpha strip, but only when the opacity changes.
5. The header shows the requested value. The cursor moves onto **Select**, which turns hovered, and presses it. The dialog shrinks back into the swatch.

The header and the alpha strip follow every drag live. The field text, its swatch, and the widget change only when the dialog finishes closing, which is when StreamElements writes the value and reloads the widget.

- **Accepted values.** `value` must be `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb(r, g, b)`, or `rgba(r, g, b, a)`. Anything else, including color names, fails compilation.
- **Exact result.** The committed value is exactly the string in the step, letter case and notation included. The real picker samples a 255-pixel grid and cannot reach every hex (`#ff7ad9` would land on a neighbor). The replica computes marker positions from the target's HSV values and settles on the exact string before **Select**.
- **Timing.** A color edit usually takes 4 to 5.5 seconds, and up to about 7 seconds when the alpha strip is dragged too. Budget `durationMs` for it.

**Fidelity notes.** The dialog layout, colors, and animation curves come from the editor's public bundle: md-color-picker 0.2.6, Angular Material 1.1.20, and the editor CSS. They were measured in a headless reproduction on 2026-09-26, not in a logged-in editor. The replica differs from the real editor in these ways:

- While dragging, the real editor hides the pointer. The replica shows a small crosshair with an open center, so viewers can follow the drag and still see the marker under it. The tutorial's click ripple is drawn as a ring during a drag for the same reason.
- Over **Select** the replica keeps the arrow pointer, as it does on every other button; the real editor shows a pointing hand.
- The backdrop dims the whole editor, chat panel included. Captions stay above the backdrop. A caption that would run under the dialog slides just below it (or above it, when only that fits) while the dialog is open. When neither fits (a very wide or short editor, or a long caption), the caption fades out while the dialog is open and back in after it closes. The dialog itself stays centered, as in the real editor.
- If the editor is shorter than the dialog, the dialog is scaled down so every picker target stays on screen.
- The header's HEX/RGB tab follows the notation of the requested value.

### Media fields

A single `image-input`, `video-input`, or `sound-input` field looks as it does in StreamElements: its label, a preview with a clear button once a value is set, and a **Set image** / **Change image** button (**Set video** / **Change video**, **Upload Sound**). There is no text input: StreamElements never lets a person type a media value. A `setField` on one:

1. The cursor clicks the Set/Change button. The asset manager grows out of it over a dimmed backdrop, on the page of the field's type (Images, Videos, or Sounds).
2. The cursor hovers the asset, the first tile of the grid. Its name fades out and its **Submit** and **Delete** buttons fade in.
3. The cursor presses **Submit**. The dialog shrinks back into the button, and when it is gone the preview shows the new value and the widget reloads.

The grid lists the value being set first, then the widget's own value that was there, then the Studio's built-in samples of the field's type (`sws-sample:` images for image fields, clips for video fields; sound fields have none). An empty `value` presses the preview's clear button instead and opens no dialog. A media edit takes about 3 seconds. A field with `multiple: true` (a list of media) cannot be set by a tutorial: set its value in the scene's `fieldData`, and the replica shows its tiles.

**Fidelity notes.** The dialog follows the editor's public bundle as read on 2026-10-05 (`md-dialog.asset-dialog`, 71.5% of the window wide and at most 80% tall, a 5-column grid of square tiles with the name bar on top, the pagination footer), not a logged-in measurement. Image samples are drawn in the previews and tiles. A video shows a dark tile with a camera icon and a sound a music note, where the editor plays a preview, because the replica's frames must not depend on playback. The storage line in the nav bar is a fixed placeholder.

### Buttons

A `button` field is drawn as the editor's raised blue button with the field label on it. `pressButton` clicks it and, at the click, dispatches what StreamElements dispatches: `listener` `"event:test"`, with `event` `{field, value, listener: "widget-button"}`, where `value` is the field's value (see [Button fields](RUNTIME.md#button-fields)). A button with `openUrl` opens that page in StreamElements and sends no event, so `pressButton` refuses it, as it refuses a field that is not a button. A `setField` on a button fails with a hint to use `pressButton`.

## Auto zoom and click pulse

Tutorial videos use a camera in the style of [Screen Studio](https://screen.studio)'s auto zoom: it follows the cursor in a close-up while it works, and pulls back so viewers see what changed. It is on by default at 1.8×.

| Beat | What viewers see |
| --- | --- |
| Close-up | The camera zooms to `autoZoom.zoom` around the cursor. A zoom-in starts 150 ms after the cursor starts moving, is mostly done at the click, and has landed 500 ms after it. |
| Camera moves | Every move takes one second on one smooth, critically damped curve: it starts gently and never bounces or overshoots. |
| Following the cursor | While zoomed, the camera stays still as long as the next target is inside the middle 70% of the frame. Otherwise it pans at the same zoom, starting ahead of the cursor, landing 100 ms before the click, and centering on the target. A jump too far for the close-up zooms out just enough, then settles back in if the cursor rests there. |
| Popups | The color picker, the Emulate menu with its submenu, and dropdown lists are fully in view from 200 ms before they open until 200 ms after they close, at 1.6× or less. |
| Widget reactions | One second before each widget update (a field commit, a chat message, an emulated event), the camera starts pulling back. The widget and what caused it (the field, the new chat line, the Emulate button) stay fully in view for 1.2 s, or at least 0.6 s when the next shot comes sooner, at 1.5× or less. |
| Typing | The field or chat box being typed into stays in view. |
| Save | The camera returns to the full editor right after **Save**, so the "Overlay saved" toast is in view. |
| Inactivity | After 1.5 s without activity, the camera returns to the full editor. |
| Start and end | The video starts on the full editor, and ends on it when the script leaves time for it. A planned framing below 1.15× becomes the full editor. |
| Pointer | Inside the frame whenever it is on the stage (or inside the crop). It scales with the zoom, as the recorded pointer does in Screen Studio. The sidebar scrolls a group header or field below or above it into view before the pointer gets there, so sidebar targets are always on the stage. A move whose target is off the frame both before and after the click (a crop that leaves the target out) does not move the camera, so it never zooms in on the frame's edge. |

Set it in the tutorial script, next to `steps`:

```json
{
  "tutorial": {
    "autoZoom": {"zoom": 1.5},
    "steps": [{"action": "selectLayer"}]
  }
}
```

`autoZoom` accepts `true` (the default), `false` (the full editor throughout, as before), or `{"zoom": z}` with `z` from 1.2 to 2.5. The camera adds no time: `durationMs` and `--dry-run` are unchanged.

- Popups and the reacting widget are always fully in view. Only steps move the camera: fixture events never do, because a fixture with one message per second would pin it wide.
- With a scene `crop`, the camera frames the crop, because that is what the video exports: the full view is the crop, the camera zooms and pans inside it, and the guarantees above hold for the part of the editor inside the crop. Targets outside the crop stay outside the video, as without the camera.
- Dense scripts sit at 1.2× to 1.5× more of the time, because widget reactions win over close-ups. Lower `zoom` or turn the camera off when that matters.
- Captions sit above the camera and are never scaled by it. They slide (200 ms) above or below open popups, the reacting widget, and typed text, and they stay on screen. When a popup leaves no room above or below it, the caption fades out over 200 ms where it would cover the popup and fades back in after the popup closes, so the popup always stays whole. This also holds with `autoZoom: false`, where captions are now drawn above menus and the toast instead of under them.
- The pointer pulses on every click: it shrinks to 80% in 70 ms and springs back with a small overshoot, at rest 450 ms after the release. During slider and color picker drags it stays pressed until the drag ends. The click ripple fades in over 60 ms and eases out over 520 ms. The pulse and the ripple are always on.

**Fidelity note.** The camera, the pointer pulse, and the ripple are SE Widget Studio effects in the style of Screen Studio. The StreamElements editor has none of them, and the widget itself renders exactly as it does without them.

**Sharpness note.** A widget that draws to a `<canvas>` can look soft when zoomed; reveals stay at 1.5× or less.

## Rendering

Every frame is drawn from the timeline at the frame timestamp: the host page has no CSS transitions, and the cursor, menus, typing, and caret are derived from the time alone. `setup()` measures the editor once and plans the camera from the timeline and those measurements. Each frame's camera, cursor, and caption are then functions of the frame time: a cursor move starts from the previous target as laid out at that frame, a target that is gone falls back to where setup measured it, and nothing is carried over from the last rendered frame. A direct seek therefore places the camera, cursor, and caption exactly where a sequential render does, and so does a low frame rate at the timestamps it shares with 30 fps. The pixels are identical from run to run too, because every Chrome the Studio starts rasterizes in software (`--disable-gpu`, see [Capture](CAPTURE.md#deterministic-browser-context)). With the GPU, three renders of the example `tutorial-setup` on an idle machine differed pairwise in 35 to 124 of their 945 frame hashes (2026-10-04), by one level on edges and text; in software, four renders on 2026-10-05, one of them while a game was open, gave the same 945 frame hashes and the same MP4. A frame hash that differs therefore means that frame changed, on the same machine and Chrome version; another Chrome version or CPU may raster differently. The hashes stay in the render manifest (`frameSequence`) after the frames themselves are deleted, and identify the exact frames encoded into that video.

### Iterating on a script

Two `render` options make a script cheaper to adjust than a full render per attempt:

- `--plan-only` opens Chrome once per recipe, runs only `setup()` for each variant, and prints what it measured and the camera plan it made: the timeline's `endMs`, then each camera key with its time, kind, zoom, and view origin. With `--json` it prints the whole record, `tutorialPlan` per variant: `layout` (the pointer's home, the resolved sidebar scrolls, every move with its measured anchors, the cues with their rectangles, the caption heights) and `camera` (keys, holds, caption obstacles, repaired moves, and whether it fell back to strict moves). It draws no frame and writes no file, takes the render slot like a render, and fails with `PLAN_ONLY_NEEDS_TUTORIAL` for a recipe without a tutorial video. On the example `listing-tutorial` it answered in about 3 seconds (2026-10-07).
- `--fps <count>` and `--duration <ms>` replace `outputs.video.fps` and `durationMs` for one run, for example `--fps 5` for a quick look at the motion. The replaced recipe is validated like a recipe file (`VIDEO_OVERRIDE_INVALID`), must still meet its marketplace preset, and is what the manifest records under `recipe`, next to the flags in `studio.cliFlags`. Because every frame is a function of its time, a 5 fps render shows the same instants a 30 fps one shows at those timestamps.

A full render records the same `tutorialPlan` in each tutorial artifact of the manifest, so the plan behind a delivered video can be compared with a later `--plan-only`.

The hosted Studio still limits videos to 15 seconds, so longer tutorials must be rendered with the local CLI.

The disk estimate counts tutorial frames at 0.3 bytes per pixel (tutorial frames measured about 0.076), so a 28-second full-HD tutorial estimates a peak of about 590 MiB and needs about 840 MiB free. On a tight disk it may still stop with `OUTPUT_DISK_LOW`; review `plan.disk.summary` from `--dry-run`, then free space or pass `--allow-low-disk`.
