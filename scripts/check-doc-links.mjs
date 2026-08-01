import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const ignoredDirectories = new Set([
  ".git",
  ".codegraph",
  "dist",
  "node_modules",
]);

async function markdownFiles(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await markdownFiles(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(entryPath);
    }
  }
  return files;
}

function localTarget(rawTarget) {
  const target = rawTarget.trim().replace(/^<|>$/gu, "");
  if (
    !target ||
    target.startsWith("#") ||
    target.startsWith("/") ||
    /^[a-z][a-z+.-]*:/iu.test(target)
  ) {
    return null;
  }
  const withoutTitle = target.split(/\s+["']/u, 1)[0];
  return decodeURIComponent(withoutTitle.split("#", 1)[0]);
}

function lineAt(text, offset) {
  return text.slice(0, offset).split("\n").length;
}

function unescapedPipeCount(line) {
  let count = 0;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== "|") continue;
    let backslashes = 0;
    for (
      let before = index - 1;
      before >= 0 && line[before] === "\\";
      before -= 1
    ) {
      backslashes += 1;
    }
    if (backslashes % 2 === 0) count += 1;
  }
  return count;
}

function isTableDelimiter(line) {
  return /^\|(?:\s*:?-{3,}:?\s*\|)+$/u.test(line.trim());
}

export function markdownTableErrors(contents) {
  const lines = contents.split("\n");
  const errors = [];
  for (let index = 1; index < lines.length; index += 1) {
    if (!isTableDelimiter(lines[index])) continue;
    const expected = unescapedPipeCount(lines[index]) - 1;
    const rows = [[index - 1, lines[index - 1]]];
    for (
      let row = index + 1;
      row < lines.length &&
      lines[row].trimStart().startsWith("|") &&
      lines[row].trimEnd().endsWith("|");
      row += 1
    ) {
      rows.push([row, lines[row]]);
    }
    for (const [row, line] of rows) {
      const actual = unescapedPipeCount(line) - 1;
      if (actual !== expected) {
        errors.push(
          `line ${row + 1}: expected ${expected} table columns, found ${actual}`,
        );
      }
    }
  }
  return errors;
}

async function main() {
  const problems = [];
  for (const file of await markdownFiles(workspaceRoot)) {
    const contents = await fs.readFile(file, "utf8");
    const relativeFile = path.relative(workspaceRoot, file);
    for (const error of markdownTableErrors(contents)) {
      problems.push(`${relativeFile}:${error}`);
    }
    const links = contents.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu);
    for (const match of links) {
      const target = localTarget(match[1]);
      if (!target) continue;
      const resolved = path.resolve(path.dirname(file), target);
      try {
        await fs.access(resolved);
      } catch {
        problems.push(
          `${relativeFile}:${lineAt(contents, match.index)} -> missing ${target}`,
        );
      }
    }
  }

  assert.deepEqual(
    problems,
    [],
    `Markdown documentation errors:\n${problems.join("\n")}`,
  );
  process.stdout.write("Documentation structure and links passed\n");
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
