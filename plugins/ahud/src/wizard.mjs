// Interactive `ahud setup` wizard.
//
// This module is only reachable when shouldRunWizard() has already vetted
// the invocation as genuinely interactive (bare `setup`, real TTY on both
// ends, no CI flag) — see src/cli.mjs. Everything below assumes it may be
// talking to a real human, but every question still carries its own hard
// timeout: this CLI's two host entry points (Codex CLI, Claude Code) can
// both invoke `ahud setup` as a non-interactive agent tool call, so nothing
// here is allowed to block forever waiting on input nobody will ever type.
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { loadConfig as loadConfigDefault } from "./config.mjs";

// Safety gate: decides whether the CLI may block on interactive input at
// all. All four conditions must hold:
//   (a) args.length === 0 — bare `setup`, not even a lone flag like
//       `--dry-run` (which must still reach the existing flag-driven path).
//   (b) stdin AND stdout are both real TTYs.
//   (c) env.CI is not JS-truthy (a literal string "false" is still
//       JS-truthy and must still veto the wizard — CI vars are always
//       strings, so `!env.CI` is the only correct check here).
export function shouldRunWizard(args, env = process.env, stdin = process.stdin, stdout = process.stdout) {
  if (args.length !== 0) return false;
  if (!stdin.isTTY || !stdout.isTTY) return false;
  if (env.CI) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Minimal line reader
// ---------------------------------------------------------------------------
// Deliberately NOT built on node:readline: readline.Interface auto-closes
// the moment its input stream emits "end", even when it still has
// unconsumed buffered lines queued internally — which breaks asking a
// second question against a stream that was fully written and end()-ed up
// front (exactly the shape the unit tests' fakeInput() produces, and also a
// real closed/piped stdin). This tiny reader keeps its own line queue that
// survives past "end", so a handful of pre-buffered lines can still be
// consumed one at a time across several questions.
function createLineReader(input) {
  let buffer = "";
  const lineQueue = [];
  const waiters = [];
  let ended = false;

  function pump() {
    while (waiters.length && lineQueue.length) {
      const waiter = waiters.shift();
      waiter.cleanup();
      waiter.resolve(lineQueue.shift());
    }
    if (waiters.length && ended) {
      while (waiters.length) {
        const waiter = waiters.shift();
        waiter.cleanup();
        waiter.resolve(null);
      }
    }
  }

  input.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      let line = buffer.slice(0, index);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      buffer = buffer.slice(index + 1);
      lineQueue.push(line);
    }
    pump();
  });
  input.on("end", () => {
    ended = true;
    // A final unterminated line (no trailing "\n") still counts.
    if (buffer.length) {
      lineQueue.push(buffer);
      buffer = "";
    }
    pump();
  });
  // A stream error should behave like EOF for our purposes rather than
  // leaving a pending question hanging forever.
  input.on("error", () => {
    ended = true;
    pump();
  });

  return {
    // Resolves with the next buffered line, or null if the stream has
    // ended with nothing left to read. Rejects with an AbortError if
    // `signal` fires first.
    nextLine(signal) {
      return new Promise((resolve, reject) => {
        if (lineQueue.length) {
          resolve(lineQueue.shift());
          return;
        }
        if (ended) {
          resolve(null);
          return;
        }
        const waiter = {
          resolve,
          cleanup: () => {
            if (signal) signal.removeEventListener("abort", onAbort);
          },
        };
        const onAbort = () => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          const error = new Error("The operation was aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (signal) {
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener("abort", onAbort, { once: true });
        }
        waiters.push(waiter);
      });
    },
  };
}

// Writes `prompt`, then waits for the next line with a fresh per-question
// timeout. Both a real abort and a clean EOF (line === null — the stream
// ended without ever answering, e.g. a closed pipe) are treated the same
// way: throw an AbortError rather than inventing an answer or hanging.
async function ask(reader, output, prompt, timeoutMs) {
  output.write(prompt);
  const line = await reader.nextLine(AbortSignal.timeout(timeoutMs));
  if (line === null) {
    const error = new Error("The operation was aborted");
    error.name = "AbortError";
    throw error;
  }
  return line;
}

// ---------------------------------------------------------------------------
// Q1: platform selection
// ---------------------------------------------------------------------------

// Parses a comma-separated numbered selection. Tolerates loose formatting
// (extra spaces, empty segments from stray commas) but rejects the WHOLE
// answer — never a partial subset of it — the moment any segment is not
// exactly "1" or "2", or the answer parses down to an empty set. Returns
// null for anything illegal.
function parsePlatformSelection(answer) {
  const parts = answer
    .trim()
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) return null;

  const numbers = new Set();
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const value = Number(part);
    if (value !== 1 && value !== 2) return null;
    numbers.add(value);
  }
  if (numbers.has(1) && numbers.has(2)) return "both";
  return numbers.has(1) ? "codex" : "claude";
}

async function askTargetPlatforms(reader, output, timeoutMs) {
  const basePrompt =
    "Which AI CLIs should ahud set up? (comma-separated numbers)\n" +
    "  [1] Codex\n" +
    "  [2] Claude Code\n" +
    "Select [default: 1,2]: ";
  // 1 initial ask + up to 3 re-asks on an illegal answer = 4 asks total;
  // after that, give up and proceed with the default rather than asking
  // indefinitely.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const prompt = attempt === 0 ? basePrompt : `Invalid selection — please enter 1, 2, or 1,2.\n${basePrompt}`;
    const answer = await ask(reader, output, prompt, timeoutMs);
    if (answer.trim() === "") return "both";
    const target = parsePlatformSelection(answer);
    if (target) return target;
  }
  output.write("No valid selection after several tries; defaulting to both.\n");
  return "both";
}

// ---------------------------------------------------------------------------
// Q2: Codex preset selection (only when target includes "codex")
// ---------------------------------------------------------------------------

async function askCodexPreset(reader, output, timeoutMs, hasSavedCustom) {
  if (hasSavedCustom) {
    const prompt =
      "[1] Keep my saved custom fields (default)\n" +
      "[2] balanced\n" +
      "[3] compact\n" +
      "[4] full\n" +
      "Select [default: 1]: ";
    const answer = (await ask(reader, output, prompt, timeoutMs)).trim();
    if (answer === "2") return "balanced";
    if (answer === "3") return "compact";
    if (answer === "4") return "full";
    // "", "1", or anything unrecognized keeps the saved custom fields.
    return null;
  }

  const prompt = "[1] balanced (default)\n[2] compact\n[3] full\nSelect [default: 1]: ";
  const answer = (await ask(reader, output, prompt, timeoutMs)).trim();
  if (answer === "2") return "compact";
  if (answer === "3") return "full";
  // "", "1", or anything unrecognized falls back to the default preset.
  return "balanced";
}

// ---------------------------------------------------------------------------
// Q3: final confirmation
// ---------------------------------------------------------------------------

function displayConfigPaths(target, home) {
  const resolvedHome = home ?? os.homedir();
  const paths = [];
  if (target === "codex" || target === "both") {
    const codexHome = process.env.CODEX_HOME || path.join(resolvedHome, ".codex");
    paths.push(path.join(codexHome, "config.toml"));
  }
  if (target === "claude" || target === "both") {
    const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(resolvedHome, ".claude");
    paths.push(path.join(claudeHome, "settings.json"));
  }
  return paths;
}

async function confirmAndProceed(reader, output, timeoutMs, target, home) {
  const paths = displayConfigPaths(target, home);
  const prompt = [
    "The following files will be written (any existing file is backed up automatically before being changed):",
    ...paths.map((filePath) => `  - ${filePath}`),
    "Proceed? [Y/n]: ",
  ].join("\n");
  const answer = (await ask(reader, output, prompt, timeoutMs)).trim().toLowerCase();
  return answer !== "n";
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// Runs the interactive Q&A flow and returns the answers, doing no
// filesystem writes of its own (never calls setupCodex/setupClaude/
// writeConfigPatch — the caller applies the result).
//
// Returns { target, options } on completion (Q3 confirmed), or null if the
// user declined at Q3. Rejects with an AbortError (error.name ===
// "AbortError") if any single question exceeds questionTimeoutMs — the
// timeout is per-question, not a single global deadline.
export async function runSetupWizard(options = {}) {
  const {
    home,
    input = process.stdin,
    output = process.stdout,
    questionTimeoutMs = 60_000,
    loadConfig = loadConfigDefault,
  } = options;

  const reader = createLineReader(input);

  const target = await askTargetPlatforms(reader, output, questionTimeoutMs);

  let preset = null;
  if (target === "codex" || target === "both") {
    const { config } = await loadConfig({ home });
    const hasSavedCustom = Boolean(config?.codex?.status_line || config?.codex?.terminal_title);
    preset = await askCodexPreset(reader, output, questionTimeoutMs, hasSavedCustom);
  }

  const proceed = await confirmAndProceed(reader, output, questionTimeoutMs, target, home);
  if (!proceed) return null;

  return {
    target,
    options: { dryRun: false, preset, config: undefined, home },
  };
}
