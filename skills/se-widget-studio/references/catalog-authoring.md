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

Never put background, crop, zoom, or output dimensions in `fieldData` unless they are genuine widget FIELDS.

For hosted import, list local binary dependencies explicitly as `{path, file, contentType}`. `file` is relative to the production widget root and is consumed only by the skill helper; the server stores the resulting private upload ID. Never use broad directory globs or include credentials, source maps, development configuration, or unrelated repository files.

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
      "outputs": {"screenshots": false, "video": {"enabled": true, "durationMs": 3000, "fps": 30, "format": "mp4", "codec": "h264", "audio": "none"}}
    }
  ]
}
```

Use synthetic content only. For WebM alpha, select VP9 WebM with `yuva420p`; MP4 requires H.264 and does not preserve alpha. Keep marketplace-specific constraints in dated presets with official source URLs, not in generic recipes.
