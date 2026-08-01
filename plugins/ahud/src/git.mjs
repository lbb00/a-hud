import { execFileSync } from "node:child_process";
import { safeText } from "./io.mjs";

// `git status -b` on a repo with no commits yet prints a heading like
// "## No commits yet on main" instead of the usual "## main...origin/main"
// or "## main". A naive split(" ")[0] on the post-"## " text would yield the
// wrong word "No" for that case, so it gets its own branch first.
function branchFromHeading(headingRaw) {
  const heading = headingRaw.replace(/^##\s*/, "");
  const fresh = heading.match(/^No commits yet on (.+)$/);
  if (fresh) return fresh[1].trim();
  // A checked-out commit/tag with no branch prints a heading like
  // "HEAD (no branch)" — without this check, split(" ")[0] below would
  // return the bare, ambiguous "HEAD" instead of a clearly-detached label.
  if (heading.startsWith("HEAD (no branch)") || heading === "HEAD") return "detached";
  return heading.split("...")[0].split(" ")[0];
}

const GIT_STATUS_DEFAULT_TIMEOUT_MS = 600;
const GIT_STATUS_DEFAULT_CACHE_MS = 2000;
const gitStatusCache = new Map();

export function getGitStatus(cwd, options = {}) {
  if (!cwd) return null;
  const exec = options.exec || execFileSync;
  const now = options.now || Date.now;
  const cacheMs = options.cacheMs ?? GIT_STATUS_DEFAULT_CACHE_MS;

  const nowMs = now();
  const cached = gitStatusCache.get(cwd);
  if (cached && nowMs - cached.at < cacheMs) {
    return cached.value;
  }

  let value;
  try {
    const output = exec(
      "git",
      ["-C", cwd, "status", "--porcelain=v1", "-b", "--untracked-files=no"],
      { encoding: "utf8", timeout: GIT_STATUS_DEFAULT_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] },
    );
    const lines = output.trimEnd().split("\n");
    const heading = lines.shift() || "";
    const branch = safeText(branchFromHeading(heading), 48);
    value = { branch: branch || "detached", dirty: lines.some(Boolean) };
  } catch {
    value = null;
  }

  gitStatusCache.set(cwd, { at: nowMs, value });
  return value;
}
