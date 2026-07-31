import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configPathFor, loadConfig, writeConfigPatch } from "./config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PATH = path.join(ROOT, "src", "cli.mjs");

export const CODEX_PRESETS = {
  compact: {
    status_line: [
      "model-with-reasoning",
      "context-used",
      "five-hour-limit",
      "git-branch",
      "branch-changes",
    ],
    terminal_title: ["spinner", "project", "git-branch"],
  },
  balanced: {
    status_line: [
      "model-with-reasoning",
      "context-used",
      "five-hour-limit",
      "weekly-limit",
      "permissions",
      "approval-mode",
      "git-branch",
      "branch-changes",
      "current-dir",
      "task-progress",
    ],
    terminal_title: ["spinner", "project", "git-branch", "model", "task-progress"],
  },
  full: {
    status_line: [
      "model-with-reasoning",
      "context-used",
      "context-remaining",
      "context-window-size",
      "five-hour-limit",
      "weekly-limit",
      "permissions",
      "approval-mode",
      "git-branch",
      "branch-changes",
      "current-dir",
      "task-progress",
      "used-tokens",
      "session-id",
    ],
    terminal_title: ["spinner", "project", "git-branch", "model", "task-progress"],
  },
};

const TUI_KEYS = new Set(["status_line", "status_line_use_colors", "terminal_title"]);
const TABLE_RE = /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/;

function tomlValue(value) {
  return Array.isArray(value)
    ? `[${value.map((item) => JSON.stringify(item)).join(", ")}]`
    : String(value);
}

// Counts net bracket depth in a line (each "[" is +1, each "]" is -1). This
// project's own TOML output only ever contains simple string array elements
// (no nested arrays, no inline comments), so a naive per-character count is
// enough to track whether an array value opened on this line has closed yet.
function bracketDelta(text) {
  let delta = 0;
  for (const char of text) {
    if (char === "[") delta += 1;
    else if (char === "]") delta -= 1;
  }
  return delta;
}

// Resolves the { status_line, terminal_title } fields to write into the
// Codex [tui] table, following a three-state precedence:
//   1. An explicit `preset` name always wins (source: "preset").
//   2. Otherwise, a previously saved ~/.ahud/config.json codex preference is
//      used, field by field, falling back to the "balanced" preset's value
//      for whichever field wasn't saved (source: "config").
//   3. Otherwise, the "balanced" preset in full (source: "default").
export function resolveCodexFields(preset, config) {
  if (preset != null) {
    const fields = CODEX_PRESETS[preset];
    if (!fields) throw new Error(`Unknown Codex preset: ${preset}`);
    return { fields: structuredClone(fields), source: "preset" };
  }

  const saved = config?.codex || {};
  if (saved.status_line || saved.terminal_title) {
    return {
      fields: {
        status_line: saved.status_line || structuredClone(CODEX_PRESETS.balanced.status_line),
        terminal_title: saved.terminal_title || structuredClone(CODEX_PRESETS.balanced.terminal_title),
      },
      source: "config",
    };
  }

  return { fields: structuredClone(CODEX_PRESETS.balanced), source: "default" };
}

export function patchCodexConfig(text, fields) {
  const values = { ...fields, status_line_use_colors: true };
  const block = Object.entries(values).map(([key, value]) => `${key} = ${tomlValue(value)}`);
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex((line) => /^\s*\[tui\]\s*(?:#.*)?$/.test(line));

  if (index < 0) {
    const childIndex = lines.findIndex((line) => /^\s*\[\[?tui\./.test(line));
    const insertAt = childIndex >= 0 ? childIndex : lines.length;
    const before = lines.slice(0, insertAt);
    const after = lines.slice(insertAt);
    if (before.length && before.at(-1) !== "") before.push("");
    return [...before, "[tui]", ...block, "", ...after].join("\n");
  }

  let end = index + 1;
  while (end < lines.length && !TABLE_RE.test(lines[end])) end += 1;

  const kept = [];
  for (let i = index + 1; i < end; ) {
    const line = lines[i];
    const trimmed = line.trim();
    const eqIndex = trimmed.indexOf("=");
    const key = eqIndex >= 0 ? trimmed.slice(0, eqIndex).trim() : trimmed;
    if (TUI_KEYS.has(key)) {
      // Skip this key's line, and if its value is an array that spans
      // multiple lines (bracket not closed on this line), skip the
      // continuation lines too until the brackets balance out.
      let depth = bracketDelta(eqIndex >= 0 ? trimmed.slice(eqIndex + 1) : trimmed);
      i += 1;
      while (depth > 0 && i < end) {
        depth += bracketDelta(lines[i]);
        i += 1;
      }
      continue;
    }
    kept.push(line);
    i += 1;
  }
  while (kept.length && !kept[0].trim()) kept.shift();
  const section = [lines[index], ...block, ...(kept.length ? ["", ...kept] : [])];
  return [...lines.slice(0, index), ...section, ...lines.slice(end)].join("\n");
}

// Wraps `value` in single quotes for safe use as one POSIX shell word,
// escaping embedded single quotes with the standard '\'' trick (close the
// quote, emit an escaped single quote, reopen the quote). This intentionally
// prevents the shell from expanding `$VARS`, backticks, or `$(...)` inside
// paths — unlike JSON.stringify, which produces a double-quoted string the
// shell will still interpolate.
export function posixQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

export function patchClaudeSettings(text, options = {}) {
  const { executable = process.execPath, cliPath = CLI_PATH, refreshInterval = 5 } = options;
  const parsed = text.trim() ? JSON.parse(text) : {};
  parsed.statusLine = {
    type: "command",
    command: `${posixQuote(executable)} ${posixQuote(cliPath)} statusline`,
    refreshInterval,
  };
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

async function writeWithBackup(filePath, content, dryRun) {
  let original = "";
  try {
    original = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (content === original) return { changed: false, backup: null, content };
  if (dryRun) return { changed: true, backup: null, content };

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  let backup = null;
  if (original) {
    backup = `${filePath}.bak-ahud-${new Date().toISOString().replace(/\D/g, "")}`;
    await fs.copyFile(filePath, backup);
  }
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, filePath);
  return { changed: true, backup, content };
}

export async function setupCodex(options = {}) {
  const filePath = options.config ||
    path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml");
  let original = "";
  try {
    original = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const { config } = await loadConfig({ home: options.home });
  const { fields, source: fieldsSource } = resolveCodexFields(options.preset ?? null, config);
  const content = patchCodexConfig(original, fields);
  const hostResult = await writeWithBackup(filePath, content, options.dryRun);

  let ahudConfig = null;
  if (fieldsSource === "preset") {
    try {
      ahudConfig = await writeConfigPatch({ codex: fields }, { home: options.home, dryRun: options.dryRun });
    } catch (error) {
      if (error.code !== "AHUD_CONFIG_INVALID") throw error;
      ahudConfig = null;
      process.stderr.write(
        `ahud: warning: could not save preset to ${configPathFor(options.home)} (invalid JSON); fix or delete the file\n`,
      );
    }
  }

  return { filePath, ...hostResult, fieldsSource, ahudConfig };
}

export async function setupClaude(options = {}) {
  const root = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const filePath = options.config || path.join(root, "settings.json");
  let original = "";
  try {
    original = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const { config } = await loadConfig({ home: options.home });
  const content = patchClaudeSettings(original, {
    executable: options.executable,
    cliPath: options.cliPath,
    refreshInterval: config.claude.refreshInterval,
  });
  return { filePath, ...(await writeWithBackup(filePath, content, options.dryRun)) };
}
