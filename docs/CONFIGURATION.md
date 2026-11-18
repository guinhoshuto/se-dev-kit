# Configuration

Configuration uses a strict, versioned `se-widget-studio.config.mjs`. Unknown top-level keys fail early to expose typos. The consumer's production files remain independent of the Studio.

Object-form StreamElements dropdown options map stored values to labels:

```json
{
  "type": "dropdown",
  "value": "compact",
  "options": {
    "comfortable": "Comfortable",
    "compact": "Compact"
  }
}
```

This follows the official [StreamElements widget fields contract](https://docs.streamelements.com/overlays/widget-structure), checked 2026-08-05. Array-form options are also normalized for local portability.

## Themes

A theme may be a plain object of partial field values, or a wrapped versioned object:

```json
{
  "schemaVersion": 1,
  "id": "midnight",
  "name": "Midnight",
  "description": "Cool dark chat bubbles.",
  "fieldData": {
    "bubbleColor": "#171b2c",
    "textColor": "#f4f7ff"
  }
}
```

Plain theme objects derive their id and name from the filename. Theme keys outside the current FIELDS schema produce a warning but are preserved; in a shipped theme they are an error (see below).

### Shipped themes

The widget's `themes/` folder and its root `data.json` ship with the widget, for buyers to paste into the StreamElements DATA tab, whatever the theme glob loads. `validate` treats as shipped the root `data.json`, each `themes/**/<id>.data.json`, and each other `themes/**/<id>.json` without a `<id>.data.json` beside it; beside one, the `.json` is the Studio's view of the same look and may stay partial. A shipped theme sets every FIELDS key except buttons, so a key added to FIELDS gets a value chosen for each look, and `validate` reports each key one leaves out as `THEME_FIELDS_MISSING`, an error. List in `themes.keepDefault` the keys that may stay out because the widget behaves the same without them as with their FIELDS default:

```js
themes: {glob: "themes/*.json", keepDefault: ["welcomeText", "maxMessages"]}
```

That holds when applying a theme replaces the whole DATA tab. When buyers instead copy a theme's values into the field panel by hand, a key a theme leaves out keeps the value the previous look set, so a look key that any theme changes (a gradient switch, say) belongs in every shipped theme, never in `keepDefault`.

A shipped theme also sets no other key, gives each key a value its field takes, and is plain ASCII. `validate` reports each break as an error with its own code, one diagnostic per theme and code, naming every key that breaks it:

| Code | A shipped theme that |
| --- | --- |
| `THEME_FIELDS_EXTRA` | sets a key that FIELDS does not have (such as a removed field's old name) or that is a button |
| `THEME_VALUE_NOT_NUMBER` | gives a `slider` or `number` field anything but a number |
| `THEME_VALUE_OUT_OF_RANGE` | gives a `slider` or `number` field a value below its `min` or above its `max` |
| `THEME_VALUE_OFF_STEP` | gives a `slider` a value its handle cannot reach: not its `min` plus a whole number of `step`s |
| `THEME_VALUE_NOT_OPTION` | gives a `dropdown` a value that is not one of its `options` keys (a label fails) |
| `THEME_VALUE_NOT_COLOR` | gives a `colorpicker` anything but `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb(r, g, b)`, or `rgba(r, g, b, a)` |
| `THEME_VALUE_NOT_BOOLEAN` | gives a `checkbox` anything but `true` or `false` |
| `THEME_VALUE_NO_FONT` | gives a `googleFont` field an empty name or no string |
| `THEME_VALUE_NOT_STRING` | gives a `text`, `image-input`, `video-input`, or `sound-input` field anything but a string, or a `multiple` media field anything but a list of strings |
| `THEME_VALUE_UNCHECKED` | sets a field of a type `validate` has no rule for, so that a new field type gets its rule; a `hidden` field takes any value |
| `THEME_NOT_ASCII` | has a character above 0x7F, which a buyer's text editor can change on the way to the DATA tab; write it as a JSON escape (an emoji takes two, `\ud83c\udf81`) |

A Studio-only theme, such as a look made for marketing media, belongs outside `themes/` (for example in `studio/themes/`, added to the glob) and may stay partial.

## Fixtures

Fixtures contain synthetic context and a deterministic event timeline. Event payloads are passed through without reshaping:

```json
{
  "schemaVersion": 1,
  "id": "friendly-chat",
  "name": "Friendly chat",
  "channel": {"username": "streamer"},
  "recents": [],
  "session": {"follower-goal": {"amount": 42}, "tip-session": {"amount": 25}},
  "fieldData": {},
  "events": [
    {
      "atMs": 0,
      "listener": "message",
      "event": {
        "data": {
          "displayName": "Nova",
          "text": "Hello from a synthetic fixture!"
        }
      }
    }
  ]
}
```

`session` sets StreamElements session data keys, such as a goal's progress or a session total, over the empty defaults (see [Session data](RUNTIME.md#session-data)); the events then add to them. Use fixed ids, timestamps, and public-safe names. Never paste a captured live payload before removing tokens, cookies, personal data, private URLs, and licensed media.

## Scenes

A scene composes field state and external presentation state:

```json
{
  "schemaVersion": 1,
  "id": "listing-hero",
  "name": "Listing hero",
  "theme": "midnight",
  "fixture": "friendly-chat",
  "fieldData": {"showTimestamp": true},
  "background": {"id": "ink", "color": "#090b10"},
  "viewport": {"width": 430, "height": 640, "deviceScaleFactor": 1},
  "output": {"width": 2000, "height": 2000, "format": "png"},
  "camera": {"id": "centered", "scale": 2.1, "x": 0, "y": 0, "origin": "center center"},
  "captureAtMs": 800
}
```

- `viewport` controls responsive widget layout.
- `output` controls the external export canvas.
- `background.image` accepts an allowlisted widget asset, a data URL, or a built-in sample such as `"sws-sample:backdrops/plants.jpg"`. Pair a sample with its manifest `color` so the stage has a matching fallback.
- Media values in `fieldData` (themes, fixtures, scenes, scenario `updateFields`, and event payloads) may be built-in samples such as `"sws-sample:gallery/streamer-1-blur.jpg"`, or arrays of them for `image-input` fields with `multiple: true`. See [`sample-media/`](../sample-media/README.md); `validate` reports unknown references as `SAMPLE_MEDIA_UNKNOWN`, and names the date of a retired one. It, and the skill client's `import --config` and `catalog --config` on stderr, warn with `FIXTURE_NETWORK_URL` when a whole string value in `channel`, a theme, a fixture, a scene, a scenario, or a recipe is an `http://` or `https://` URL other than a Google Fonts one (`fonts.googleapis.com`, `fonts.gstatic.com`), because the local CLI's runtime network is blocked and a widget that loads it fails the video render (a Studio import captures a public HTTPS URL in a media field, see [API.md](API.md)); FIELDS defaults and links inside a longer text are not checked.
- A widget's own media file is named by its path relative to the widget root, such as `"studio/media/gallery/01.jpg"`, alone or in an array. List it in `widget.assets` when it lives outside `assets/`, `fonts/`, and `media/`. The widget receives the file's absolute URL, as it would receive an uploaded file's URL in StreamElements, so this works in widgets that resolve media with `new URL(value, location.href)`, and the hosted Studio resolves the same value. The older `"/__sws/widget/studio/media/gallery/01.jpg"` spelling still works locally, but hosted import refuses it.
- `camera` scales and positions the iframe without changing widget typography.
- `crop` is an optional final clip in output CSS pixels.

The interactive Studio and Gallery show the complete output canvas so camera framing remains editable. `crop` is applied to exported screenshots, frames, thumbnails, and videos; inspect a dry run or rendered artifact for the final clipped bounds.

## Scenarios

Scenarios execute deterministic actions and DOM assertions:

```json
{
  "schemaVersion": 1,
  "id": "message-smoke",
  "name": "Message smoke",
  "scene": "listing-hero",
  "steps": [
    {"action": "wait", "ms": 100},
    {"action": "assert", "selector": ".message", "count": 1, "visible": true},
    {"action": "updateFields", "fieldData": {"showTimestamp": false}},
    {"action": "assert", "selector": ".timestamp", "exists": false}
  ]
}
```

Supported actions are `dispatch`, `updateFields`, `wait`, and `assert`. Every scenario receives a fresh browser context and iframe.

## Recipes

Recipes expand cross products of scenes, themes, backgrounds, viewports, and cameras:

```json
{
  "schemaVersion": 1,
  "id": "listing-media",
  "name": "Listing media",
  "marketplacePreset": "etsy-listing-2026-09",
  "scenes": ["listing-hero"],
  "matrix": {
    "themes": ["*"],
    "backgrounds": [
      {"id": "ink", "color": "#090b10"},
      {"id": "paper", "color": "#f2efe8"}
    ],
    "cameras": [
      {"id": "wide", "scale": 1.8, "x": 0, "y": 0, "origin": "center center"}
    ]
  },
  "outputs": {
    "screenshots": true,
    "thumbnails": {"width": 600, "height": 600, "fit": "contain", "format": "png"},
    "contactSheet": true,
    "video": {
      "enabled": true,
      "durationMs": 5000,
      "fps": 30,
      "format": "mp4",
      "codec": "h264",
      "pixelFormat": "yuv420p",
      "crf": 16,
      "audio": "none",
      "keepFrames": false,
      "stills": [{"name": "poster", "atMs": 0}, {"name": "mid-transition", "atMs": 2300}]
    }
  },
  "limit": 48
}
```

Run `render --dry-run` to inspect the exact variant names, output targets, and estimated disk use (`plan.estimate`, `plan.disk`) before starting a browser.

`keepFrames` is optional and defaults to `false`: after a validated encode, the PNG frames and `frames.json` are deleted and the manifest keeps their list and hashes. Set it to `true` to keep them for inspection or post-processing (loop cuts, posters, stills, a higher-quality re-encode); the `--keep-frames` flag does the same for one run. Hosted jobs never publish frames. A deployment or CLI older than this key rejects it, because video settings are strict.

`stills` is optional, for stage videos: up to 32 `{"name", "atMs"}` entries. Each becomes `<variant>-still-<name>.png` next to the video, a byte copy of the first frame at or after `atMs`, written while the frames exist, so it stays when they are discarded and a Studio job, which never publishes frames, delivers it too. A poster is a still at 0 ms. Names use lowercase letters, numbers, and single hyphens, and are unique; `atMs` is a whole number of milliseconds below `durationMs`. A tutorial video takes its stills from `still` steps and refuses `stills`. A deployment or CLI older than this key rejects it.

`crf` is optional and applies to H.264 MP4 only: x264's constant rate factor, an integer from 0 (lossless) to 51, where lower is sharper and larger. It defaults to 16 (x264's own default, 23, was the Studio's until 2026-10-09). A recipe that sets `crf` for VP9 WebM is refused; WebM keeps libvpx's default bitrate. Each video's manifest entry records what it was encoded with in `videoEncoding`. A deployment or CLI older than this key rejects it.

The contact sheet shows each screenshot at its own proportions, scaled to fit its cell, over a checkerboard of its size: transparent pixels show as the checkerboard, and the cell around the image stays plain. `render --sheet-at` draws its sheet the same way. A recipe cannot request thumbnails or a contact sheet while disabling screenshots. Video container, codec, and alpha pixel-format combinations are checked when the recipe is loaded.
