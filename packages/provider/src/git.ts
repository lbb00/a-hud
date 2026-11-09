import { execFileSync } from "node:child_process";
import { safeText } from "./io.js";
import type { GitStatus } from "./types.js";

const GIT_TIMEOUT_MS = 500;
const REV_LIST_TIMEOUT_MS = 300;

/**
 * Read repository placement without acquiring optional Git locks.
 *
 * The provider returns facts only. The UI decides how dirty/ahead/behind and
 * a detached short SHA are arranged and styled.
 */
export function getGitStatus(cwd?: string | null, timeoutMs = GIT_TIMEOUT_MS): GitStatus | null {
  if (!cwd || timeoutMs <= 0) return null;
  const deadline = Date.now() + timeoutMs;
  try {
    const run = (args: string[], maxCommandTimeout = timeoutMs) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error("Git deadline exceeded");
      }
      return execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        timeout: Math.min(maxCommandTimeout, remaining),
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      }).trim();
    };
    let branch = "";
    let detached = false;
    try {
      branch = safeText(run(["symbolic-ref", "--short", "HEAD"]), 48);
    } catch (error: unknown) {
      if (error instanceof Error && error.message === "Git deadline exceeded") {
        return null;
      }
      const sha = safeText(run(["rev-parse", "--short", "HEAD"]), 20);
      branch = sha;
      detached = true;
    }
    let dirty = false;
    try {
      dirty = Boolean(run(["status", "--porcelain"]));
    } catch (error: unknown) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: string }).code === "ENOBUFS"
      ) {
        dirty = true;
      } else {
        throw error;
      }
    }
    let ahead = 0;
    let behind = 0;
    if (!detached) {
      try {
        const [behindText, aheadText] = run([
          "rev-list",
          "--left-right",
          "--count",
          "@{upstream}...HEAD",
        ], REV_LIST_TIMEOUT_MS).split(/\s+/);
        ahead = Number(aheadText || 0);
        behind = Number(behindText || 0);
      } catch {
        // A local branch without an upstream has no meaningful arrows.
      }
    }
    if (!branch) return null;
    return { branch, detached, dirty, ahead, behind };
  } catch {
    return null;
  }
}
