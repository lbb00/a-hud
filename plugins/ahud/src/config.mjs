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
    if (!KNOWN_TOP_KEYS.has(key)) {
      config[key] = value;
      continue;
    }

    if (key === "enabled") {
      config.enabled = validateBoolean(value, warnings, "enabled", true);
      continue;
    }

    if (!isPlainObject(value)) continue;

    if (key === "platforms") {
      const platforms = { ...config.platforms };
      for (const [subKey, subValue] of Object.entries(value)) {
        platforms[subKey] = validateBoolean(subValue, warnings, `platforms.${subKey}`, true);
      }
      config.platforms = platforms;
      continue;
    }

    if (key === "adapter") {
      const adapter = { ...config.adapter };
      for (const [subKey, subValue] of Object.entries(value)) {
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
