# Sample media

Built-in images for testing widgets without creating, downloading, or uploading media. Every Studio build ships them: the local CLI, the hosted editor preview, and hosted render/test jobs read the same files through `manifest.json`.

## Reference them

Use the whole JSON string `sws-sample:<file>` where a catalog accepts media:

- a value of an `image-input` field in a theme, fixture, scene, scenario `updateFields` step, or event payload (a string, or an array for `multiple: true` fields);
- `scene.background.image` and `recipe.matrix.backgrounds[].image`.

```json
{"fieldData": {"image": "sws-sample:gallery/neon-city.jpg", "gallery": ["sws-sample:gallery/synthwave-sunset.jpg", "sws-sample:gallery/ocean-moon.jpg"]}}
{"background": {"id": "aurora", "image": "sws-sample:backdrops/aurora-mesh.jpg", "color": "#2e2b52"}}
```

The references are not widget files. Do not copy them into a widget, list them under hosted `assets`, write them in widget HTML/CSS, or save them as FIELDS defaults; hosted import rejects the last two, while local `validate` does not check them. `validate` and hosted import reject unknown references. `manifest.json` lists every reference with its dimensions, alt text, dominant `color` (pair it with a backdrop as the stage fallback while the image loads), and, for backdrops, a `tone` (`dark`, `medium`, `light`) for choosing contrast.

A deployment announces which samples it serves at `GET /api/v1/sample-media` (metadata only, no capability). Deployments that predate sample media answer 404; the skill client checks this before creating or replacing a project.

- `gallery/`: 8 landscape images, 1600x900.
- `backdrops/`: 6 square stage backgrounds, 2000x2000, drawn with `background-size: cover`.

There are no video, audio, avatar, emote, transparent PNG, animated, portrait, or square-gallery samples yet.

## Origin and license

The images are synthetic. An AI agent generated them on 2026-09-25 for testing; a review found no text, brand, logo, face, or person in any of them. They are distributed under the repository's MIT license.

The committed files were recompressed once from the generated originals with sharp 0.35.4 (libvips 8.18.6, mozjpeg) using `jpeg({quality: 82, mozjpeg: true})` and `withIccProfile('srgb')`, which keeps the dimensions and the sRGB profile and writes progressive JPEG without EXIF. `gallery/pixel-forest.jpg` kept its original bytes because recompression made it larger. Recompression is not part of the build or runtime.

## Append-only rule

A published reference never changes bytes, because saved hosted revisions store only the reference and its SHA-256. To change an image, add a new file with a new name and a new manifest entry, and add it to `tests/unit/sample-media.lock.json`; never edit or remove a locked entry. Saved revisions whose pinned hash no longer matches fail with a clear error instead of rendering different pixels.

## Cost

The files total about 1.6 MB. The hosted interactive preview embeds only the sample references the selected scene uses. They share one 3 MiB budget with the captured assets, and the preview response, which carries all of them as base64 together with the background image, must stay under 4,000,000 bytes, so plan for well under 3 MB of raw media per previewed scene. Samples do not count toward the 128-file, 100 MB revision budget or the daily upload quota.
