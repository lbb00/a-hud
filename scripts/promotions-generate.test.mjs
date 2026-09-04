import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { OUTPUT_PATH, readSourceDocument, renderModule } from "./generate-promotions.mjs";

const CLOCK_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const PLATFORMS = ["claude", "codex", "cursor", "antigravity"];

test("the bundled promotions module matches promotions.json", async () => {
  assert.equal(
    await fs.readFile(OUTPUT_PATH, "utf8"),
    renderModule(await readSourceDocument()),
    "run `npm run promotions:generate` after editing packages/provider/promotions.json",
  );
});

test("a __proto__ key in the schedule is refused instead of generated", () => {
  // The generated module is a JS object literal, where this key would set the
  // prototype rather than become a field: the bundled copy would then behave
  // differently from the same bytes fetched at runtime.
  const document = JSON.parse('{"promotions":[],"__proto__":{"promotions":["x"]}}');
  assert.throws(() => renderModule(document), /__proto__/);
  assert.throws(
    () => renderModule({ promotions: [JSON.parse('{"__proto__":{"id":"x"}}')] }),
    /__proto__/,
  );
});

test("every shared window carries the fields the HUD needs", async () => {
  const document = await readSourceDocument();
  assert.equal(typeof document.version, "number");
  assert.match(document.updated, DATE_PATTERN);
  assert.ok(Array.isArray(document.promotions));
  for (const window of document.promotions) {
    // A window the runtime normalizer would drop shows up as no badge at all,
    // with nothing to explain it, so reject it while it is still reviewable.
    assert.equal(typeof window.id, "string", `${JSON.stringify(window)} needs an id`);
    assert.ok(window.id, "id must not be empty");
    assert.match(window.start, CLOCK_PATTERN);
    assert.match(window.end, CLOCK_PATTERN);
    if (window.from !== undefined) assert.match(window.from, DATE_PATTERN);
    if (window.until !== undefined) assert.match(window.until, DATE_PATTERN);
    // A misspelled zone, weekday or host name is the dangerous kind of typo:
    // review reads it as a narrower window than the runtime can honor.
    if (window.timezone !== undefined) {
      assert.doesNotThrow(
        () => new Intl.DateTimeFormat("en-US", { timeZone: window.timezone }),
        `unknown timezone ${window.timezone}`,
      );
    }
    if (window.days !== undefined) {
      assert.ok(Array.isArray(window.days) && window.days.length, "days must be a list");
      for (const day of window.days) {
        const named = typeof day === "string" && WEEKDAYS.includes(day.slice(0, 3).toLowerCase());
        const numbered = Number.isInteger(day) && day >= 0 && day <= 6;
        assert.ok(named || numbered, `${JSON.stringify(day)} is not a weekday`);
      }
    }
    if (window.platforms !== undefined) {
      assert.ok(
        Array.isArray(window.platforms) && window.platforms.length,
        "platforms must be a list",
      );
      for (const platform of window.platforms) {
        assert.ok(PLATFORMS.includes(platform), `${platform} is not a supported host`);
      }
    }
  }
  const ids = document.promotions.map((window) => window.id);
  assert.equal(new Set(ids).size, ids.length, "shared window ids must be unique");
});
