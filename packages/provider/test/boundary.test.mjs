import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("provider source contains facts and lifecycle only, never UI policy", async () => {
  const sourceNames = await fs.readdir(path.join(root, "src"));
  const source = (await Promise.all(
    sourceNames.filter((name) => name.endsWith(".ts"))
      .map((name) => fs.readFile(path.join(root, "src", name), "utf8")),
  )).join("\n");

  assert.doesNotMatch(source, /HUD_DESIGN|renderSnapshot|compactAdvisor|modelSeverity/);
  assert.doesNotMatch(source, /const PALETTE|function paint|ANSI_RE|formatReset/);
  assert.doesNotMatch(source, /"█"|"░"|"→~"|"↓~"|"\\*cold"/);
  assert.doesNotMatch(source, /plugins\/agent-hud|\.\.\/\.\.\/plugins/);
});
