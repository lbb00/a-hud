import path from "node:path";
import { safePath, safeText } from "../io.js";
import type {
  HookEvent,
  JsonObject,
  PlanItem,
  Platform,
} from "../types.js";

export interface HookNormalizeHints {
  platform?: Platform;
  event?: string;
}

const HOST_EVENT_NAMES: Record<string, string> = {
  beforeSubmitPrompt: "UserPromptSubmit",
  preToolUse: "PreToolUse",
  postToolUse: "PostToolUse",
  postToolUseFailure: "PostToolUseFailure",
  subagentStart: "SubagentStart",
  subagentStop: "SubagentStop",
  sessionStart: "SessionStart",
  sessionEnd: "SessionEnd",
  stop: "Stop",
};

const CODEX_COMMAND_TOOLS = new Set([
  "bash",
  "exec_command",
  "shell",
  "shell_command",
  "terminal",
]);

const WAITING_NOTIFICATION_TYPES = new Set([
  "permission_prompt",
  "idle_prompt",
  "agent_needs_input",
]);

function canonicalEventName(value: unknown): string {
  const event = safeText(value, 40);
  return HOST_EVENT_NAMES[event] || event || "Unknown";
}

function detectPlatform(
  input: JsonObject,
  env: NodeJS.ProcessEnv,
  hint?: Platform,
): Platform {
  if (hint) return hint;
  if (env.PLUGIN_ROOT || String(input.transcript_path || "").includes("/.codex/")) {
    return "codex";
  }
  if (env.CLAUDE_PLUGIN_ROOT || String(input.transcript_path || "").includes("/.claude/")) {
    return "claude";
  }
  const transcript = String(input.transcript_path || input.transcriptPath || "");
  if (transcript.includes("/.gemini/antigravity")) return "antigravity";
  if (
    transcript.includes("/.cursor/") ||
    typeof input.cursor_version === "string"
  ) return "cursor";
  return "agent";
}

function sessionKey(input: JsonObject): string {
  return safeText(
    input.session_id || input.conversation_id || input.conversationId,
    160,
  ) ||
    safePath(input.transcript_path || input.transcriptPath) ||
    `${safePath(
      input.cwd || input.workspacePaths?.[0] || input.workspace_roots?.[0],
    ) || "unknown"}:default`;
}

function modelName(input: JsonObject): string {
  if (typeof input.model === "string") return safeText(input.model, 80);
  return safeText(input.model?.display_name || input.model?.id, 80);
}

function toolTarget(name: string, toolInput: JsonObject | undefined): string {
  if (!toolInput || typeof toolInput !== "object") return "";
  const rawPath =
    toolInput.file_path ||
    toolInput.path ||
    toolInput.workdir ||
    toolInput.cwd ||
    toolInput.TargetFile ||
    toolInput.AbsolutePath ||
    toolInput.DirectoryPath ||
    toolInput.Cwd;
  if (typeof rawPath === "string") return safeText(path.basename(rawPath), 48);
  const command = toolInput.command || toolInput.CommandLine;
  if (
    ["Bash", "Shell", "run_command"].includes(name) &&
    typeof command === "string"
  ) {
    return safeText(command.trim().split(/\s+/)[0], 32);
  }
  if (name === "apply_patch") return "patch";
  return "";
}

function normalizePlan(
  name: string,
  toolInput: JsonObject | undefined,
): PlanItem[] | null {
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

/**
 * Claude Stop payloads may include background_tasks. Only an own, plain data
 * property with the documented exact status is accepted: malformed hook data
 * must not be able to keep a session permanently working.
 */
function hasRunningBackgroundTask(input: JsonObject): boolean {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(input, "background_tasks");
    if (!descriptor || !("value" in descriptor) || !Array.isArray(descriptor.value)) {
      return false;
    }
    return descriptor.value.some((task) => {
      if (!task || typeof task !== "object" || Array.isArray(task)) return false;
      const status = Object.getOwnPropertyDescriptor(task, "status");
      return Boolean(status && "value" in status && status.value === "running");
    });
  } catch {
    // Revoked proxies and accessor tricks are not valid JSON hook facts.
    return false;
  }
}

/**
 * Codex reports every completed tool through PostToolUse, including commands
 * with a non-zero exit. Inspect only command tools and structural exit codes.
 */
function nonzeroExitCode(
  value: unknown,
  depth = 0,
  seen = new Set<object>(),
): boolean {
  if (!value || typeof value !== "object" || depth > 6) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((item) => nonzeroExitCode(item, depth + 1, seen));
  }

  for (const [key, field] of Object.entries(value)) {
    const normalized = key.replace(/[_-]/g, "").toLowerCase();
    if (
      normalized === "exitcode" &&
      ((typeof field === "number" && field !== 0) ||
        (typeof field === "string" && /^-?\d+$/.test(field) && Number(field) !== 0))
    ) return true;
    if (nonzeroExitCode(field, depth + 1, seen)) return true;
  }
  return false;
}

export function normalizeHookEvent(
  input: JsonObject,
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
  hints: HookNormalizeHints = {},
): HookEvent {
  let type = canonicalEventName(hints.event || input.hook_event_name);
  if (
    type === "PostToolUse" &&
    typeof input.error === "string" &&
    input.error.length > 0
  ) {
    type = "PostToolUseFailure";
  }
  const name = safeText(input.tool_name || input.toolCall?.name, 80);
  const toolInput = input.tool_input || input.toolCall?.args;
  const platform = detectPlatform(input, env, hints.platform);
  const codexCommandFailed = platform === "codex" &&
    CODEX_COMMAND_TOOLS.has(name.toLowerCase()) &&
    nonzeroExitCode(input.tool_response);
  const event: HookEvent = {
    v: 1,
    at: now,
    sessionId: sessionKey(input),
    platform,
    type,
    cwd: safePath(
      input.cwd || input.workspacePaths?.[0] || input.workspace_roots?.[0],
    ),
    transcriptPath: safePath(input.transcript_path || input.transcriptPath),
    model: modelName(input),
    turnId: safeText(
      input.turn_id ||
      input.generation_id ||
      input.generationId,
      120,
    ),
  };

  if (type === "Stop") {
    event.backgroundTasksRunning = platform === "antigravity"
      ? input.fullyIdle === false
      : hasRunningBackgroundTask(input);
  }
  if (type === "PermissionRequest") {
    event.needsInput = true;
  } else if (type === "Notification") {
    event.needsInput = WAITING_NOTIFICATION_TYPES.has(
      safeText(input.notification_type, 60),
    );
  }

  if (type === "PreToolUse" || type === "PostToolUse" || type === "PostToolUseFailure") {
    const structuralId = input.tool_use_id ??
      input.toolCall?.id ??
      (Number.isInteger(input.stepIdx) ? `step:${input.stepIdx}` : "");
    event.tool = {
      id: safeText(structuralId, 120) ||
        `${name || "tool"}:${input.turn_id || input.generation_id || now}`,
      name,
      target: toolTarget(name, toolInput),
      status: type === "PreToolUse" ? "running" :
        type === "PostToolUseFailure" || codexCommandFailed
          ? "error"
          : "completed",
    };
    const plan = normalizePlan(name, toolInput);
    if (plan && type !== "PreToolUse") event.plan = plan;
  }

  if (type === "SubagentStart" || type === "SubagentStop") {
    event.agent = {
      id: safeText(input.agent_id || input.subagent_id, 120) ||
        `agent:${input.turn_id || input.generation_id || now}`,
      type: safeText(input.agent_type || input.subagent_type, 60) || "agent",
      status: type === "SubagentStart"
        ? "running"
        : ["error", "failed"].includes(safeText(input.status, 20).toLowerCase())
          ? "error"
          : "completed",
    };
  }

  return event;
}
