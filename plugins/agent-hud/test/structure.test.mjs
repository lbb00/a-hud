import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = path.resolve(pluginRoot, "../..");
const MAX_MAINTAINED_LINES = 500;
const IGNORED_DIRECTORIES = new Set([".git", ".codegraph", "coverage", "dist", "node_modules"]);
const IGNORED_FILES = new Set(["package-lock.json"]);

async function maintainedFiles(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".DS_") || IGNORED_FILES.has(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) {
        files.push(...(await maintainedFiles(entryPath)));
      }
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

function lineCount(text) {
  if (text.length === 0) return 0;
  return text.split(/\r?\n/u).length - (text.endsWith("\n") ? 1 : 0);
}

test("keeps maintained files within the 500-line responsibility boundary", async () => {
  const files = await maintainedFiles(workspaceRoot);
  const oversized = [];

  for (const file of files) {
    const contents = await fs.readFile(file, "utf8");
    const lines = lineCount(contents);
    if (lines > MAX_MAINTAINED_LINES) {
      oversized.push(`${path.relative(workspaceRoot, file)} (${lines} lines)`);
    }
  }

  assert.deepEqual(
    oversized,
    [],
    `Split files by responsibility before they exceed ${MAX_MAINTAINED_LINES} lines:\n${oversized.join("\n")}`,
  );
});
