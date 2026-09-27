import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

import {sniffFont, validateGoogleCss} from "../../dist/fonts/css.js";

// Real stylesheets recorded once from fonts.googleapis.com with GOOGLE_FONTS_UA (2026-09-27).
// Tests never use the network.
const fixture = (name) => readFile(new URL(`../fixtures/google-fonts/${name}`, import.meta.url), "utf8");

const GSTATIC = "https://fonts.gstatic.com/s/roboto/v48/KFO7CnqEu92Fr1ME7kSn66aGLdTylUAMa3yUBA.woff2";
const face = (src, extra = "") =>
  `@font-face {\n  font-family: 'Roboto';\n  font-style: normal;\n  font-weight: 400;\n  src: ${src};\n  unicode-range: U+0000-00FF;\n${extra}}\n`;

function invalid(css, pattern) {
  const result = validateGoogleCss(css);
  assert.equal(result.ok, false, `should reject: ${css.slice(0, 120)}`);
  assert.match(result.message, pattern);
}

test("real v1 CSS is accepted with every file, descriptor and unicode-range", async () => {
  const result = validateGoogleCss(await fixture("roboto-open-sans-v1.css"));
  assert.equal(result.ok, true, result.message);
  assert.equal(result.files.length, 28);
  assert.equal(result.classRules, 0);
  assert.deepEqual(
    [...new Set(result.files.map((file) => file.descriptors["font-family"]))],
    ["'Open Sans'", "'Roboto'"]
  );
  const first = result.files[0];
  assert.match(first.url, /^https:\/\/fonts\.gstatic\.com\/s\/opensans\/v\d+\/[A-Za-z0-9_-]+\.woff2$/);
  assert.equal(first.format, "woff2");
  assert.equal(first.unicodeRange, "U+0460-052F, U+1C80-1C8A, U+20B4, U+2DE0-2DFF, U+A640-A69F, U+FE2E-FE2F");
  assert.deepEqual(first.descriptors, {
    "font-family": "'Open Sans'",
    "font-style": "italic",
    "font-weight": "400",
    "font-stretch": "100%",
    "unicode-range": first.unicodeRange
  });
  assert.ok(result.files.every((file) => file.url.startsWith("https://fonts.gstatic.com/s/") && file.unicodeRange));
});

test("real css2 CSS with ital,wght, opsz,wght and CJK slices is accepted", async () => {
  const archivo = validateGoogleCss(await fixture("archivo-ital-wght-css2.css"));
  assert.equal(archivo.ok, true, archivo.message);
  assert.equal(archivo.files.length, 6);
  assert.deepEqual([...new Set(archivo.files.map((file) => file.descriptors["font-style"]))], ["italic", "normal"]);
  assert.ok(archivo.files.every((file) => file.descriptors["font-display"] === "swap"));

  const inter = validateGoogleCss(await fixture("inter-opsz-wght-css2.css"));
  assert.equal(inter.ok, true, inter.message);
  assert.equal(inter.files.length, 7);
  assert.ok(inter.files.every((file) => file.descriptors["font-weight"] === "100 900"));

  const cjk = validateGoogleCss(await fixture("mplus-rounded-1c-css2.css"));
  assert.equal(cjk.ok, true, cjk.message);
  assert.equal(cjk.files.length, 126);
  assert.equal(new Set(cjk.files.map((file) => file.url)).size, 126);
  assert.ok(cjk.files.some((file) => /\.\d+\.woff2$/.test(file.url)));
});

test("Material Symbols class rules without url() are accepted", async () => {
  const result = validateGoogleCss(await fixture("material-symbols-outlined-css2.css"));
  assert.equal(result.ok, true, result.message);
  assert.equal(result.files.length, 1);
  assert.equal(result.classRules, 1);
  assert.equal(result.files[0].unicodeRange, undefined);
  assert.equal(result.files[0].descriptors["font-family"], "'Material Symbols Outlined'");
});

test("bytes are accepted as UTF-8 and the 1 MB limit applies", async () => {
  const bytes = new TextEncoder().encode(await fixture("archivo-ital-wght-css2.css"));
  assert.equal(validateGoogleCss(bytes).ok, true);
  invalid(new Uint8Array([0x40, 0xff, 0xfe]), /UTF-8/);
  const padding = `/* ${"x".repeat(1024 * 1024)} */\n`;
  invalid(`${padding}${face(`url(${GSTATIC}) format('woff2')`)}`, /limit is 1048576/);
  const justUnder = `/* ${"x".repeat(1024 * 1024 - 6)} */`;
  assert.equal(Buffer.byteLength(justUnder), 1024 * 1024);
  assert.equal(validateGoogleCss(justUnder).ok, true);
  invalid(`${justUnder} `, /is 1048577 bytes/);
});

test("src entries are parsed with or without quotes and format()", () => {
  const result = validateGoogleCss(
    face(`url("${GSTATIC}") format("woff2"), url('${GSTATIC.replace(".woff2", ".ttf")}'), url(//fonts.gstatic.com/s/roboto/v48/abc.woff)`)
  );
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(
    result.files.map((file) => [file.url, file.format]),
    [
      [GSTATIC, "woff2"],
      [GSTATIC.replace(".woff2", ".ttf"), undefined],
      ["https://fonts.gstatic.com/s/roboto/v48/abc.woff", undefined]
    ]
  );
});

test("@import and every other at-rule are rejected", () => {
  invalid(`@import url(${GSTATIC});\n${face(`url(${GSTATIC})`)}`, /@import/);
  invalid(`@import "https://fonts.googleapis.com/css?family=Lato";`, /@import/);
  invalid(`@media screen { .a { font-size: 1px; } }`, /@media/);
  invalid(`@charset "utf-8";`, /@charset/);
  invalid(`@font-face foo { src: url(${GSTATIC}); }`, /@font-face/);
  invalid(`@font-face { @media screen { font-weight: 400; } src: url(${GSTATIC}); }`, /only declarations/);
});

test("url() outside gstatic /s/, data: and javascript: are rejected", () => {
  invalid(face(`url(https://example.com/font.woff2) format('woff2')`), /fonts\.gstatic\.com\/s\//);
  invalid(face(`url(https://fonts.gstatic.com.example.com/s/roboto/v48/a.woff2)`), /fonts\.gstatic\.com\/s\//);
  invalid(face(`url(https://fonts.gstatic.com/l/font?kit=abc)`), /fonts\.gstatic\.com\/s\//);
  invalid(face(`url(https://fonts.googleapis.com/css?family=Lato)`), /fonts\.gstatic\.com\/s\//);
  invalid(face(`url(/s/roboto/v48/a.woff2)`), /fonts\.gstatic\.com\/s\//);
  invalid(face(`url(data:font/woff2;base64,d09GMgABAAAA)`), /data: or javascript:/);
  invalid(face(`url("javascript:alert(1)")`), /data: or javascript:/);
  invalid(face(`local('Roboto'), url(${GSTATIC})`), /not url/);
  invalid(face(`url(${GSTATIC}) tech(variations)`), /not url/);
  invalid(face(`url(${GSTATIC})`, `  font-family: url(${GSTATIC});\n`), /must not contain url/);
  invalid(face(`url(${GSTATIC})`, `  font-display: "data:x";\n`), /data: or javascript:/);
  invalid(`@font-face { font-family: 'X'; }`, /no src/);
  invalid(face(`url(${GSTATIC})`, `  src: url(${GSTATIC});\n`), /more than once/);
  invalid(face(`url(${GSTATIC})`, `  color: red;\n`), /descriptor color is not allowed/);
});

test("class rules must be single classes with font and text properties only, and no url()", () => {
  invalid(`.icons { background: url(https://example.com/a.png); }`, /background is not allowed/);
  invalid(`.icons { font-family: url(${GSTATIC}); }`, /must not contain url/);
  invalid(`.icons { -webkit-font-feature-settings: 'liga' \\28; }`, /must not contain/);
  invalid(`.icons { color: red; }`, /color is not allowed/);
  invalid(`body { font-size: 24px; }`, /not a single class/);
  invalid(`.a, .b { font-size: 24px; }`, /not a single class/);
  invalid(`.a .b { font-size: 24px; }`, /not a single class/);
  invalid(`.a { .b { font-size: 24px; } }`, /only declarations/);
  assert.equal(validateGoogleCss(`.a { font-size: 24px; line-height: 1; -moz-osx-font-smoothing: grayscale; }`).ok, true);
  assert.equal(validateGoogleCss(`/* top */ .a { /* inner */ font-size: 24px; }\n${face(`url(${GSTATIC})`, "  /* inner */\n")}`).ok, true);
});

test("HTML and unparsable input are rejected", () => {
  invalid(`<!DOCTYPE html><html><body>Error 400 (Bad Request)</body></html>`, /./);
  invalid(`@font-face { src: url(${GSTATIC})`, /could not be parsed/);
  invalid(`{"error": "not css"}`, /./);
});

test("sniffFont accepts the six font signatures and rejects everything else", () => {
  const bytes = (...values) => new Uint8Array([...values, 0, 0, 0, 0]);
  const ascii = (text) => bytes(...[...text].map((character) => character.charCodeAt(0)));
  assert.equal(sniffFont(ascii("wOF2")), "woff2");
  assert.equal(sniffFont(ascii("wOFF")), "woff");
  assert.equal(sniffFont(ascii("OTTO")), "otf");
  assert.equal(sniffFont(bytes(0x00, 0x01, 0x00, 0x00)), "ttf");
  assert.equal(sniffFont(ascii("true")), "ttf");
  assert.equal(sniffFont(ascii("ttcf")), "ttc");
  assert.equal(sniffFont(ascii("<!DOCTYPE html>")), undefined);
  assert.equal(sniffFont(ascii("<html>")), undefined);
  assert.equal(sniffFont(ascii(`{"error":1}`)), undefined);
  assert.equal(sniffFont(ascii("wof2")), undefined);
  assert.equal(sniffFont(bytes(0x00, 0x01, 0x00, 0x01)), undefined);
  assert.equal(sniffFont(new Uint8Array([0x77, 0x4f, 0x46])), undefined);
  assert.equal(sniffFont(new Uint8Array([0x00, 0x01, 0x00])), undefined);
  assert.equal(sniffFont(new Uint8Array()), undefined);
});
