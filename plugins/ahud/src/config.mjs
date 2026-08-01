import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DEFAULTS = {
  enabled: true,
  platforms: { codex: true, claude: true },
  adapter: { enabled: true },
  ttl: { activeMin: 15, recentMin: 5 },
  claude: { refreshInterval: 5 },
  codex: { status_line: null, terminal_title: null },
};

const KNOWN_TOP_KEYS = new Set(["enabled", "platforms", "adapter", "ttl", "claude", "codex"]);

// Config values are parsed straight from untrusted JSON and then assigned
// onto plain objects via `obj[key] = value` in mergeInto's loops below. A
// literal "__proto__" key in that JSON, assigned with bracket notation,
// triggers the inherited Object.prototype.__proto__ accessor and actually
// reassigns the object's prototype (this is a real bracket-assignment
// footgun, not a JSON.parse quirk — JSON.parse itself just makes it an own
// data property when parsing into a fresh object literal, but a spread /
// reassignment through `{ ...x }` followed by `obj[key] = value` re-triggers
// the accessor). "constructor"/"prototype" are guarded against for the same
// class of prototype-pollution risk. Every key-assignment loop in
// mergeInto must run keys through this before writing them.
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const MAX_CONFIG_BYTES = 256 * 1024;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function configPathFor(home = os.homedir()) {
  return path.join(home, ".ahud", "config.json");
}

function validateBoolean(value, warnings, label, fallback) {
  if (typeof value === "boolean") return value;
  warnings.push(`invalid "${label}": expected a boolean, got ${JSON.stringify(value)}; using default ${fallback}`);
  return fallback;
}

function validateTtlMinutes(value, warnings, label, fallback) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1440) return value;
  warnings.push(`invalid "${label}": expected a finite number in (0, 1440], got ${JSON.stringify(value)}; using default ${fallback}`);
  return fallback;
}

function validateRefreshInterval(value, warnings, fallback) {
  if (Number.isInteger(value) && value >= 1 && value <= 300) return value;
  warnings.push(`invalid "claude.refreshInterval": expected an integer in [1, 300], got ${JSON.stringify(value)}; using default ${fallback}`);
  return fallback;
}

function validateTokenList(value, warnings, label) {
  const valid = Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
  if (valid) return value;
  warnings.push(`invalid "${label}": expected an array of non-empty strings, got ${JSON.stringify(value)}; using null`);
  return null;
}

function mergeInto(config, parsed, warnings) {
  for (const [key, value] of Object.entries(parsed)) {
    if (UNSAFE_KEYS.has(key)) {
      warnings.push(`invalid top-level key "${key}": reserved for JavaScript's prototype machinery; ignoring`);
      continue;
    }

    if (!KNOWN_TOP_KEYS.has(key)) {
      config[key] = value;
      continue;
    }

    if (key === "enabled") {
      config.enabled = validateBoolean(value, warnings, "enabled", true);
      continue;
    }

    if (!isPlainObject(value)) {
      warnings.push(`invalid "${key}": expected an object, got ${JSON.stringify(value)}; ignoring`);
      continue;
    }

    if (key === "platforms") {
      const platforms = { ...config.platforms };
      for (const [subKey, subValue] of Object.entries(value)) {
        if (UNSAFE_KEYS.has(subKey)) {
          warnings.push(`invalid "platforms.${subKey}": reserved for JavaScript's prototype machinery; ignoring`);
          continue;
        }
        platforms[subKey] = validateBoolean(subValue, warnings, `platforms.${subKey}`, true);
      }
      config.platforms = platforms;
      continue;
    }

    if (key === "adapter") {
      const adapter = { ...config.adapter };
      for (const [subKey, subValue] of Object.entries(value)) {
        if (UNSAFE_KEYS.has(subKey)) {
          warnings.push(`invalid "adapter.${subKey}": reserved for JavaScript's prototype machinery; ignoring`);
          continue;
        }
        adapter[subKey] = subKey === "enabled"
          ? validateBoolean(subValue, warnings, "adapter.enabled", true)
          : subValue;
      }
      config.adapter = adapter;
      continue;
    }

    if (key === "ttl") {
      const ttl = { ...config.ttl };
      for (const [subKey, subValue] of Object.entries(value)) {
        if (UNSAFE_KEYS.has(subKey)) {
          warnings.push(`invalid "ttl.${subKey}": reserved for JavaScript's prototype machinery; ignoring`);
          continue;
        }
        if (subKey === "activeMin") ttl.activeMin = validateTtlMinutes(subValue, warnings, "ttl.activeMin", DEFAULTS.ttl.activeMin);
        else if (subKey === "recentMin") ttl.recentMin = validateTtlMinutes(subValue, warnings, "ttl.recentMin", DEFAULTS.ttl.recentMin);
        else ttl[subKey] = subValue;
      }
      config.ttl = ttl;
      continue;
    }

    if (key === "claude") {
      const claude = { ...config.claude };
      for (const [subKey, subValue] of Object.entries(value)) {
        if (UNSAFE_KEYS.has(subKey)) {
          warnings.push(`invalid "claude.${subKey}": reserved for JavaScript's prototype machinery; ignoring`);
          continue;
        }
        claude[subKey] = subKey === "refreshInterval"
          ? validateRefreshInterval(subValue, warnings, DEFAULTS.claude.refreshInterval)
          : subValue;
      }
      config.claude = claude;
      continue;
    }

    if (key === "codex") {
      const codex = { ...config.codex };
      for (const [subKey, subValue] of Object.entries(value)) {
        if (UNSAFE_KEYS.has(subKey)) {
          warnings.push(`invalid "codex.${subKey}": reserved for JavaScript's prototype machinery; ignoring`);
          continue;
        }
        codex[subKey] = subKey === "status_line" || subKey === "terminal_title"
          ? validateTokenList(subValue, warnings, `codex.${subKey}`)
          : subValue;
      }
      config.codex = codex;
      continue;
    }
  }
  return config;
}

export async function loadConfig(options = {}) {
  const home = options.home ?? os.homedir();
  const filePath = configPathFor(home);

  // Stat before reading: `watch`'s live loop calls loadConfig() roughly
  // every 350ms, so an absurdly large config.json would otherwise get fully
  // read and re-parsed on every frame. Mirrors the MAX_STDIN_BYTES cap in
  // io.mjs's readJsonStdin.
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_CONFIG_BYTES) {
      return {
        config: structuredClone(DEFAULTS),
        path: filePath,
        exists: true,
        warnings: [`invalid config in ${filePath}: file too large (>${MAX_CONFIG_BYTES} bytes); using defaults`],
      };
    }
  } catch {
    // Missing/unreadable file: fall through to the readFile attempt below,
    // which already handles this the same way (exists:false, no warning).
  }

  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return { config: structuredClone(DEFAULTS), path: filePath, exists: false, warnings: [] };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      config: structuredClone(DEFAULTS),
      path: filePath,
      exists: true,
      warnings: [`invalid JSON in ${filePath}; using defaults`],
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      config: structuredClone(DEFAULTS),
      path: filePath,
      exists: true,
      warnings: [`invalid config in ${filePath}: expected a JSON object; using defaults`],
    };
  }

  const warnings = [];
  const config = mergeInto(structuredClone(DEFAULTS), parsed, warnings);
  return { config, path: filePath, exists: true, warnings };
}

function deepMergePatch(base, patch) {
  if (!isPlainObject(patch)) return patch;
  const result = { ...(isPlainObject(base) ? base : {}) };
  for (const [key, value] of Object.entries(patch)) {
    result[key] = isPlainObject(value) && isPlainObject(result[key])
      ? deepMergePatch(result[key], value)
      : value;
  }
  return result;
}

async function atomicWrite(filePath, content) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.chmod(dir, 0o700);
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(temporary, 0o600);
  await fs.rename(temporary, filePath);
}

export async function writeConfigPatch(patch, options = {}) {
  const home = options.home ?? os.homedir();
  const filePath = configPathFor(home);

  let original = "";
  let existing = {};
  try {
    original = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (original) {
    try {
      existing = JSON.parse(original);
    } catch {
      const error = new Error(`invalid JSON in ${filePath}; refusing to merge preset write`);
      error.code = "AHUD_CONFIG_INVALID";
      throw error;
    }
  }

  const merged = deepMergePatch(existing, patch);
  const content = `${JSON.stringify(merged, null, 2)}\n`;
  const changed = content !== original;

  if (!changed || options.dryRun) {
    return { path: filePath, changed, content };
  }

  await atomicWrite(filePath, content);
  return { path: filePath, changed: true, content };
}

export function isPlatformEnabled(config, platform) {
  return config?.enabled !== false && config?.platforms?.[platform] !== false;
}
