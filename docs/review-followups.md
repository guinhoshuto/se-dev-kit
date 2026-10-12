# Review follow-ups

What a review found that does not block its change, so it is not lost in a session's `.cache/`. Each item says where
it came from and what would close it; remove it when it is done.

## Open

- **Four repo scripts keep the entry guard that failed `cut-loop.mjs` through the skill link** (orphan jobs and
  cut-loop, 2026-10-11). `scripts/kill-stale.mjs`, `scripts/run-tests.mjs`, `scripts/mutate.mjs` and
  `scripts/verify-hosted.mjs` run their main only when `argv[1]`, resolved but not real, names the module's real path.
  Through a symlink the two differ and the script exits 0 without doing anything. npm runs them by a path relative to
  the checkout, which resolves against the real working directory, so they work today; one invoked by an absolute
  path through a link would not. To close: the realpath comparison of `isEntryPoint()` in
  `skills/se-widget-studio/scripts/studio-client.mjs`, with a test that runs each one through a link (`mutate.mjs
  --help` can; `kill-stale.mjs` has no harmless mode and needs one first).
- **`mutate.mjs` leaves `dist/` built from the last `src/` mutant until the next `src/` mutation** (studio-local
  batch, 2026-10-12). A mutation of `src/` rebuilds `dist/` with the mutant, and the restore puts back only the source:
  a plan mutation of `skills/`, `lib/` or `scripts/` that comes next runs against that mutant `dist/`, so it may be
  killed by the previous mutation, without its own change being tested. The SDK-48 plan works around it by listing
  its `skills/` mutations first. To close: rebuild after restoring a `src/` mutation whenever the next one is not
  `src/` (or always), with a test whose plan puts a `src/` mutation the test kills before a `skills/` one it does not.
- **`review` fails with `UNEXPECTED_ERROR: ENOENT` when the page's folder does not exist** (studio-local batch,
  2026-10-12). `se-widget-studio review /new/folder/index.html <run>` writes the page without creating its folder. To
  close: create the parent folder (the page itself still needs `--force` to be replaced), or refuse with its own code
  and the hint, with a test.
- **`studio-client.mjs projects` gives no project name while the local Studio is stopped** (studio-local batch,
  2026-10-12). The name comes from the Studio's API, so with the Studio down every local project shows `name: null`,
  which is when an agent most needs it to tell projects apart. The local Studio keeps it in
  `.studio-data/projects/<id>/project.json` of the checkout the skill belongs to, without the key. To close: read the
  name there for a loopback origin when the API does not answer, as an allowlisted field, with a test.
