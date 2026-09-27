import assert from "node:assert/strict";
import test from "node:test";

import {checkFonts} from "../../dist/capture/fonts.js";

const CSS = "https://fonts.googleapis.com/css2?family=Archivo:wght@700&family=Open+Sans";

test("a blocked Google Fonts request fails with FONT_UNAVAILABLE naming each family, with the hosted hint", () => {
  assert.throws(() => checkFonts([{url: CSS, detail: "net::ERR_BLOCKED_BY_CLIENT"}]), (error) => {
    assert.equal(error.code, "FONT_UNAVAILABLE");
    assert.match(error.message, /"Archivo", "Open Sans" \(https:\/\/fonts\.googleapis\.com\/css2\?family=Archivo:wght@700&family=Open\+Sans\): net::ERR_BLOCKED_BY_CLIENT/);
    assert.match(error.hint, /hosted Studio/);
    return true;
  });
  // A font file names the family folder of its path.
  assert.throws(() => checkFonts([{url: "https://fonts.gstatic.com/s/archivo/v19/abc.woff2", detail: "failed"}]), /"archivo"/);
  // A stylesheet only the frame saw fail counts too.
  assert.throws(
    () => checkFonts([], {families: [], redrawNeeded: false, failedStylesheets: [{href: CSS, reason: "stylesheet-blocked"}], issues: [], complete: true}),
    {code: "FONT_UNAVAILABLE"}
  );
});

test("a family Google refuses is a warning, and transient statuses stay failures", () => {
  const refused = checkFonts([{url: "https://fonts.googleapis.com/css2?family=Nope", status: 400, detail: "HTTP 400"}]);
  assert.deepEqual(refused.warnings, [
    'upstream-4xx: Google Fonts refused "Nope" (https://fonts.googleapis.com/css2?family=Nope) with HTTP 400; the text stays in fallback, as in StreamElements.'
  ]);
  // The request status wins over the frame's generic failure for the same URL.
  const merged = checkFonts(
    [{url: "https://fonts.googleapis.com/css2?family=Nope", status: 404, detail: "HTTP 404"}],
    {families: [], redrawNeeded: false, failedStylesheets: [{href: "https://fonts.googleapis.com/css2?family=Nope", reason: "stylesheet-blocked"}], issues: [], complete: true}
  );
  assert.equal(merged.warnings.length, 1);
  // An unfilled placeholder is a request Google would refuse: a warning, never an upstream call.
  const placeholder = checkFonts([{url: "https://fonts.googleapis.com/css?family={{fontName}}", detail: "net::ERR_BLOCKED_BY_CLIENT"}]);
  assert.equal(placeholder.warnings.length, 1);
  assert.match(placeholder.warnings[0], /^upstream-4xx: /);
  for (const status of [408, 429, 500, 503]) {
    assert.throws(() => checkFonts([{url: CSS, status, detail: `HTTP ${status}`}]), {code: "FONT_UNAVAILABLE"}, String(status));
  }
  assert.deepEqual(checkFonts([]).warnings, []);
});

test("/icon, text= and URLs outside the allowlist fail with FONT_UNSUPPORTED", () => {
  for (const url of [
    "https://fonts.googleapis.com/icon?family=Material+Icons",
    "https://fonts.googleapis.com/css2?family=Roboto&text=Hello",
    "https://fonts.gstatic.com/l/font?kit=abc"
  ]) {
    assert.throws(() => checkFonts([{url, detail: "net::ERR_BLOCKED_BY_CLIENT"}]), {code: "FONT_UNSUPPORTED"}, url);
  }
});
