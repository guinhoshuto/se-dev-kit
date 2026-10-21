import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

// The skill sends its reader to a reference section, not to the whole file: on 2026-10-15 a session read
// studio-workflow.md (23 KB) whole with `cat` because SKILL.md linked the bare file, and the large reads
// took repository sessions past 300k tokens of context in 20 to 38 minutes (HAR-181).
const skill = resolve(import.meta.dirname, "../../skills/se-widget-studio");
const SMALL = 16384; // the "~16 KB" above which a file is read by section; only a file this small may be linked whole

const slug = (heading) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");

const headings = (file) => {
  const text = readFileSync(join(skill, file), "utf8").replace(/^```[\s\S]*?^```/gm, "");
  return [...text.matchAll(/^(#{1,6})\s+(.+)$/gm)].map(([, marks, title]) => ({ level: marks.length, anchor: slug(title) }));
};

const links = () =>
  [...readFileSync(join(skill, "SKILL.md"), "utf8").matchAll(/\]\((references\/[^)#\s]+)(?:#([^)\s]*))?\)/g)].map(
    ([, file, anchor]) => ({ file, anchor })
  );

test("every reference link in SKILL.md names a section that exists", () => {
  const found = links();
  assert.ok(found.length >= 10, `only ${found.length} reference links`);
  for (const { file, anchor } of found) {
    assert.ok(anchor, `${file} is linked without a section`);
    const target = headings(file).find((heading) => heading.anchor === anchor);
    assert.ok(target, `${file}#${anchor} is not a heading of ${file}`);
    if (target.level === 1) {
      const size = statSync(join(skill, file)).size;
      assert.ok(size <= SMALL, `${file} (${size} bytes) is linked whole, by its title`);
    }
  }
});

test("every reference file is linked from SKILL.md", () => {
  const linked = new Set(links().map(({ file }) => file));
  for (const name of readdirSync(join(skill, "references")).filter((entry) => entry.endsWith(".md"))) {
    assert.ok(linked.has(`references/${name}`), `references/${name} is never linked`);
  }
});

test("the anchors follow the headings", () => {
  assert.equal(slug("Hosted deployment (paused)"), "hosted-deployment-paused");
  assert.equal(slug("Develop SE Widget Studio itself"), "develop-se-widget-studio-itself");
  assert.equal(slug("Auto zoom"), "auto-zoom");
  assert.deepEqual(
    headings("references/known-limits.md").map(({ anchor }) => anchor),
    ["known-limits", "capture", "tests", "video", "machine"]
  );
});
