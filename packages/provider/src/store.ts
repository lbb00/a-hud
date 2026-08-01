import fs from "node:fs/promises";
import path from "node:path";
import {
  appendJsonLine,
  ensurePrivateDirectory,
  eventFileFor,
  maybeSweepPrivateFiles,
  readTail,
  resolveDataDir,
  safeText,
} from "./io.js";
import { normalizeHookEvent } from "./hooks/normalize.js";
import type {
  AgentActivity,
  HookEvent,
  JsonObject,
  Platform,
  ProviderState,
  ToolActivity,
} from "./types.js";

export { normalizeHookEvent };

const RECENT_TTL_MS = 5 * 60 * 1000;
const EVENT_FILE_HYGIENE = {
  fileNamePattern: /^[a-f0-9]{24}\.jsonl$/,
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  maxEntries: 256,
  // An idle-but-open terminal can sit for hours before its next hook. Count
  // pressure only considers sessions untouched for a full day.
  preserveYoungerThanMs: 24 * 60 * 60 * 1000,
} as const;

interface StoreOptions {
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  platform?: Platform;
  event?: string;
}

interface StateQuery {
  sessionId?: string;
  transcriptPath?: string;
  cwd?: string;
  platform?: Platform;
}

export async function recordHook(input: JsonObject, options: StoreOptions = {}) {
  const dataDir = options.dataDir || resolveDataDir(options.env);
  const event = normalizeHookEvent(
    input,
    options.env,
    options.now?.() ?? Date.now(),
    options,
  );
  const filePath = eventFileFor(dataDir, event.sessionId);
  await appendJsonLine(filePath, event);
  await maybeSweepPrivateFiles(dataDir, EVENT_FILE_HYGIENE, {
    protectedPaths: [filePath],
  });
  return { event, filePath };
}

function parseEvents(text: string): HookEvent[] {
  const result: HookEvent[] = [];
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

export function foldEvents(events: HookEvent[], now = Date.now()): ProviderState {
  const state: ProviderState = {
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
    turns: 0,
  };
  const tools = new Map<string, { activity: ToolActivity; order: number }>();
  const agents = new Map<string, { activity: AgentActivity; order: number }>();
  const turns = new Set<string>();
  let lastSessionEndOrder = -1;
  let lastSessionStartOrder = -1;
  let lastWaitingOrder = -1;

  for (const [order, event] of events.entries()) {
    state.platform = event.platform || state.platform;
    state.sessionId = event.sessionId || state.sessionId;
    state.cwd = event.cwd || state.cwd;
    state.transcriptPath = event.transcriptPath || state.transcriptPath;
    state.model = event.model || state.model;
    state.updatedAt = Math.max(state.updatedAt, event.at);

    if (
      event.type === "SessionStart" ||
      event.type === "UserPromptSubmit" ||
      event.type === "PreToolUse" ||
      event.type === "PostToolUse" ||
      event.type === "PostToolUseFailure" ||
      event.type === "SubagentStop"
      || event.type === "PreInvocation"
      || event.type === "PostInvocation"
    ) {
      state.status = "working";
    }
    if (event.type === "SessionStart") {
      // A resumed/restarted host session is a clean lifecycle boundary for
      // tools left running by a prior crash, while long current tools remain
      // visible until their actual completion or SessionEnd.
      lastSessionStartOrder = order;
    }
    if (event.needsInput) {
      state.status = "waiting";
      lastWaitingOrder = order;
    }
    if (event.type === "Stop") {
      state.status = event.backgroundTasksRunning ? "working" : "idle";
    }
    if (event.type === "SessionEnd") {
      state.status = "idle";
      lastSessionEndOrder = order;
    }
    if (event.type === "UserPromptSubmit") turns.add(event.turnId || `at:${event.at}`);

    if (event.tool) {
      const id = event.tool.id || `tool:${event.at}`;
      const previous = tools.get(id)?.activity;
      tools.set(id, {
        activity: {
          ...previous,
          ...event.tool,
          name: event.tool.name || previous?.name || "tool",
          target: event.tool.target || previous?.target,
          startedAt: previous?.startedAt || event.at,
          updatedAt: event.at,
        },
        order,
      });
    }
    if (event.agent) {
      const id = event.agent.id || `agent:${event.at}`;
      const previous = agents.get(id)?.activity;
      agents.set(id, {
        activity: {
          ...previous,
          ...event.agent,
          startedAt: previous?.startedAt || event.at,
          updatedAt: event.at,
        },
        order,
      });
    }
    if (event.plan) state.plan = event.plan;
  }

  const visibleTools = [...tools.values()]
    .filter(({ activity, order }) =>
      !(activity.status === "running" &&
        (order < lastSessionStartOrder || order <= lastSessionEndOrder)) &&
      (activity.status === "running" ||
        now - (activity.updatedAt ?? 0) <= RECENT_TTL_MS)
    )
    .sort((a, b) => (b.activity.updatedAt ?? 0) - (a.activity.updatedAt ?? 0));
  const visibleAgents = [...agents.values()]
    .filter(({ activity, order }) =>
      !(activity.status === "running" &&
        (order < lastSessionStartOrder || order <= lastSessionEndOrder)) &&
      (activity.status === "running" ||
        now - (activity.updatedAt ?? 0) <= RECENT_TTL_MS)
    )
    .sort((a, b) => (b.activity.updatedAt ?? 0) - (a.activity.updatedAt ?? 0));
  state.tools = visibleTools.map(({ activity }) => activity);
  state.agents = visibleAgents.map(({ activity }) => activity);
  state.turns = turns.size;

  // Precedence is intentionally small and fact-based:
  //   SessionEnd ends earlier running activity; a structured needs-input event
  //   holds "waiting" over earlier activity; current activity > ordinary Stop;
  //   Stop with a running background task > ordinary Stop.
  // Activity after a SessionEnd is newer evidence and can reanimate a session.
  const lastActivityBoundaryOrder = Math.max(
    lastSessionEndOrder,
    lastSessionStartOrder - 1,
    lastWaitingOrder,
  );
  if (visibleTools.some(({ activity, order }) =>
        activity.status === "running" && order > lastActivityBoundaryOrder) ||
      visibleAgents.some(({ activity, order }) =>
        activity.status === "running" && order > lastActivityBoundaryOrder)) {
    state.status = "working";
  }
  return state;
}

async function candidateFiles(dataDir: string): Promise<Array<{ filePath: string; mtimeMs: number }>> {
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

async function canonicalPath(value: string): Promise<string> {
  try {
    return await fs.realpath(value);
  } catch {
    return path.resolve(value);
  }
}

export async function loadState(
  query: StateQuery = {},
  options: StoreOptions = {},
): Promise<ProviderState> {
  const dataDir = options.dataDir || resolveDataDir(options.env);
  await ensurePrivateDirectory(dataDir).catch(() => undefined);
  const finish = async (state: ProviderState, protectedPath?: string) => {
    await maybeSweepPrivateFiles(dataDir, EVENT_FILE_HYGIENE, {
      protectedPaths: protectedPath ? [protectedPath] : [],
    });
    return state;
  };
  const queryCwd = query.cwd ? await canonicalPath(query.cwd) : "";
  const exactKey = safeText(query.sessionId, 160);
  if (exactKey) {
    try {
      const text = await readTail(eventFileFor(dataDir, exactKey));
      const events = parseEvents(text);
      if (events.length) {
        const filePath = eventFileFor(dataDir, exactKey);
        const state = foldEvents(events, options.now?.() ?? Date.now());
        if (!query.platform || state.platform === query.platform) {
          return finish(state, filePath);
        }
      }
    } catch {
      // Fall back to matching cwd/transcript among recent sessions.
    }
  }

  const files = await candidateFiles(dataDir);
  let fallback: ProviderState | null = null;
  let fallbackPath = "";
  for (const { filePath } of files) {
    try {
      const events = parseEvents(await readTail(filePath));
      if (!events.length) continue;
      const state = foldEvents(events, options.now?.() ?? Date.now());
      if (query.platform && state.platform !== query.platform) continue;
      if (query.transcriptPath && state.transcriptPath === query.transcriptPath) {
        return finish(state, filePath);
      }
      if (queryCwd && state.cwd && await canonicalPath(state.cwd) === queryCwd) {
        return finish(state, filePath);
      }
      if (!queryCwd && !query.transcriptPath && !fallback) {
        fallback = state;
        fallbackPath = filePath;
      }
    } catch {
      // Ignore a corrupt or concurrently removed session.
    }
  }
  const empty = foldEvents([], options.now?.() ?? Date.now());
  empty.cwd = query.cwd || "";
  empty.transcriptPath = query.transcriptPath || "";
  empty.sessionId = query.sessionId || "";
  empty.platform = query.platform || empty.platform;
  return finish(fallback || empty, fallback ? fallbackPath : undefined);
}
