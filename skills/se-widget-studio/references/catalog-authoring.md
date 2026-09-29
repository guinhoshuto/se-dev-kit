# Catalog authoring

Use schema version `1` and unique IDs matching `[a-zA-Z0-9_-]{1,100}`. Keep catalogs small and specific to the widget.

## Layers

Effective field data is shallow-merged in this order:

```text
FIELDS defaults → theme → fixture → scene → temporary preview override
```

- A **theme** contains `fieldData` only.
- A **fixture** provides synthetic `channel`, `recents`, `fieldData`, and timed events.
- A **scene** selects a theme/fixture and presentation: background, viewport, output, camera, crop, and capture time.
- A **scenario** performs deterministic dispatch, field update, wait, and DOM assertion steps.
- A **recipe** selects scenes and optional theme/background/viewport/camera matrices, then requests screenshots, thumbnails, contact sheets, or video.
- A video with `"mode": "tutorial"` records a "how to configure" video inside a StreamElements overlay editor replica, driven by `outputs.video.tutorial.steps` (`selectLayer`, `openGroup`, `setField`, `chat`, `emulate`, `save`, `caption`, `wait`, `move`, `click`). Read `docs/TUTORIAL.md` in the Studio repository before authoring one; dry-run to learn the required `durationMs`. It zooms on the cursor like Screen Studio by default; set `tutorial.autoZoom` to `false` or `{"zoom": 1.5}`.

Never put background, crop, zoom, or output dimensions in `fieldData` unless they are genuine widget FIELDS.

Themes and scenes may set a `googleFont` field freely: hosted preview and jobs load Google Fonts as StreamElements does, and substitute `{{field}}` placeholders with the effective field data in HTML, CSS and JS.

## Theme files

A widget repository keeps each theme in `themes/` as a pair:

- `themes/<id>.json` is the Studio theme: partial `fieldData`, only the fields the theme changes. Write it bare (`{"accent": "#a78bfa"}`, the file name gives the ID) or whole (`schemaVersion`, `id`, `name`, `fieldData`).
- `themes/<id>.data.json` (optional) is the StreamElements DATA tab payload for the same look, with every field filled in. It ships with the widget for buyers to paste; the Studio does not load it.

`init` writes the theme glob `themes/!(*.data).json`, which loads the first file and skips the second. A widget that ships only `themes/*.data.json` already follows this format: never rename, convert, or rewrite those files. To try one of those looks in the Studio, add `themes/<id>.json` with the partial field data that gives it, or point the config's theme glob at `themes/*.data.json` (the IDs then end in `-data`). A root `data.json`, when present, is the DATA payload of the widget's default look and ships the same way.

## Sample media

Never generate, download, draw, or upload images just to test a widget. The Studio ships synthetic sample images, and every mode (hosted preview, hosted jobs, local CLI) resolves them from the same verified files. Reference one as the whole JSON string `sws-sample:<file>`:

| Gallery reference (1600x900, landscape) | Shows |
|---|---|
| `sws-sample:gallery/synthwave-sunset.jpg` | Synthwave sun over purple mountains and a magenta grid |
| `sws-sample:gallery/neon-city.jpg` | Purple night skyline with neon towers and a full moon |
| `sws-sample:gallery/mountain-dawn.jpg` | Pastel lavender valley at dawn with a lake and pines |
| `sws-sample:gallery/cozy-desk.jpg` | Illustrated night desk setup with monitor, keyboard, and lamp |
| `sws-sample:gallery/space-nebula.jpg` | Ringed pink planet, small moon, and blue-magenta nebula |
| `sws-sample:gallery/pixel-forest.jpg` | Bright pixel-art platformer with coins, gems, and a chest |
| `sws-sample:gallery/ocean-moon.jpg` | Teal night ocean with a large cream moon |
| `sws-sample:gallery/abstract-glass.jpg` | Frosted glass shapes over blurred orange, pink, and blue light |

| Backdrop reference (2000x2000, drawn with cover) | Tone | Pair with `color` | Shows |
|---|---|---|---|
| `sws-sample:backdrops/aurora-mesh.jpg` | dark | `#2e2b52` | Violet and mint aurora over an indigo night sky |
| `sws-sample:backdrops/candy-pop.jpg` | light | `#f98d9d` | Yellow-pink-purple gradient with confetti shapes |
| `sws-sample:backdrops/midnight-grid.jpg` | dark | `#0d1624` | Very dark navy with a faint perspective grid |
| `sws-sample:backdrops/noir-warm.jpg` | dark | `#10100e` | Near-black with a warm golden spotlight |
| `sws-sample:backdrops/prism-sky.jpg` | light | `#e2f9e9` | Bright aqua-mint-lemon gradient; good for dark text or white cards |
| `sws-sample:backdrops/sunset-mesh.jpg` | medium | `#a44085` | Coral-to-magenta-to-indigo mesh gradient |

Pick a backdrop by contrast: a light or white-text widget on a `dark` backdrop, a dark-text widget, or one with white cards, on a `light` one. Alt text and exact metadata are in `sample-media/manifest.json` of the Studio repository (`$SKILL_DIR/../../sample-media/manifest.json` from a checkout or linked skill) and in `GET /api/v1/sample-media` on a deployment that supports samples.

```json
{
  "themes": [{"schemaVersion": 1, "id": "photo", "name": "Photo", "fieldData": {"image": "sws-sample:gallery/neon-city.jpg"}}],
  "scenes": [
    {
      "schemaVersion": 1,
      "id": "gallery-on-aurora",
      "name": "Gallery on aurora",
      "fieldData": {"galleryImages": ["sws-sample:gallery/synthwave-sunset.jpg", "sws-sample:gallery/ocean-moon.jpg", "sws-sample:gallery/pixel-forest.jpg"]},
      "background": {"id": "aurora", "image": "sws-sample:backdrops/aurora-mesh.jpg", "color": "#2e2b52"}
    }
  ],
  "recipes": [
    {"schemaVersion": 1, "id": "backdrops", "name": "Backdrops", "scenes": ["gallery-on-aurora"], "matrix": {"backgrounds": [{"id": "prism", "image": "sws-sample:backdrops/prism-sky.jpg", "color": "#e2f9e9"}]}}
  ]
}
```

Rules:

- Only a whole string counts. It works as a media value in theme, fixture, scene, scenario `updateFields`, channel, and event data; as an array element of an `image-input` with `multiple: true`; and as `background.image` of a scene or a recipe matrix background.
- Unknown references fail `validate` (`SAMPLE_MEDIA_UNKNOWN`), block hosted import, and make the skill client refuse `import`/`push` before any change. Never put references in widget HTML or CSS or in FIELDS `value`/`default`, because StreamElements cannot resolve them. Hosted import rejects them there; local `validate` does not, so do not rely on it to catch this.
- Do not declare samples under `assets`, and never copy them into the widget directory. They cost no upload or revision asset quota. In the hosted interactive preview, captured assets and the samples the selected scene shows share one 3 MiB budget, and the whole response, background image included, must stay under 4,000,000 bytes as base64: plan for well under 3 MB of raw media per previewed scene.
- Widgets receive an absolute URL: a same-origin `http:` URL in the local CLI and hosted jobs, a verified `data:image/` URL in the hosted interactive preview. Code that resolves media with `new URL(value, location.href)` works unchanged when it also accepts `data:image/` URLs; code that keeps only `http:`, `https:`, or `blob:` shows the image in jobs and the local CLI but not in the hosted preview, as with any captured asset.
- Do not fill empty media fields silently. StreamElements shows an empty field as empty, so keep at least one scene with the media fields empty when the widget has an empty state, and put samples in the scenes that show media. The editors' **Fill empty image fields** button is an explicit, temporary choice.
- `video-input` and `sound-input` have no samples yet, and there are no avatar, emote, transparent, animated, or portrait samples. Leave those fields empty or ask the user; do not generate replacements.

## Widget media files

Name a widget's own test media by its path relative to the widget root, such as `studio/media/gallery/01.jpg`, alone or in an array for a `multiple` field; in a local config, list it in `widget.assets` when it lives outside `assets/`, `fonts/`, and `media/`. Widgets receive the file's absolute URL in every mode, as with samples above. Do not write the local Studio's internal `/__sws/widget/<path>` URL: local runs still accept it, but hosted import refuses it.

## Hosted assets

For hosted import with `--catalog`, list local binary dependencies explicitly as `{path, file, contentType}`. `file` is relative to the production widget root and is consumed only by the skill helper; the server stores the resulting private upload ID. Never use broad directory globs or include credentials, source maps, development configuration, or unrelated repository files. `import --config` declares the files the config's `widget.assets` match, so keep those globs as narrow as the media the catalog uses.

## Compact example

```json
{
  "schemaVersion": 1,
  "name": "Listing setup",
  "widget": {
    "viewport": {"width": 430, "height": 640},
    "ready": {"selector": "#widget", "timeoutMs": 10000}
  },
  "channel": {"username": "synthetic_streamer"},
  "themes": [
    {"schemaVersion": 1, "id": "violet", "name": "Violet", "fieldData": {"accent": "#a78bfa"}}
  ],
  "fixtures": [
    {
      "schemaVersion": 1,
      "id": "message",
      "name": "Synthetic message",
      "events": [{"atMs": 100, "listener": "message", "event": {"data": {"displayName": "Preview viewer", "text": "Synthetic preview"}}}]
    }
  ],
  "scenes": [
    {
      "schemaVersion": 1,
      "id": "portrait",
      "name": "Portrait",
      "theme": "violet",
      "fixture": "message",
      "output": {"width": 430, "height": 640, "format": "png"},
      "captureAtMs": 250
    }
  ],
  "scenarios": [
    {
      "schemaVersion": 1,
      "id": "smoke",
      "name": "Smoke",
      "scene": "portrait",
      "steps": [{"action": "assert", "selector": "#widget", "visible": true}]
    }
  ],
  "recipes": [
    {
      "schemaVersion": 1,
      "id": "listing-images",
      "name": "Listing images",
      "scenes": ["portrait"],
      "outputs": {"screenshots": true, "thumbnails": {"width": 215, "height": 320, "fit": "cover"}, "contactSheet": true}
    },
    {
      "schemaVersion": 1,
      "id": "listing-video",
      "name": "Listing video",
      "scenes": ["portrait"],
      "outputs": {"screenshots": false, "video": {"enabled": true, "durationMs": 5000, "fps": 30, "format": "mp4", "codec": "h264", "audio": "none"}}
    }
  ]
}
```

Use synthetic content only. For WebM alpha, select VP9 WebM with `yuva420p`; MP4 requires H.264 and does not preserve alpha. For video the widget plays (a `video-input` value, an asset), use WebM (VP9): hosted jobs cannot decode H.264 input (see "Video input" in [hosted-workflow.md](hosted-workflow.md#current-hosted-boundaries)). A local render deletes the PNG frames after a validated encode; add `"keepFrames": true` to `outputs.video` only when the frames themselves are wanted for inspection or post-processing (loop cuts, posters, stills, a higher-quality re-encode). Leave it out of hosted catalogs: hosted jobs ignore it, and a deployment older than this key rejects it. Keep marketplace-specific constraints in dated presets with official source URLs, not in generic recipes.

A transparent widget that declares `color-scheme: dark` comes out on an opaque `#121212` box in the Studio's screenshots and videos (seen in a local capture) and in the tutorial's editor replica. Chrome paints an opaque canvas behind an iframe whose color scheme differs from the page that embeds it, and the Studio embeds widgets in a light page. StreamElements and OBS have not been checked. Do not work around it in the catalog: tell the user that the widget declares a dark scheme.
