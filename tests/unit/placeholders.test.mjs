import assert from "node:assert/strict";
import test from "node:test";

import {
  hasPlaceholder,
  htmlRefusals,
  introducedHtmlRefusals,
  substitutePlaceholders
} from "../../dist/config/placeholders.js";

// The rule StreamElements' overlay applies to a custom widget's HTML, CSS and JS (its public overlay
// bundle, read on 2026-10-28): {{name}} first, then {name} over the result, word names only.
test("substitutePlaceholders fills {{name}} only without inner spaces, dots or dashes, like StreamElements", () => {
  const {text, missing} = substitutePlaceholders("a{{title}}b{{ title }}c{{  title}}d {{b.c}} {{d-e}}", {title: "X", "b.c": "dot", "d-e": "dash"});
  assert.equal(text, "aXb{{ title }}c{{  title}}d {{b.c}} {{d-e}}");
  assert.deepEqual(missing, []);
});

test("every occurrence of {{name}} and {name} is filled", () => {
  const {text} = substitutePlaceholders("{{a}}-{{a}}-{a}-{a} {{a_1}}{a_1}", {a: "1", a_1: "u"});
  assert.equal(text, "1-1-1-1 uu");
});

test("values become text as JavaScript's String() makes it", () => {
  const {text} = substitutePlaceholders("{{n}}|{{f}}|{{t}}|{{z}}|{{list}}|{{zero}}|{{object}}|{list}|{z}", {n: 12.5, f: false, t: true, z: null, list: ["a", 1], zero: 0, object: {a: 1}});
  assert.equal(text, "12.5|false|true|null|a,1|0|[object Object]|a,1|null");
});

test("a single-brace {name} is filled when name is a field, in plain code and inside ${name}", () => {
  const js = "const aniLetter = {animatedLetters} ? true : false;\nif({shadow}) x.style.background = `linear-gradient({gradientAngle}deg, {backgroundColor}${getHexOpacity({backgroundOpacity})} 30%)`;\nel.style.color = `${fontColor}`;";
  const {text, missing} = substitutePlaceholders(js, {animatedLetters: true, shadow: false, gradientAngle: 57, backgroundColor: "#fefdfd", backgroundOpacity: 100, fontColor: "rgb(242, 242, 242)"});
  assert.equal(text, "const aniLetter = true ? true : false;\nif(false) x.style.background = `linear-gradient(57deg, #fefdfd${getHexOpacity(100)} 30%)`;\nel.style.color = `$rgb(242, 242, 242)`;");
  assert.deepEqual(missing, []);
});

test("{{name}} is filled before {name}: the double braces never keep a pair around the value", () => {
  assert.equal(substitutePlaceholders("{{x}} {x}", {x: "1"}).text, "1 1");
});

test("a placeholder with no field stays intact; only {{name}} is reported, once, including inherited object keys", () => {
  const {text, missing} = substitutePlaceholders("{{gone}} {{gone}} {{constructor}} {{toString}} {{kept}} {{}} {gone} {constructor} {} { kept } if(a){return}", {kept: "ok"});
  assert.equal(text, "{{gone}} {{gone}} {{constructor}} {{toString}} ok {{}} {gone} {constructor} {} { kept } if(a){return}");
  assert.deepEqual(missing, ["gone", "constructor", "toString"]);
});

test("the second pass fills a {name} that a {{name}} value brought, and neither pass fills its own output again", () => {
  assert.equal(substitutePlaceholders("{{label}}", {label: "Hi {name}", name: "Ana"}).text, "Hi Ana");
  assert.equal(substitutePlaceholders("{{a}} {{b}}", {a: "{{b}}", b: "{{a}}"}).text, "{{{a}}} {{{b}}}");
  assert.equal(substitutePlaceholders("{a}", {a: "{b}", b: "x"}).text, "{b}");
});

test("hasPlaceholder matches only what StreamElements may fill", () => {
  for (const text of ["https://fonts.googleapis.com/css?family={{fontName}}:400", "https://fonts.googleapis.com/css?family={fontName}:400", "{{}}{a}"]) assert.equal(hasPlaceholder(text), true, text);
  for (const text of ["{{}}", "{}", "{{ spaced }}", "{ a }", "{{a b}}", "{a.b}", "{{a/b}}", "plain"]) assert.equal(hasPlaceholder(text), false, text);
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
