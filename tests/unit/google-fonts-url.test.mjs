import assert from "node:assert/strict";
import {readFile, stat} from "node:fs/promises";
import test from "node:test";

import {
  FONT_CACHE_EPOCH,
  GOOGLE_FONTS_MAX_CSS_BYTES,
  GOOGLE_FONTS_MAX_FAMILIES,
  GOOGLE_FONTS_MAX_FONT_BYTES,
  GOOGLE_FONTS_MAX_URL_LENGTH,
  GOOGLE_FONTS_ORIGIN_RULES,
  GOOGLE_FONTS_UA,
  canonicalGoogleFontsUrl,
  familiesFromUrl,
  isGoogleFontsHost,
  matchOriginRule
} from "../../dist/runtime/google-fonts-url.js";

const CSS = "https://fonts.googleapis.com";
const FILE = "https://fonts.gstatic.com/s/roboto/v48/KFO7CnqEu92Fr1ME7kSn66aGLdTylUAMa3yUBA.woff2";

function accepted(input) {
  const result = canonicalGoogleFontsUrl(input);
  assert.equal(result.ok, true, `${input} should be accepted: ${result.message ?? ""}`);
  return result;
}

function rejected(input, code, reason) {
  const result = canonicalGoogleFontsUrl(input);
  assert.equal(result.ok, false, `${input} should be rejected`);
  assert.equal(result.code, code, `${input} code`);
  assert.equal(result.reason, reason, `${input} reason`);
  assert.ok(result.message.length > 0);
  return result;
}

test("constants match the plan", () => {
  assert.equal(FONT_CACHE_EPOCH, "v1");
  assert.equal(GOOGLE_FONTS_MAX_CSS_BYTES, 1024 * 1024);
  assert.equal(GOOGLE_FONTS_MAX_FONT_BYTES, 4 * 1024 * 1024);
  assert.equal(GOOGLE_FONTS_MAX_URL_LENGTH, 2048);
  assert.equal(GOOGLE_FONTS_MAX_FAMILIES, 20);
  assert.match(GOOGLE_FONTS_UA, /^Mozilla\/5\.0 \(Windows NT 10\.0; Win64; x64\) .* Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/);
});

test("v1 family separators and space encodings canonicalize to one URL", () => {
  const expected = `${CSS}/css?family=Open+Sans:400,700|Roboto`;
  for (const input of [
    `${CSS}/css?family=Open+Sans:400,700|Roboto`,
    `${CSS}/css?family=Open+Sans:400,700%7CRoboto`,
    `${CSS}/css?family=Open+Sans:400,700%7cRoboto`,
    `${CSS}/css?family=Open%20Sans:400,700|Roboto`,
    `${CSS}/css?family=Open Sans:400,700|Roboto`,
    `  ${CSS}/css?family=Open Sans:400%2C700|Roboto  `
  ]) {
    const result = accepted(input);
    assert.equal(result.kind, "css");
    assert.equal(result.url, expected, input);
    assert.deepEqual(result.dropped, []);
  }
});

test("css2 keeps every family in order, then display and subset, and drops the rest", () => {
  const result = accepted(
    `${CSS}/css2?effect=fire&display=swap&family=Archivo:ital,wght@0,400;1,700&family=Bricolage+Grotesque:opsz,wght@12..96,400..800&callback=x&subset=latin&display=block#frag`
  );
  assert.equal(
    result.url,
    `${CSS}/css2?family=Archivo:ital,wght@0,400;1,700&family=Bricolage+Grotesque:opsz,wght@12..96,400..800&display=swap&subset=latin`
  );
  assert.deepEqual(result.dropped, ["effect", "callback", "display", "#"]);
});

test("parameter order does not change the canonical key, but family order does", () => {
  const a = accepted(`${CSS}/css2?display=swap&family=A&family=B`).url;
  const b = accepted(`${CSS}/css2?family=A&family=B&display=swap`).url;
  const c = accepted(`${CSS}/css2?family=B&family=A&display=swap`).url;
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("protocol-relative and http URLs are promoted to https; explicit port 443 is accepted", () => {
  assert.equal(accepted(`//fonts.googleapis.com/css?family=Lato`).url, `${CSS}/css?family=Lato`);
  assert.equal(accepted(`http://fonts.googleapis.com/css?family=Lato`).url, `${CSS}/css?family=Lato`);
  assert.equal(accepted(`https://fonts.googleapis.com:443/css?family=Lato`).url, `${CSS}/css?family=Lato`);
  assert.equal(accepted(FILE.replace("https:", "http:")).url, FILE);
  assert.equal(accepted(FILE.replace("https:", "")).url, FILE);
  assert.equal(accepted(`HTTPS://Fonts.GoogleAPIs.com/css?family=Lato`).url, `${CSS}/css?family=Lato`);
});

test("gstatic /s/ files are accepted for every allowed extension, including CJK slice names", () => {
  for (const extension of ["woff2", "woff", "ttf", "otf"]) {
    const url = `https://fonts.gstatic.com/s/opensans/v44/memQYaGs126MiZpBA-UFUIcVXSCE.${extension}`;
    const result = accepted(url);
    assert.equal(result.kind, "font");
    assert.equal(result.url, url);
  }
  accepted("https://fonts.gstatic.com/s/mplusrounded1c/v22/VdGBAYIAV6gnpUpoWwNkYvrugw9RuM064ZsPrfqk33YqOjLBxkUhdkeuqyIMwGYkDA.0.woff2");
});

test("non-https schemes, credentials and other ports are rejected", () => {
  rejected(`ftp://fonts.googleapis.com/css?family=Lato`, "FONT_UNSUPPORTED", "scheme");
  rejected(`javascript:alert(1)//fonts.googleapis.com/css?family=Lato`, "FONT_UNSUPPORTED", "scheme");
  rejected(`https://fonts.googleapis.com:8443/css?family=Lato`, "FONT_UNSUPPORTED", "port");
  rejected(`http://fonts.googleapis.com:8080/css?family=Lato`, "FONT_UNSUPPORTED", "port");
  rejected(`https://user:pass@fonts.googleapis.com/css?family=Lato`, "FONT_UNSUPPORTED", "credentials");
  rejected(`https://user@fonts.gstatic.com${new URL(FILE).pathname}`, "FONT_UNSUPPORTED", "credentials");
  rejected(`not a url`, "FONT_UNSUPPORTED", "parse");
  rejected(`/css?family=Lato`, "FONT_UNSUPPORTED", "parse");
});

test("host tricks are rejected", () => {
  for (const input of [
    `https://fonts.googleapis.com.example.com/css?family=Lato`,
    `https://example.com/fonts.googleapis.com/css?family=Lato`,
    `https://evil.fonts.googleapis.com/css?family=Lato`,
    `https://fonts.googleapis.com./css?family=Lato`,
    `https://fonts.gstatic.com.example.com${new URL(FILE).pathname}`,
    `https://example.com@evil.test/css?family=Lato`
  ]) {
    const result = canonicalGoogleFontsUrl(input);
    assert.equal(result.ok, false, input);
    assert.equal(result.code, "FONT_UNSUPPORTED", input);
  }
  rejected(`https://fonts.googleapis.com.example.com/css?family=Lato`, "FONT_UNSUPPORTED", "host");
  rejected(`https://example.com/fonts.googleapis.com/css?family=Lato`, "FONT_UNSUPPORTED", "host");
  assert.equal(isGoogleFontsHost("fonts.googleapis.com"), true);
  assert.equal(isGoogleFontsHost("fonts.gstatic.com"), true);
  assert.equal(isGoogleFontsHost("fonts.googleapis.com.example.com"), false);
});

test("/icon, text= and paths outside the allowlist are unsupported", () => {
  rejected(`${CSS}/icon?family=Material+Icons`, "FONT_UNSUPPORTED", "icon");
  rejected(`${CSS}/css2?family=Lato&text=Hello`, "FONT_UNSUPPORTED", "text");
  rejected(`https://fonts.gstatic.com/l/font?kit=abc&skey=def&v=v1`, "FONT_UNSUPPORTED", "text");
  rejected(`${CSS}/css3?family=Lato`, "FONT_UNSUPPORTED", "path");
  rejected(`${CSS}/css/?family=Lato`, "FONT_UNSUPPORTED", "path");
  rejected(`${CSS}/`, "FONT_UNSUPPORTED", "path");
  rejected(`https://fonts.gstatic.com/other/roboto/v48/file.woff2`, "FONT_UNSUPPORTED", "path");
  rejected(`https://fonts.gstatic.com/s/roboto/v48/file.svg`, "FONT_UNSUPPORTED", "path");
  rejected(`https://fonts.gstatic.com/s/roboto/latest/file.woff2`, "FONT_UNSUPPORTED", "path");
  rejected(`https://fonts.gstatic.com/s/roboto/v48/sub/file.woff2`, "FONT_UNSUPPORTED", "path");
  rejected(`https://fonts.gstatic.com/s/Roboto/v48/file.woff2`, "FONT_UNSUPPORTED", "path");
  rejected(`${FILE}?v=1`, "FONT_UNSUPPORTED", "query");
});

test("URLs over 2 KB and more than 20 families are unsupported", () => {
  const atLimit = `${CSS}/css2?family=A&display=${"x".repeat(GOOGLE_FONTS_MAX_URL_LENGTH - `${CSS}/css2?family=A&display=`.length)}`;
  assert.equal(atLimit.length, 2048);
  accepted(atLimit);
  rejected(`${atLimit}x`, "FONT_UNSUPPORTED", "length");

  const families = (count) => Array.from({length: count}, (_, index) => `F${index}`);
  accepted(`${CSS}/css2?${families(20).map((name) => `family=${name}`).join("&")}`);
  rejected(`${CSS}/css2?${families(21).map((name) => `family=${name}`).join("&")}`, "FONT_UNSUPPORTED", "families");
  accepted(`${CSS}/css?family=${families(20).join("|")}`);
  rejected(`${CSS}/css?family=${families(21).join("|")}`, "FONT_UNSUPPORTED", "families");
  rejected(`${CSS}/css?family=${families(11).join("%7C")}&family=${families(10).join("|")}`, "FONT_UNSUPPORTED", "families");
});

test("a {{field}} placeholder or a missing family is a local 400 that never reaches upstream", () => {
  const placeholder = rejected(`${CSS}/css?family={{fontName}}:400,700`, "FONT_BAD_REQUEST", "placeholder");
  assert.equal(placeholder.status, 400);
  rejected(`${CSS}/css?family=%7B%7BfontName%7D%7D`, "FONT_BAD_REQUEST", "placeholder");
  rejected(`${CSS}/css2?family=Lato&family={{second}}`, "FONT_BAD_REQUEST", "placeholder");
  const missing = rejected(`${CSS}/css2?display=swap`, "FONT_BAD_REQUEST", "family-missing");
  assert.equal(missing.status, 400);
  rejected(`${CSS}/css?family=`, "FONT_BAD_REQUEST", "family-missing");
  rejected(`${CSS}/css?family=|`, "FONT_BAD_REQUEST", "family-missing");
  assert.equal(canonicalGoogleFontsUrl(`${CSS}/css?family=Lato`).status, undefined);
});

test("familiesFromUrl understands v1 weights, italics and separators", () => {
  assert.deepEqual(familiesFromUrl(`${CSS}/css?family=Roboto:400,700italic,b,bi,i|Open+Sans%7CLato:300,regular,bold,oops`), [
    {
      name: "Roboto",
      axes: [],
      variants: [
        {italic: false, weight: [400, 400]},
        {italic: true, weight: [700, 700]},
        {italic: false, weight: [700, 700]},
        {italic: true, weight: [700, 700]},
        {italic: true, weight: [400, 400]}
      ]
    },
    {name: "Open Sans", axes: [], variants: [{italic: false, weight: [400, 400]}]},
    {
      name: "Lato",
      axes: [],
      variants: [
        {italic: false, weight: [300, 300]},
        {italic: false, weight: [400, 400]},
        {italic: false, weight: [700, 700]}
      ]
    }
  ]);
  assert.deepEqual(familiesFromUrl(`${CSS}/css?family=Press+Start+2P:400:latin`), [
    {name: "Press Start 2P", axes: [], variants: [{italic: false, weight: [400, 400]}]}
  ]);
});

test("familiesFromUrl understands css2 axes and ranges, in request order", () => {
  assert.deepEqual(
    familiesFromUrl(
      `${CSS}/css2?family=Archivo:ital,wght@0,400;1,700&family=Bricolage+Grotesque:opsz,wght@12..96,400..800&family=Inter:wght@100..900&family=Lato&family=Nunito:ital@0;1&family=Roboto+Flex:ital,wght@0..1,300`
    ),
    [
      {
        name: "Archivo",
        axes: ["ital", "wght"],
        variants: [
          {italic: false, weight: [400, 400]},
          {italic: true, weight: [700, 700]}
        ]
      },
      {name: "Bricolage Grotesque", axes: ["opsz", "wght"], variants: [{italic: false, weight: [400, 800]}]},
      {name: "Inter", axes: ["wght"], variants: [{italic: false, weight: [100, 900]}]},
      {name: "Lato", axes: [], variants: [{italic: false, weight: [400, 400]}]},
      {
        name: "Nunito",
        axes: ["ital"],
        variants: [
          {italic: false, weight: [400, 400]},
          {italic: true, weight: [400, 400]}
        ]
      },
      {
        name: "Roboto Flex",
        axes: ["ital", "wght"],
        variants: [
          {italic: false, weight: [300, 300]},
          {italic: true, weight: [300, 300]}
        ]
      }
    ]
  );
  // css2 does not treat | as a separator.
  assert.equal(familiesFromUrl(`${CSS}/css2?family=A|B`).length, 1);
});

test("familiesFromUrl returns nothing for rejected URLs and font files", () => {
  assert.deepEqual(familiesFromUrl(`${CSS}/css?family={{fontName}}`), []);
  assert.deepEqual(familiesFromUrl(`https://example.com/css?family=Lato`), []);
  assert.deepEqual(familiesFromUrl(FILE), []);
});

test("origin rules are a generic {host, pathPattern, validate} list", () => {
  assert.deepEqual(
    GOOGLE_FONTS_ORIGIN_RULES.map((rule) => [rule.host, rule.kind, typeof rule.validate, rule.pathPattern instanceof RegExp]),
    [
      ["fonts.googleapis.com", "css", "function", true],
      ["fonts.gstatic.com", "font", "function", true]
    ]
  );
  const custom = [
    {host: "cdn.example.test", pathPattern: /^\/lib\/[a-z]+\.js$/, kind: "script", validate: (url) => ({ok: true, url: url.href, dropped: []})}
  ];
  assert.equal(matchOriginRule(custom, new URL("https://cdn.example.test/lib/three.js"))?.kind, "script");
  assert.equal(matchOriginRule(custom, new URL("https://cdn.example.test/other/three.js")), undefined);
  assert.equal(matchOriginRule(custom, new URL("https://cdn.example.test.evil/lib/three.js")), undefined);
});

test("the module ships with the frame runtime and imports nothing but ../version.js", async () => {
  const compiled = await readFile(new URL("../../dist/runtime/google-fonts-url.js", import.meta.url), "utf8");
  const imports = [...compiled.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/gm)].map((match) => match[1]);
  const dynamic = [...compiled.matchAll(/\bimport\s*\(/g)];
  assert.deepEqual(imports.filter((specifier) => specifier !== "../version.js"), []);
  assert.equal(dynamic.length, 0);
  assert.doesNotMatch(compiled, /\bfetch\s*\(|XMLHttpRequest|node:/);
  // build:engine copies dist/runtime/ whole into the hosted preview's engine path.
  assert.ok((await stat(new URL("../../public/engine/runtime/google-fonts-url.js", import.meta.url))).isFile());
});
