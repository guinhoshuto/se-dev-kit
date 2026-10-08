# Catalog authoring

Use schema version `1` and unique IDs matching `[a-zA-Z0-9_-]{1,100}`. Keep catalogs small and specific to the widget.

## Layers

Effective field data is shallow-merged in this order:

```text
FIELDS defaults → theme → fixture → scene → temporary preview override
```

- A **theme** contains `fieldData` only.
- A **fixture** provides synthetic `channel`, `recents`, `session` (session data keys such as `follower-goal`, which events then update), `fieldData`, and timed events.
- A **scene** selects a theme/fixture and presentation: background, viewport, output, camera, crop, and capture time.
- A **scenario** performs deterministic dispatch, field update, wait, and DOM assertion steps.
- A **recipe** selects scenes and optional theme/background/viewport/camera matrices, then requests screenshots, thumbnails, contact sheets, or video.
- A video with `"mode": "tutorial"` records a "how to configure" video inside a StreamElements overlay editor replica, driven by `outputs.video.tutorial.steps` (`selectLayer`, `openGroup`, `setField`, `pressButton`, `chat`, `emulate`, `save`, `caption`, `still`, `wait`, `move`, `click`). Read [tutorial-video.md](tutorial-video.md) before authoring one.

Never put background, crop, zoom, or output dimensions in `fieldData` unless they are genuine widget FIELDS.

Themes and scenes may set a `googleFont` field freely: the Studio preview and jobs load Google Fonts as StreamElements does, and substitute `{{field}}` placeholders with the effective field data in HTML, CSS and JS.

## Field changes

A tutorial `setField` or a scenario `updateFields` reloads the widget with the new values, as the StreamElements editor does: placeholders are substituted again, `onWidgetLoad` fires again, and whatever the widget built before, such as chat messages, is gone. A buyer sees the same in StreamElements, so script tutorials with that in mind: change fields first, then chat and emulate. Set `widget.fieldUpdate` to `"event"` (in the local config's `widget`, or the catalog's) only for a widget written against the Studio that must keep its state across a field change and listens to the Studio's `onWidgetUpdate`; StreamElements has no such event. A render manifest records the mode and each change under `fieldUpdate`.

## Theme files

A widget repository keeps each theme in `themes/` as a pair:

- `themes/<id>.json` is the Studio theme: partial `fieldData`, only the fields the theme changes. Write it bare (`{"accent": "#a78bfa"}`, the file name gives the ID) or whole (`schemaVersion`, `id`, `name`, `fieldData`).
- `themes/<id>.data.json` (optional) is the StreamElements DATA tab payload for the same look, with every field filled in. It ships with the widget for buyers to paste; the Studio does not load it.

`init` writes the theme glob `themes/!(*.data).json`, which loads the first file and skips the second. A widget that ships only `themes/*.data.json` already follows this format: never rename, convert, or rewrite those files. To try one of those looks in the Studio, add `themes/<id>.json` with the partial field data that gives it, or point the config's theme glob at `themes/*.data.json` (the IDs then end in `-data`). A root `data.json`, when present, is the DATA payload of the widget's default look and ships the same way.

## Sample media

Never generate, download, draw, or upload images or videos just to test a widget. The Studio ships sample photos, backdrops, avatars, and a video clip, and every mode (Studio preview, Studio jobs, local CLI) resolves them from the same verified files. Reference one as the whole JSON string `sws-sample:<file>`:

| Gallery reference (1672x941, landscape) | Shows |
|---|---|
| `sws-sample:gallery/streamer-2.jpg` | Webcam shot of a smiling streamer with black bangs, headphones, and a mic in a dim purple-lit room |
| `sws-sample:gallery/streamer-1-blur.jpg` | Heavily blurred webcam shot of a streamer with dark brown hair and a cream sweater in a mauve room with pink and violet lights |
| `sws-sample:gallery/streamer-2-blur.jpg` | Heavily blurred `streamer-2`: black hair and top in a dark purple room with a pink and blue light |

| Backdrop reference (1254x1254, drawn with cover) | Tone | Pair with `color` | Shows |
|---|---|---|---|
| `sws-sample:backdrops/aero.jpg` | light | `#9acce9` | Blue sky and sparkling water framed by leaves, bubbles, and a glass ribbon |
| `sws-sample:backdrops/blueprint.jpg` | dark | `#0d4474` | Navy blueprint grid with white technical lines around an open center |
| `sws-sample:backdrops/cute.jpg` | light | `#f2e1dd` | Pastel waves, daisies, sparkles, and checkerboard corners around a cream center |
| `sws-sample:backdrops/cute-2.jpg` | light | `#eaddd4` | Pastel waves and checkerboards with daisies around a cream blob |
| `sws-sample:backdrops/patterns.jpg` | light | `#dcccbd` | Mid-century terracotta, mustard, and slate-blue shapes along the edges of cream paper |
| `sws-sample:backdrops/plants.jpg` | light | `#e7dcce` | Watercolor eucalyptus sprigs and blush blotches in the corners of cream paper |
| `sws-sample:backdrops/plants-2.jpg` | light | `#cbb09d` | Risograph red, blue, and yellow leaves and halftone dots around a cream center |

| Avatar reference (300x300 PNG, opaque) | Shows |
|---|---|
| `sws-sample:avatars/pixel-1.png` | Pink 5x5 pixel pattern on violet |
| `sws-sample:avatars/pixel-2.png` | Yellow 5x5 pixel pattern on coral red |
| `sws-sample:avatars/pixel-3.png` | Mint green 5x5 pixel pattern on blue |
| `sws-sample:avatars/pixel-4.png` | Light blue 5x5 pixel pattern on deep indigo |
| `sws-sample:avatars/pixel-5.png` | Orange 5x5 pixel pattern on teal |
| `sws-sample:avatars/pixel-6.png` | Lavender 5x5 pixel pattern on hot pink |

| Clip reference (1280x720 WebM, VP9, no audio) | Length | Shows |
|---|---|---|
| `sws-sample:clips/neon-road.webm` | 4 s seamless loop | Synthwave sunset with pink grid lines scrolling toward the viewer on a dark floor |

The people in the streamer photos are synthetic. A streamer photo as a 16:9 `background` shows the widget on a stream, and a blurred one keeps the photo from competing with the widget; the backdrops leave their center open for the widget. Either kind works in an image field or as a background. Avatars are mirrored pixel patterns like a default profile picture, drawn in code: use them for a chatter, follower, or tipper picture in event data, or for any small square `image-input`; they are too small for a background. The clip is the only `video-input` sample; it cannot be a background (`validate` fails with `SAMPLE_MEDIA_KIND`), and a sample of the wrong kind for its field is a `SAMPLE_MEDIA_KIND` warning. Pick a backdrop by contrast: a light or white-text widget on a `dark` one (`blueprint`, or `streamer-2` or `streamer-2-blur` at 16:9), a dark-text widget, or one with white cards, on a `light` one. Backdrops are 1254 px square, so a larger stage scales them up (a 2000x2000 still by 1.6x) and softens them. A retired reference fails `validate`, import, and push with the date it was retired; replace it with one from these tables. Alt text and exact metadata are in `sample-media/manifest.json` of the Studio repository (`$SKILL_DIR/../../sample-media/manifest.json` from a checkout or linked skill) and in `GET /api/v1/sample-media` on a deployment that supports samples.

```json
{
  "themes": [{"schemaVersion": 1, "id": "photo", "name": "Photo", "fieldData": {"image": "sws-sample:gallery/streamer-1-blur.jpg"}}],
  "scenes": [
    {
      "schemaVersion": 1,
      "id": "gallery-on-blueprint",
      "name": "Gallery on blueprint",
      "fieldData": {"galleryImages": ["sws-sample:gallery/streamer-1-blur.jpg", "sws-sample:gallery/streamer-2-blur.jpg", "sws-sample:backdrops/cute.jpg"]},
      "background": {"id": "blueprint", "image": "sws-sample:backdrops/blueprint.jpg", "color": "#0d4474"}
    }
  ],
  "recipes": [
    {"schemaVersion": 1, "id": "backdrops", "name": "Backdrops", "scenes": ["gallery-on-blueprint"], "matrix": {"backgrounds": [{"id": "plants", "image": "sws-sample:backdrops/plants.jpg", "color": "#e7dcce"}]}}
  ]
}
```

Rules:

- Only a whole string counts. It works as a media value in theme, fixture, scene, scenario `updateFields`, channel, and event data; as an array element of an `image-input` with `multiple: true`; as a `video-input` value (the clip); and as `background.image` of a scene or a recipe matrix background.
- Unknown references fail `validate` (`SAMPLE_MEDIA_UNKNOWN`), block a Studio import, and make the skill client refuse `import`/`push` before any change. Never put references in widget HTML or CSS or in FIELDS `value`/`default`, because StreamElements cannot resolve them. Hosted import rejects them there; local `validate` does not, so do not rely on it to catch this.
- Do not declare samples under `assets`, and never copy them into the widget directory. They cost no upload or revision asset quota. In the Studio's interactive preview, captured assets and the samples the selected scene shows share one budget (8 MiB in the local Studio, 3 MiB hosted), and the whole response, background image included, must stay under 10 MB as base64 locally (4 MB hosted): plan for well under the budget of raw media per previewed scene.
- Widgets receive an absolute URL: a same-origin `http:` URL in the local CLI and Studio jobs, a verified `data:image/` URL (`data:video/webm` for the clip) in the Studio's interactive preview. Code that resolves media with `new URL(value, location.href)` works unchanged when it also accepts `data:` URLs; code that keeps only `http:`, `https:`, or `blob:` shows the image in jobs and the local CLI but not in the hosted preview, as with any captured asset.
- Do not fill empty media fields silently. StreamElements shows an empty field as empty, so keep at least one scene with the media fields empty when the widget has an empty state, and put samples in the scenes that show media. The editors' **Fill empty image fields** button is an explicit, temporary choice.
- `sound-input` has no samples yet, and there are no emote, transparent, animated-image, or portrait samples. Leave those fields empty or ask the user; do not generate replacements.
- The clip in a render: a local or Studio job captures what Chrome's video decoder shows at each frame, which follows wall-clock playback rather than the render's virtual clock, so a video frame can differ between two renders of the same recipe. Report it as local simulation.

## Widget media files

Name a widget's own test media by its path relative to the widget root, such as `studio/media/gallery/01.jpg`, alone or in an array for a `multiple` field; in a local config, list it in `widget.assets` when it lives outside `assets/`, `fonts/`, and `media/`. Widgets receive the file's absolute URL in every mode, as with samples above. Do not write the local Studio's internal `/__sws/widget/<path>` URL: local runs still accept it, but hosted import refuses it.

## Studio assets

For a Studio import with `--catalog`, list local binary dependencies explicitly as `{path, file, contentType}`. `file` is relative to the production widget root and is consumed only by the skill helper; the server stores the resulting private upload ID. Never use broad directory globs or include credentials, source maps, development configuration, or unrelated repository files. `import --config` declares the files the config's `widget.assets` match, so keep those globs as narrow as the media the catalog uses.

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

Use synthetic content only. For WebM alpha, select VP9 WebM with `yuva420p`; MP4 requires H.264 and does not preserve alpha. Video the widget plays (a `video-input` value, an asset) may be MP4 (H.264) or WebM (VP9): the local Studio runs the machine's Google Chrome, which decodes both. A Chromium build does not decode H.264, and there an MP4 fails the whole job with `Video failed to load: …`; that is the paused hosted deployment (see [studio-workflow.md](studio-workflow.md#hosted-deployment-paused)) and any machine without Google Chrome, where `doctor` warns with `BROWSER_NO_H264`. Pick WebM only for a catalog that must also run there. A local render deletes the PNG frames after a validated encode; add `"keepFrames": true` to `outputs.video` only when the frames themselves are wanted for inspection or post-processing (loop cuts, posters, stills, a higher-quality re-encode). Leave it out of Studio catalogs: Studio jobs never publish frames, so `import --config` drops it; keep frames with the local CLI. Video output, MP4 and WebM, local and hosted, is converted with the BT.709 matrix and tagged BT.709 since the deployment of 2026-09-29; earlier videos are BT.601 without tags. A tool that re-encodes a Studio video should let FFmpeg read the tags (its default) instead of forcing `in_color_matrix`: forcing `bt601` on a newer video shifts its colors. Keep marketplace-specific constraints in dated presets with official source URLs, not in generic recipes.

A transparent widget that declares `color-scheme: dark` comes out on an opaque `#121212` box in the Studio's screenshots and videos (seen in a local capture) and in the tutorial's editor replica. Chrome paints an opaque canvas behind an iframe whose color scheme differs from the page that embeds it, and the Studio embeds widgets in a light page. StreamElements and OBS have not been checked. Do not work around it in the catalog: tell the user that the widget declares a dark scheme.
