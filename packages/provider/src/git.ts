import { execFileSync } from "node:child_process";
import { safeText } from "./io.js";
import type { GitStatus } from "./types.js";

/**
 * Read repository placement without acquiring optional Git locks.
 *
 * The provider returns facts only. The UI decides how dirty/ahead/behind and
 * a detached short SHA are arranged and styled.
 */
export function getGitStatus(cwd?: string | null): GitStatus | null {
  if (!cwd) return null;
  try {
    const run = (args: string[]) => execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: 1_000,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    }).trim();
    let branch = "";
    let detached = false;
    try {
      branch = safeText(run(["symbolic-ref", "--short", "HEAD"]), 48);
    } catch {
      const sha = safeText(run(["rev-parse", "--short", "HEAD"]), 20);
      branch = sha;
      detached = true;
    }
    const dirty = Boolean(run(["status", "--porcelain"]));
    let ahead = 0;
    let behind = 0;
    if (!detached) {
      try {
        const [behindText, aheadText] = run([
          "rev-list",
          "--left-right",
          "--count",
          "@{upstream}...HEAD",
        ]).split(/\s+/);
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
