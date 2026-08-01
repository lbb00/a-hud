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
// A table header's key path is a dot-separated sequence of segments, each
// either bare or quoted — and a *quoted* segment (`"other]table"`) may
// contain characters like "]" or "." that would otherwise look like the
// end of the header or a path separator. Naively matching "everything up
// to the first ]" (the previous `[^\]]+`) breaks on such a segment: it
// would stop at the "]" *inside* the quotes, misreading the true end of
// the table's body and silently deleting whatever lines actually belong to
// the table that follows.
const TOML_KEY_SEGMENT = `(?:"(?:[^"\\\\]|\\\\.)*"|'[^']*'|[^"'\\]. ]+)`;
const TABLE_RE = new RegExp(
  `^\\s*\\[\\[?\\s*${TOML_KEY_SEGMENT}(?:\\s*\\.\\s*${TOML_KEY_SEGMENT})*\\s*\\]\\]?\\s*(?:#.*)?$`,
);

// TOML keys may be quoted (`"status_line" = [...]` or `'status_line' = [...]`)
// as well as bare. Strips one matching pair of surrounding quotes so a
// hand-quoted key still matches TUI_KEYS — otherwise it'd be left in `kept`
// alongside the newly written unquoted key, producing a duplicate-key TOML
// document (invalid — smol-toml, and Codex's own TOML parser, both reject
// "trying to redefine an already defined ... value"). This is a literal
// quote-stripping match, not full TOML string decoding: a basic-string key
// spelled with a backslash escape sequence that decodes to one of
// TUI_KEYS still won't match this literal comparison. Like triple-quoted
// strings elsewhere in this file, that's an
// accepted, undocumented-in-practice gap — this project's own writer only
// ever produces plain bare keys, and no realistic hand-edit uses a Unicode
// escape to spell an ASCII identifier.
function normalizeTomlKey(key) {
  if (key.length >= 2 && ((key[0] === '"' && key.at(-1) === '"') || (key[0] === "'" && key.at(-1) === "'"))) {
    return key.slice(1, -1);
  }
  return key;
}

function tomlValue(value) {
  return Array.isArray(value)
    ? `[${value.map((item) => JSON.stringify(item)).join(", ")}]`
    : String(value);
}

// Counts net bracket depth in a line (each unquoted "[" is +1, each
// unquoted "]" is -1), stopping at an unquoted "#" (a real TOML comment).
// Tracks whether we're currently inside a TOML basic string (") or literal
// string (') so a literal "#", "[", or "]" *value* — e.g.
// `status_line = ["model", "#"]` — isn't mistaken for a comment marker or
// counted as a bracket. Basic strings support backslash-escaping (so `\"`
// doesn't end the string); literal strings don't. Triple-quoted
// (multi-line) strings are intentionally not handled: this project's own
// TOML writer never produces them, so that's an accepted, undocumented gap
// rather than something worth the extra complexity here.
function bracketDelta(text) {
  const withoutComment = text.split("#")[0];
  let delta = 0;
  let quote = null; // '"' or "'" while inside a string, else null
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (char === "\\" && quote === '"') {
        i += 1; // skip the escaped character (basic strings only)
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#") break;
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
  // TOML lets the root table define `tui` without a `[tui]` header at all:
  // as an inline table (`tui = { status_line = [...], ... }`), a quoted
  // key (`"tui" = { ... }`), or dotted keys (`tui.status_line = [...]`).
  // Detecting one of those as "[tui] already exists" and safely rewriting
  // it would need real TOML value parsing (matching balanced braces,
  // respecting quoted strings that might contain "}", decoding dotted-key
  // paths), which this line-oriented rewriter doesn't do — and blindly
  // appending a `[tui]` table header below would leave BOTH definitions in
  // the file, which is invalid TOML (a redefined table). Refuse instead of
  // writing something broken.
  //
  // Only the ROOT table's lines count: a `tui = { ... }` (or `tui.x = `)
  // line can only define a *root*-level `tui` when it appears before the
  // first `[section]` header — the same line appearing after, say, an
  // `[other]` header defines `other.tui`, a different, unrelated key that
  // this rewriter must leave completely alone.
  const firstHeaderIndex = lines.findIndex((line) => /^\s*\[/.test(line));
  const rootLines = firstHeaderIndex < 0 ? lines : lines.slice(0, firstHeaderIndex);
  const ROOT_TUI_RE = /^\s*(?:tui|"tui"|'tui')\s*(?:=\s*\{|\.)/;
  if (rootLines.some((line) => ROOT_TUI_RE.test(line))) {
    throw new Error(
      "config.toml defines the root-level tui key without a [tui] table header " +
        "(inline table, or dotted keys); ahud can't safely rewrite that form — " +
        "convert it to a [tui] table first",
    );
  }
  // A TOML table header's name may be bare (`[tui]`) or quoted (`["tui"]` /
  // `['tui']`) — all three spell the same table. Missing the quoted forms
  // would append a second `[tui]` header, producing invalid TOML (a
  // duplicate table definition).
  const index = lines.findIndex((line) => /^\s*\[\s*(?:tui|"tui"|'tui')\s*\]\s*(?:#.*)?$/.test(line));

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
    const key = eqIndex >= 0 ? normalizeTomlKey(trimmed.slice(0, eqIndex).trim()) : trimmed;
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
  // A JSON array parses without error but silently drops any non-index
  // property (like statusLine) when re-stringified, so a bare array
  // settings.json would otherwise round-trip byte-for-byte unchanged —
  // writeWithBackup would then see content === original and report
  // "already configured" despite statusLine never actually being set.
  if (Array.isArray(parsed) || typeof parsed !== "object" || parsed === null) {
    throw new Error("Claude settings file must be a JSON object");
  }
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
