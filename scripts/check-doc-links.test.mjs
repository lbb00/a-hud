import assert from "node:assert/strict";
import test from "node:test";
import { markdownTableErrors } from "./check-doc-links.mjs";

test("accepts escaped table punctuation inside code", () => {
  const markdown = [
    "| Token | Meaning |",
    "| --- | --- |",
    "| ` \\| ` | separator |",
  ].join("\n");

  assert.deepEqual(markdownTableErrors(markdown), []);
});

test("rejects an unescaped pipe that creates an extra table column", () => {
  const markdown = [
    "| Token | Meaning |",
    "| --- | --- |",
    "| ` | ` | separator |",
  ].join("\n");

  assert.deepEqual(markdownTableErrors(markdown), [
    "line 3: expected 2 table columns, found 3",
  ]);
});
