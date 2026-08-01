import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const MAX_STDIN_BYTES = 256 * 1024;

export async function readJsonStdin(stream = process.stdin) {
  if (stream.isTTY) return null;
  stream.setEncoding("utf8");
  let raw = "";
  for await (const chunk of stream) {
    raw += String(chunk);
    if (Buffer.byteLength(raw, "utf8") > MAX_STDIN_BYTES) return null;
  }
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function resolveDataDir(env = process.env, home = os.homedir()) {
  // Intentionally does NOT read env.PLUGIN_DATA / env.CLAUDE_PLUGIN_DATA: the
  // host only injects those into hook subprocesses, not into the
  // independently-launched watch/statusline processes, so trusting them made
  // the hook writer and the HUD reader disagree on the data directory. A
  // fixed, home-relative default (overridable via AHUD_DATA_DIR) keeps both
  // sides in agreement.
  // A relative AHUD_DATA_DIR must resolve the same way for every caller: a
  // hook subprocess and an independently-launched watch/statusline process
  // never share a cwd, so resolving against process.cwd() (path.join's
  // default when given a relative base) would silently split writers from
  // readers. Anchoring to `home` instead keeps them in agreement; an
  // absolute AHUD_DATA_DIR is used as-is.
  const base = env.AHUD_DATA_DIR ? path.resolve(home, env.AHUD_DATA_DIR) : path.join(home, ".ahud");
  return path.join(base, "events");
}

// Resolves `cwd` to a stable, comparable absolute path: relative paths are
// resolved against process.cwd(), symlinks are expanded via realpathSync,
// and a trailing slash (other than the root "/") is stripped. Falls back to
// path.resolve() if realpathSync throws (e.g. the path doesn't exist), so
// callers never have to handle an exception here.
export function normalizeCwd(cwd) {
  const absolute = path.resolve(cwd);
  let resolved;
  try {
    resolved = realpathSync(absolute);
  } catch {
    resolved = absolute;
  }
  if (resolved.length > 1 && resolved.endsWith(path.sep)) {
    resolved = resolved.slice(0, -1);
  }
  return resolved;
}

export function eventFileFor(dataDir, sessionKey) {
  const digest = createHash("sha256").update(sessionKey).digest("hex").slice(0, 24);
  return path.join(dataDir, `${digest}.jsonl`);
}

export async function appendJsonLine(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function readTail(filePath, maxBytes = 384 * 1024) {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, stat.size - length);
    let text = buffer.toString("utf8");
    if (stat.size > length) text = text.slice(text.indexOf("\n") + 1);
    return text;
  } finally {
    await handle.close();
  }
}

export function safeText(value, max = 80) {
  if (typeof value !== "string") return "";
  return value
    // Strip full ANSI CSI escape sequences (ESC "[" params letter, e.g.
    // "\u001b[31m") first, so a color code doesn't leave a visible "[31m"
    // remnant behind once the lone ESC byte is scrubbed by the next step.
    // A plain "[31m" with no leading ESC is left untouched.
    .replace(/\u001b\[[0-9;]*[a-zA-Z]/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f\u001b]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}
