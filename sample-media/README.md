# Sample media

Built-in images for testing widgets without creating, downloading, or uploading media. Every Studio build ships them: the local CLI, the hosted editor preview, and hosted render/test jobs read the same files through `manifest.json`.

## Reference them

Use the whole JSON string `sws-sample:<file>` where a catalog accepts media:

- a value of an `image-input` field in a theme, fixture, scene, scenario `updateFields` step, or event payload (a string, or an array for `multiple: true` fields);
- `scene.background.image` and `recipe.matrix.backgrounds[].image`.

```json
{"fieldData": {"image": "sws-sample:gallery/streamer-1-blur.jpg", "gallery": ["sws-sample:gallery/streamer-2.jpg", "sws-sample:backdrops/cute.jpg"]}}
{"background": {"id": "plants", "image": "sws-sample:backdrops/plants.jpg", "color": "#e7dcce"}}
```

The references are not widget files. Do not copy them into a widget, list them under hosted `assets`, write them in widget HTML/CSS, or save them as FIELDS defaults; hosted import rejects the last two, while local `validate` does not check them. `validate` and hosted import reject unknown references. `manifest.json` lists every reference with its dimensions, alt text, average `color` (pair it with a backdrop as the stage fallback while the image loads), and, for backdrops, a `tone` (`dark`, `medium`, `light`) for choosing contrast.

A deployment announces which samples it serves at `GET /api/v1/sample-media` (metadata only, no capability). Deployments that predate sample media answer 404; the skill client checks this before creating or replacing a project.

- `gallery/`: 3 webcam-style photos of a streamer at a desk, 1672x941: `streamer-2` and the blurred `streamer-1-blur` and `streamer-2-blur`. As a 16:9 stage background they show a widget on a stream; the blurred ones keep the photo behind the widget.
- `backdrops/`: 7 square illustrated stage backgrounds with an open center, 1254x1254, drawn with `background-size: cover`. Only `blueprint` is dark.

There are no video, audio, avatar, emote, transparent PNG, animated, or portrait samples yet.

## Origin and license

The owner generated the images with ChatGPT (OpenAI gpt-image) and supplied them on 2026-09-29; each original PNG carried OpenAI's C2PA credentials marking it AI-generated (`trainedAlgorithmicMedia`). The streamer photos show synthetic people, not real individuals. A review found no legible text or logo in them, and no text, brand, logo, face, or person in the backdrops. On 2026-10-02 the owner supplied `streamer-1-blur` and `streamer-2-blur`, which they made in Canva by blurring the background of the `streamer-1` and `streamer-2` originals; the edit dropped the C2PA credentials, so those two PNGs carry none. They are distributed under the repository's MIT license.

The committed files were converted once from the PNG originals (on 2026-09-29, and on 2026-10-02 for the blurred two) with sharp 0.35.4 (libvips 8.18.6, mozjpeg) using `jpeg({quality: 82, mozjpeg: true})` and `withIccProfile('srgb')`, which keeps the dimensions, tags sRGB, and writes progressive JPEG without the originals' metadata, C2PA manifest included (the first 17.9 MB of PNG became 1.1 MB). `color` is each file's mean sRGB color, and `tone` follows the relative luminance of the backdrop's center, where a widget sits. Conversion is not part of the build or runtime. `src/config/hosted-catalog.ts` keeps the SHA-256 of each PNG original, so a widget that carries one as a test file names the sample instead of uploading it.

## Append-only rule

A published reference never changes bytes, because saved hosted revisions store only the reference and its SHA-256. To change an image, add a new file with a new name and a new manifest entry, and add it to `tests/unit/sample-media.lock.json`; never edit a locked entry. Saved revisions whose pinned hash no longer matches fail with a clear error instead of rendering different pixels.

Only the owner's explicit request removes a published image. Its file is deleted, its manifest entry moves to `retired` with the date, and its lock entry stays, so the name never returns with other pixels. A catalog or saved revision that uses a retired reference fails with the date it was retired. On 2026-09-29 the owner replaced the 14 images of 2026-09-25 (8 gallery images and 6 backdrops) with 9 new ones. On 2026-10-02 the owner retired `streamer-1` and added `streamer-1-blur` and `streamer-2-blur`.

## Cost

The files total about 1 MB. The hosted interactive preview embeds only the sample references the selected scene uses. They share one 3 MiB budget with the captured assets, and the preview response, which carries all of them as base64 together with the background image, must stay under 4,000,000 bytes, so plan for well under 3 MB of raw media per previewed scene. Samples do not count toward the 128-file, 100 MB revision budget or the daily upload quota.
