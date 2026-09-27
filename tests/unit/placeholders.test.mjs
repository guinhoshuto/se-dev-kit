import assert from "node:assert/strict";
import test from "node:test";

import {
  hasPlaceholder,
  htmlRefusals,
  introducedHtmlRefusals,
  substitutePlaceholders
} from "../../dist/config/placeholders.js";

test("substitutePlaceholders replaces {{name}} with or without inner spaces", () => {
  const {text, missing} = substitutePlaceholders("a{{title}}b{{ title }}c{{  title}}d", {title: "X"});
  assert.equal(text, "aXbXcXd");
  assert.deepEqual(missing, []);
});

test("every occurrence is replaced, and ids keep dots and dashes as literal keys", () => {
  const {text} = substitutePlaceholders("{{a}}-{{a}}-{{a}} {{b.c}} {{d-e}}", {a: "1", "b.c": "dot", "d-e": "dash", b: {c: "nested"}});
  assert.equal(text, "1-1-1 dot dash");
});

test("numbers, booleans, null, and arrays become raw text", () => {
  const {text} = substitutePlaceholders("{{n}}|{{f}}|{{t}}|{{z}}|{{list}}|{{zero}}", {n: 12.5, f: false, t: true, z: null, list: ["a", 1], zero: 0});
  assert.equal(text, "12.5|false|true||[\"a\",1]|0");
});

test("a placeholder with no field stays intact and is reported once, including inherited object keys", () => {
  const {text, missing} = substitutePlaceholders("{{gone}} {{gone}} {{constructor}} {{toString}} {{kept}}", {kept: "ok"});
  assert.equal(text, "{{gone}} {{gone}} {{constructor}} {{toString}} ok");
  assert.deepEqual(missing, ["gone", "constructor", "toString"]);
});

test("substitution is one pass: a value holding {{…}} is never expanded", () => {
  const {text, missing} = substitutePlaceholders("{{a}} {{b}}", {a: "{{b}}", b: "{{a}}"});
  assert.equal(text, "{{b}} {{a}}");
  assert.deepEqual(missing, []);
});

test("hasPlaceholder matches only the StreamElements token shape", () => {
  assert.equal(hasPlaceholder("https://fonts.googleapis.com/css?family={{fontName}}:400"), true);
  assert.equal(hasPlaceholder("{{ spaced }}"), true);
  for (const text of ["{{}}", "{{a b}}", "{ {a} }", "{{a/b}}", "plain"]) assert.equal(hasPlaceholder(text), false, text);
});

test("HTML refusals match the importer, and only refusals a value introduced count after substitution", () => {
  assert.deepEqual(htmlRefusals('<meta http-equiv="refresh" content="0;url=https://example.com"><base href="/"><iframe></iframe><object></object><embed><img onerror="x">'), [
    "Unsupported embedded or document-control element: meta",
    "Unsupported embedded or document-control element: base",
    "Unsupported embedded or document-control element: iframe",
    "Unsupported embedded or document-control element: object",
    "Unsupported embedded or document-control element: embed",
    "Inline HTML event handlers are unsupported. Register listeners in widget JavaScript after runtime initialization."
  ]);
  assert.deepEqual(htmlRefusals('<meta charset="utf-8"><div title="{{x}}">ok</div>'), []);
  // The local CLI accepts inline handlers in source; one more handler from a value is still refused.
  const source = '<button onclick="go()">{{label}}</button>';
  assert.deepEqual(introducedHtmlRefusals(source, source.replace("{{label}}", "Go")), []);
  assert.deepEqual(introducedHtmlRefusals(source, source.replace("{{label}}", '<img src=x onerror="steal()">')), [
    "Inline HTML event handlers are unsupported. Register listeners in widget JavaScript after runtime initialization."
  ]);
  assert.deepEqual(introducedHtmlRefusals("<div>{{v}}</div>", '<div><meta http-equiv="refresh" content="0"></div>'), [
    "Unsupported embedded or document-control element: meta"
  ]);
});
