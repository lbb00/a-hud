import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PATH = path.join(ROOT, "dist", "cli.js");

export const CODEX_PRESETS = {
  compact: {
    status_line: [
      "model-with-reasoning",
      "context-used",
      "git-branch",
      "branch-changes",
    ],
    terminal_title: ["spinner", "project", "git-branch"],
  },
  balanced: {
    status_line: [
      "model-with-reasoning",
      "used-tokens",
      "context-used",
      "weekly-limit",
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

type CodexPresetName = keyof typeof CODEX_PRESETS;

interface SetupOptions {
  config?: string;
  hooksConfig?: string;
  dryRun?: boolean;
  preset?: string;
  executable?: string;
  cliPath?: string;
}

interface WriteResult {
  changed: boolean;
  backup: string | null;
  content: string;
}

function tomlValue(value: string[] | boolean): string {
  return Array.isArray(value)
    ? `[${value.map((item) => JSON.stringify(item)).join(", ")}]`
    : String(value);
}

function parseJsonObject(text: string): Record<string, any> {
  const parsed = text.trim() ? JSON.parse(text) : {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("configuration root must be a JSON object");
  }
  return parsed;
}

function commandFor(
  subcommand: string,
  executable = process.execPath,
  cliPath = CLI_PATH,
  platform = process.platform,
): string {
  const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
  if (platform !== "win32") {
    return `${shellQuote(executable)} ${shellQuote(cliPath)} ${subcommand}`;
  }

  // cmd.exe expands %, ! and metacharacters even around otherwise useful
  // quotes. Keep all untrusted path bytes inside an encoded PowerShell script
  // instead of trying to reproduce cmd's multiple parse phases.
  const powerShellQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const script = `& ${powerShellQuote(executable)} ${powerShellQuote(cliPath)} ${subcommand}`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}

function bracketDelta(value: string): number {
  let delta = 0;
  let quote = "";
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote === "\"") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
    } else if (character === "[") {
      delta += 1;
    } else if (character === "]") {
      delta -= 1;
    } else if (character === "#") {
      break;
    }
  }
  return delta;
}

function withoutManagedTuiKeys(lines: string[]): string[] {
  const kept: string[] = [];
  let continuationDepth = 0;
  for (const line of lines) {
    if (continuationDepth > 0) {
      continuationDepth += bracketDelta(line);
      continue;
    }
    const assignment = line.match(/^\s*([A-Za-z0-9_-]+)\s*=(.*)$/);
    if (assignment && TUI_KEYS.has(assignment[1])) {
      continuationDepth = Math.max(0, bracketDelta(assignment[2]));
      continue;
    }
    kept.push(line);
  }
  return kept;
}

export function patchCodexConfig(text: string, presetName = "balanced"): string {
  const preset = CODEX_PRESETS[presetName as CodexPresetName];
  if (!preset) throw new Error(`Unknown Codex preset: ${presetName}`);
  const values = { ...preset, status_line_use_colors: true };
  const block = Object.entries(values).map(([key, value]) => `${key} = ${tomlValue(value)}`);
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex((line) =>
    /^\s*\[\s*tui\s*\]\s*(?:#.*)?$/.test(line));

  if (index < 0) {
    const childIndex = lines.findIndex((line) =>
      /^\s*\[\[?\s*tui\s*\./.test(line));
    const insertAt = childIndex >= 0 ? childIndex : lines.length;
    const before = lines.slice(0, insertAt);
    const after = lines.slice(insertAt);
    if (before.length && before.at(-1) !== "") before.push("");
    return [...before, "[tui]", ...block, "", ...after].join("\n");
  }

  let end = index + 1;
  let continuationDepth = 0;
  while (end < lines.length) {
    const line = lines[end];
    if (continuationDepth > 0) {
      continuationDepth += bracketDelta(line);
      end += 1;
      continue;
    }
    if (TABLE_RE.test(line)) break;
    const assignment = line.match(/^\s*[A-Za-z0-9_-]+\s*=(.*)$/);
    continuationDepth = assignment
      ? Math.max(0, bracketDelta(assignment[1]))
      : 0;
    end += 1;
  }
  const kept = withoutManagedTuiKeys(lines.slice(index + 1, end));
  while (kept.length && !kept[0].trim()) kept.shift();
  const section = [lines[index], ...block, ...(kept.length ? ["", ...kept] : [])];
  return [...lines.slice(0, index), ...section, ...lines.slice(end)].join("\n");
}

export function patchClaudeSettings(
  text: string,
  executable = process.execPath,
  cliPath = CLI_PATH,
  platform = process.platform,
): string {
  const parsed = parseJsonObject(text);
  parsed.statusLine = {
    type: "command",
    command: commandFor("statusline", executable, cliPath, platform),
    refreshInterval: 5,
  };
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

export function patchCursorConfig(
  text: string,
  executable = process.execPath,
  cliPath = CLI_PATH,
  platform = process.platform,
): string {
  const parsed = parseJsonObject(text);
  parsed.statusLine = {
    type: "command",
    command: commandFor("statusline", executable, cliPath, platform),
    padding: 0,
    updateIntervalMs: 1_000,
    timeoutMs: 2_000,
  };
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

const CURSOR_HOOK_EVENTS = [
  ["sessionStart", "SessionStart"],
  ["beforeSubmitPrompt", "UserPromptSubmit"],
  ["preToolUse", "PreToolUse"],
  ["postToolUse", "PostToolUse"],
  ["postToolUseFailure", "PostToolUseFailure"],
  ["subagentStart", "SubagentStart"],
  ["subagentStop", "SubagentStop"],
  ["stop", "Stop"],
  ["sessionEnd", "SessionEnd"],
] as const;

function isManagedCursorHook(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as any).command === "string" &&
    /\bhook --platform cursor --event\b/.test((value as any).command),
  );
}

export function patchCursorHooks(
  text: string,
  executable = process.execPath,
  cliPath = CLI_PATH,
  platform = process.platform,
): string {
  const parsed = parseJsonObject(text);
  parsed.version = typeof parsed.version === "number" ? parsed.version : 1;
  const hooks = parsed.hooks && typeof parsed.hooks === "object" &&
      !Array.isArray(parsed.hooks)
    ? parsed.hooks
    : {};
  parsed.hooks = hooks;
  for (const [cursorEvent, providerEvent] of CURSOR_HOOK_EVENTS) {
    const existing = Array.isArray(hooks[cursorEvent]) ? hooks[cursorEvent] : [];
    hooks[cursorEvent] = [
      ...existing.filter((entry: unknown) => !isManagedCursorHook(entry)),
      {
        command: commandFor(
          `hook --platform cursor --event ${providerEvent}`,
          executable,
          cliPath,
          platform,
        ),
        timeout: 3,
      },
    ];
  }
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

export function patchAntigravitySettings(
  text: string,
  executable = process.execPath,
  cliPath = CLI_PATH,
  platform = process.platform,
): string {
  const parsed = parseJsonObject(text);
  parsed.statusLine = {
    type: "command",
    command: commandFor("statusline", executable, cliPath, platform),
  };
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function antigravityHook(
  event: string,
  executable: string | undefined,
  cliPath: string | undefined,
  platform: NodeJS.Platform,
) {
  return {
    type: "command",
    command: commandFor(
      `hook --platform antigravity --event ${event}`,
      executable,
      cliPath,
      platform,
    ),
    timeout: 3,
  };
}

export function patchAntigravityHooks(
  text: string,
  executable = process.execPath,
  cliPath = CLI_PATH,
  platform = process.platform,
): string {
  const parsed = parseJsonObject(text);
  // Antigravity namespaces top-level hook definitions. Owning exactly one key
  // makes setup idempotent and preserves every unrelated customization.
  parsed["agent-hud"] = {
    PreToolUse: [{
      matcher: "*",
      hooks: [antigravityHook("PreToolUse", executable, cliPath, platform)],
    }],
    PostToolUse: [{
      matcher: "*",
      hooks: [antigravityHook("PostToolUse", executable, cliPath, platform)],
    }],
    PreInvocation: [
      antigravityHook("PreInvocation", executable, cliPath, platform),
    ],
    Stop: [
      antigravityHook("Stop", executable, cliPath, platform),
    ],
  };
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

async function writeWithBackup(
  filePath: string,
  content: string,
  dryRun = false,
): Promise<WriteResult> {
  let original = "";
  try {
    original = await fs.readFile(filePath, "utf8");
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
  }
  if (content === original) return { changed: false, backup: null, content };
  if (dryRun) return { changed: true, backup: null, content };

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  let backup = null;
  if (original) {
    backup = `${filePath}.bak-agent-hud-${new Date().toISOString().replace(/\D/g, "")}`;
    await fs.copyFile(filePath, backup);
  }
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, filePath);
  return { changed: true, backup, content };
}

export async function setupCodex(options: SetupOptions = {}) {
  const filePath = options.config ||
    path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml");
  let original = "";
  try {
    original = await fs.readFile(filePath, "utf8");
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
  }
  const content = patchCodexConfig(original, options.preset || "balanced");
  return { filePath, ...(await writeWithBackup(filePath, content, options.dryRun)) };
}

export async function setupClaude(options: SetupOptions = {}) {
  const root = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const filePath = options.config || path.join(root, "settings.json");
  let original = "";
  try {
    original = await fs.readFile(filePath, "utf8");
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
  }
  const content = patchClaudeSettings(original, options.executable, options.cliPath);
  return { filePath, ...(await writeWithBackup(filePath, content, options.dryRun)) };
}

async function readOptional(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error: any) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

export async function setupCursor(options: SetupOptions = {}) {
  const root = process.env.CURSOR_CONFIG_DIR || path.join(os.homedir(), ".cursor");
  const filePath = options.config || path.join(root, "cli-config.json");
  const hooksFilePath = options.hooksConfig || path.join(root, "hooks.json");
  const content = patchCursorConfig(
    await readOptional(filePath),
    options.executable,
    options.cliPath,
  );
  const hooksContent = patchCursorHooks(
    await readOptional(hooksFilePath),
    options.executable,
    options.cliPath,
  );
  return {
    filePath,
    ...(await writeWithBackup(filePath, content, options.dryRun)),
    hooks: {
      filePath: hooksFilePath,
      ...(await writeWithBackup(hooksFilePath, hooksContent, options.dryRun)),
    },
  };
}

export async function setupAntigravity(options: SetupOptions = {}) {
  const settingsRoot = process.env.ANTIGRAVITY_CONFIG_DIR ||
    path.join(os.homedir(), ".gemini", "antigravity-cli");
  const hooksRoot = process.env.GEMINI_CUSTOMIZATION_DIR ||
    path.join(os.homedir(), ".gemini", "config");
  const filePath = options.config || path.join(settingsRoot, "settings.json");
  const hooksFilePath = options.hooksConfig || path.join(hooksRoot, "hooks.json");
  const content = patchAntigravitySettings(
    await readOptional(filePath),
    options.executable,
    options.cliPath,
  );
  const hooksContent = patchAntigravityHooks(
    await readOptional(hooksFilePath),
    options.executable,
    options.cliPath,
  );
  return {
    filePath,
    ...(await writeWithBackup(filePath, content, options.dryRun)),
    hooks: {
      filePath: hooksFilePath,
      ...(await writeWithBackup(hooksFilePath, hooksContent, options.dryRun)),
    },
  };
}
