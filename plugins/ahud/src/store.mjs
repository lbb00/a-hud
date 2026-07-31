import fs from "node:fs/promises";
import path from "node:path";
import {
  appendJsonLine,
  eventFileFor,
  normalizeCwd,
  readTail,
  resolveDataDir,
  safeText,
} from "./io.mjs";

const DEFAULT_TTL = { activeMin: 15, recentMin: 5 };

export function detectPlatform(input, env) {
  if (env.PLUGIN_ROOT || String(input.transcript_path || "").includes("/.codex/")) {
    return "codex";
  }
  if (env.CLAUDE_PLUGIN_ROOT || String(input.transcript_path || "").includes("/.claude/")) {
    return "claude";
  }
  return "agent";
}

function sessionKey(input) {
  return safeText(input.session_id, 160) ||
    safeText(input.transcript_path, 240) ||
    `${safeText(input.cwd, 240) || "unknown"}:default`;
}

function modelName(input) {
  if (typeof input.model === "string") return safeText(input.model, 80);
  return safeText(input.model?.display_name || input.model?.id, 80);
}

function toolTarget(name, toolInput) {
  if (!toolInput || typeof toolInput !== "object") return "";
  const rawPath =
    toolInput.file_path ||
    toolInput.path ||
    toolInput.workdir ||
    toolInput.cwd;
  if (typeof rawPath === "string") return safeText(path.basename(rawPath), 48);
  if (name === "Bash" && typeof toolInput.command === "string") {
    return safeText(toolInput.command.trim().split(/\s+/)[0], 32);
  }
  if (name === "apply_patch") return "patch";
  return "";
}

function normalizePlan(name, toolInput) {
  const raw =
    name === "update_plan" ? toolInput?.plan :
    name === "TodoWrite" ? toolInput?.todos :
    null;
  if (!Array.isArray(raw)) return null;
  return raw.slice(0, 40).map((item) => ({
    text: safeText(item?.step || item?.content || item?.subject, 120),
    status: ["pending", "in_progress", "completed"].includes(item?.status)
      ? item.status
      : "pending",
  })).filter((item) => item.text);
}

export function normalizeHookEvent(input, env = process.env, now = Date.now()) {
  const type = safeText(input.hook_event_name, 40) || "Unknown";
  const name = safeText(input.tool_name, 80);
  const event = {
    v: 1,
    at: now,
    sessionId: sessionKey(input),
    platform: detectPlatform(input, env),
    type,
    cwd: safeText(input.cwd, 320),
    transcriptPath: safeText(input.transcript_path, 500),
    model: modelName(input),
  };

  if (type === "PreToolUse" || type === "PostToolUse" || type === "PostToolUseFailure") {
    // Fall back to a deterministic key (session + tool name) rather than a
    // wall-clock timestamp: `turn_id` isn't a real hook payload field, and a
    // `now`-based fallback would give PreToolUse/PostToolUse different ids
    // whenever tool_use_id is absent, leaving the tool stuck at "running".
    event.tool = {
      id: safeText(input.tool_use_id, 120) || `${sessionKey(input)}:${name || "tool"}`,
      name: name || "tool",
      target: toolTarget(name, input.tool_input),
      status: type === "PreToolUse" ? "running" :
        type === "PostToolUseFailure" ? "error" : "completed",
    };
    const plan = normalizePlan(name, input.tool_input);
    if (plan && type !== "PreToolUse") event.plan = plan;
  }

  if (type === "SubagentStart" || type === "SubagentStop") {
    const agentType = safeText(input.agent_type || input.subagent_type, 60) || "agent";
    // Same reasoning as the tool id fallback above: derive a deterministic
    // key from session + agent type instead of a wall-clock timestamp so
    // SubagentStart/SubagentStop pair up even without an agent_id.
    event.agent = {
      id: safeText(input.agent_id, 120) || `agent:${sessionKey(input)}:${agentType}`,
      type: agentType,
      status: type === "SubagentStart" ? "running" : "completed",
    };
  }

  return event;
}

export async function recordHook(input, options = {}) {
  const dataDir = options.dataDir || resolveDataDir(options.env);
  const event = normalizeHookEvent(input, options.env, options.now?.() ?? Date.now());
  const filePath = eventFileFor(dataDir, event.sessionId);
  await appendJsonLine(filePath, event);
  return { event, filePath };
}

function parseEvents(text) {
  const result = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event?.v === 1 && Number.isFinite(event.at)) result.push(event);
    } catch {
      // A partial final append should not make the HUD disappear.
    }
  }
  return result.sort((a, b) => a.at - b.at);
}

export function foldEvents(events, now = Date.now(), ttl = DEFAULT_TTL) {
  const activeTtlMs = (ttl.activeMin ?? DEFAULT_TTL.activeMin) * 60_000;
  const recentTtlMs = (ttl.recentMin ?? DEFAULT_TTL.recentMin) * 60_000;
  const state = {
    platform: "agent",
    sessionId: "",
    cwd: "",
    transcriptPath: "",
    model: "",
    status: "idle",
    tools: [],
    agents: [],
    plan: [],
    updatedAt: 0,
  };
  const tools = new Map();
  const agents = new Map();

  for (const event of events) {
    state.platform = event.platform || state.platform;
    state.sessionId = event.sessionId || state.sessionId;
    state.cwd = event.cwd || state.cwd;
    state.transcriptPath = event.transcriptPath || state.transcriptPath;
    state.model = event.model || state.model;
    state.updatedAt = Math.max(state.updatedAt, event.at);

    if (event.type === "SessionStart" || event.type === "UserPromptSubmit") state.status = "working";
    if (event.type === "Stop" || event.type === "SessionEnd") state.status = "idle";

    if (event.tool) {
      const previous = tools.get(event.tool.id);
      tools.set(event.tool.id, {
        ...previous,
        ...event.tool,
        startedAt: previous?.startedAt || event.at,
        updatedAt: event.at,
      });
    }
    if (event.agent) {
      const previous = agents.get(event.agent.id);
      agents.set(event.agent.id, {
        ...previous,
        ...event.agent,
        startedAt: previous?.startedAt || event.at,
        updatedAt: event.at,
      });
    }
    if (event.plan) state.plan = event.plan;
  }

  state.tools = [...tools.values()]
    .filter((tool) => now - tool.updatedAt <= (tool.status === "running" ? activeTtlMs : recentTtlMs))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  state.agents = [...agents.values()]
    .filter((agent) => now - agent.updatedAt <= (agent.status === "running" ? activeTtlMs : recentTtlMs))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  if (state.tools.some((tool) => tool.status === "running") ||
      state.agents.some((agent) => agent.status === "running")) {
    state.status = "working";
  }
  return state;
}

async function candidateFiles(dataDir) {
  let entries;
  try {
    entries = await fs.readdir(dataDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const filePath = path.join(dataDir, entry.name);
    try {
      const stat = await fs.stat(filePath);
      files.push({ filePath, mtimeMs: stat.mtimeMs });
    } catch {
      // File may disappear during cleanup.
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 24);
}

export async function loadState(query = {}, options = {}) {
  const dataDir = options.dataDir || resolveDataDir(options.env);
  const exactKey = safeText(query.sessionId, 160);
  if (exactKey) {
    try {
      const text = await readTail(eventFileFor(dataDir, exactKey));
      const events = parseEvents(text);
      if (events.length) return foldEvents(events, options.now?.() ?? Date.now(), options.ttl);
    } catch {
      // Fall back to matching cwd/transcript among recent sessions.
    }
  }

  const files = await candidateFiles(dataDir);
  let fallback = null;
  for (const { filePath } of files) {
    try {
      const events = parseEvents(await readTail(filePath));
      if (!events.length) continue;
      const state = foldEvents(events, options.now?.() ?? Date.now(), options.ttl);
      if (query.transcriptPath && state.transcriptPath === query.transcriptPath) return state;
      // state.cwd comes from a host hook's report and query.cwd from the
      // local CLI's --cwd/process.cwd(); their string forms don't always
      // match exactly (symlinks, trailing slashes), so compare normalized.
      if (query.cwd && state.cwd && normalizeCwd(query.cwd) === normalizeCwd(state.cwd)) return state;
      fallback ||= state;
    } catch {
      // Ignore a corrupt or concurrently removed session.
    }
  }
  return fallback || foldEvents([], options.now?.() ?? Date.now(), options.ttl);
}
