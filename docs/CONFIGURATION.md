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

Plain theme objects derive their id and name from the filename. Theme keys outside the current FIELDS schema produce a warning but are preserved.

## Fixtures

Fixtures contain synthetic context and a deterministic event timeline. Event payloads are passed through without reshaping:

```json
{
  "schemaVersion": 1,
  "id": "friendly-chat",
  "name": "Friendly chat",
  "channel": {"username": "streamer"},
  "recents": {},
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

Use fixed ids, timestamps, and public-safe names. Never paste a captured live payload before removing tokens, cookies, personal data, private URLs, and licensed media.

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
  "marketplacePreset": "etsy-listing-2026-08",
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
      "audio": "none"
    }
  },
  "limit": 48
}
```

Run `render --dry-run` to inspect the exact variant names and output targets before starting a browser.

A recipe cannot request thumbnails or a contact sheet while disabling screenshots. Video container, codec, and alpha pixel-format combinations are checked when the recipe is loaded.
