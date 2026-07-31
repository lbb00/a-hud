import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function adapterPathFor(home = os.homedir()) {
  return path.join(home, ".ahud", "adapter.mjs");
}

// Races a promise against a timer so a hung top-level await (or a slow
// render call) can never block the caller past `timeoutMs`. The loser is
// simply left to resolve/reject on its own later — we don't cancel it.
function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// Loads ~/.ahud/adapter.mjs (or `${options.home}/.ahud/adapter.mjs`) and
// resolves its render export. Every failure mode — missing file, syntax
// error, a hung top-level await, or no valid `render`/`default` export —
// is folded into a plain `null` return; this is a routine, expected outcome
// (adapters are optional), not something callers should have to try/catch.
export async function loadAdapter(options = {}) {
  const home = options.home ?? os.homedir();
  const timeoutMs = options.timeoutMs ?? 100;
  const filePath = adapterPathFor(home);
  const url = pathToFileURL(filePath).href;

  let mod;
  try {
    mod = await withTimeout(import(url), timeoutMs, "adapter import timed out");
  } catch {
    return null;
  }

  const render = mod?.render ?? mod?.default;
  if (typeof render !== "function") return null;
  return { render };
}

// Runs adapter.render(snapshot, context), tolerating both sync and async
// implementations, and bounds the whole call at `timeoutMs`. snapshot and
// context are passed through by reference (no cloning) so adapters get the
// real, live objects — including the actual render.mjs util functions.
export async function renderWithAdapter(adapter, snapshot, context, options = {}) {
  const timeoutMs = options.timeoutMs ?? 100;
  try {
    const text = await withTimeout(
      Promise.resolve().then(() => adapter.render(snapshot, context)),
      timeoutMs,
      "adapter render timed out",
    );
    if (typeof text !== "string") {
      return { ok: false, error: `adapter render returned ${typeof text} instead of a string` };
    }
    return { ok: true, text };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}
