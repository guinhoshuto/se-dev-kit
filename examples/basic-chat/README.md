# Basic chat example

This self-contained example uses only synthetic names, messages, timestamps, and channel data. Its production widget files are loaded directly; Studio-specific data stays in themes, fixtures, scenes, scenarios, and recipes.

From the repository root:

```bash
npm run build
node dist/cli/index.js validate examples/basic-chat --browser
node dist/cli/index.js dev examples/basic-chat
node dist/cli/index.js test examples/basic-chat --scenario widget-lifecycle
```

Preview the exact media plan before writing files:

```bash
node dist/cli/index.js render examples/basic-chat --recipe etsy-listing-images --dry-run --json
node dist/cli/index.js render examples/basic-chat --recipe etsy-listing-video --dry-run --json
```

`etsy-listing-images` produces two opaque 2000 × 2000 listing PNGs, 635 × 635 JPEG thumbnail QA files, a contact sheet, and a manifest. Upload the full-size listing images; thumbnails and the contact sheet are review artifacts.

`etsy-listing-video` produces a five-second silent 2160 × 1080 MP4 when existing FFmpeg and ffprobe executables are detected. Without FFmpeg, it preserves numbered PNG frames plus `frames.json`; pass `--allow-intermediate` only when that sequence is an acceptable handoff.

Outputs default to `.se-widget-studio/output` inside this example and are ignored by Git. Existing planned outputs require `--force`; unrelated files are never cleared.
