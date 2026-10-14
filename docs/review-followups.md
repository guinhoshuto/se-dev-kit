# Review follow-ups

What a review found that does not block its change, so it is not lost in a session's `.cache/`. Each item says where
it came from and what would close it; remove it when it is done.

## Open

- **`review` fails with `UNEXPECTED_ERROR: ENOENT` when the page's folder does not exist** (studio-local batch,
  2026-10-12). `se-widget-studio review /new/folder/index.html <run>` writes the page without creating its folder. To
  close: create the parent folder (the page itself still needs `--force` to be replaced), or refuse with its own code
  and the hint, with a test.
- **`studio-client.mjs projects` gives no project name while the local Studio is stopped** (studio-local batch,
  2026-10-12). The name comes from the Studio's API, so with the Studio down every local project shows `name: null`,
  which is when an agent most needs it to tell projects apart. The local Studio keeps it in
  `.studio-data/projects/<id>/project.json` of the checkout the skill belongs to, without the key. To close: read the
  name there for a loopback origin when the API does not answer, as an allowlisted field, with a test.
