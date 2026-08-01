import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd ?? workspaceRoot,
    encoding: "utf8",
    // npm.cmd is a Windows batch file; spawnSync can't exec it directly there.
    shell: process.platform === "win32",
    env: {
      ...process.env,
      NO_COLOR: "1",
      npm_config_audit: "false",
      npm_config_fund: "false",
    },
  });
  assert.equal(
    result.status,
    0,
    [
      `${executable} ${args.join(" ")} failed`,
      result.error?.message,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join("\n"),
  );
  return result.stdout;
}

function packedPaths(metadata) {
  return metadata.files.map(({ path: filePath }) => filePath);
}

function assertIncludes(paths, expected, packageName) {
  for (const filePath of expected) {
    assert.ok(
      paths.includes(filePath),
      `${packageName} tarball is missing ${filePath}`,
    );
  }
}

function assertExcludesPrefixes(paths, prefixes, packageName) {
  for (const prefix of prefixes) {
    assert.equal(
      paths.some((filePath) => filePath.startsWith(prefix)),
      false,
      `${packageName} tarball unexpectedly contains ${prefix}`,
    );
  }
}

function pack(workspace, destination) {
  const output = run(npmExecutable, [
    "pack",
    "--json",
    "--pack-destination",
    destination,
    "--workspace",
    workspace,
  ]);
  const [metadata] = JSON.parse(output);
  assert.ok(metadata?.filename, `npm pack returned no filename for ${workspace}`);
  return {
    metadata,
    tarball: path.join(destination, metadata.filename),
  };
}

const temporaryRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), "agent-hud-package-smoke-"),
);

try {
  const provider = pack("@agent-hud/provider", temporaryRoot);
  const plugin = pack("agent-hud", temporaryRoot);
  const providerPaths = packedPaths(provider.metadata);
  const pluginPaths = packedPaths(plugin.metadata);

  assertIncludes(
    providerPaths,
    [
      "LICENSE",
      "README.md",
      "README.zh-CN.md",
      "dist/index.d.ts",
      "dist/index.js",
    ],
    provider.metadata.name,
  );
  assertExcludesPrefixes(
    providerPaths,
    ["src/", "test/"],
    provider.metadata.name,
  );

  assertIncludes(
    pluginPaths,
    [
      ".claude-plugin/plugin.json",
      ".codex-plugin/plugin.json",
      ".cursor-plugin/plugin.json",
      "LICENSE",
      "README.md",
      "README.zh-CN.md",
      "dist/cli.js",
      "docs/cli.md",
      "hooks/hooks.json",
      "plugin.json",
      "skills/agent-hud/SKILL.md",
    ],
    plugin.metadata.name,
  );
  assertExcludesPrefixes(
    pluginPaths,
    ["src/", "test/"],
    plugin.metadata.name,
  );

  const consumer = path.join(temporaryRoot, "consumer");
  await fs.mkdir(consumer);
  await fs.writeFile(
    path.join(consumer, "package.json"),
    JSON.stringify({ name: "agent-hud-smoke-consumer", private: true, type: "module" }),
  );
  run(
    npmExecutable,
    [
      "install",
      "--ignore-scripts",
      provider.tarball,
      plugin.tarball,
    ],
    { cwd: consumer },
  );

  const demo = run(
    process.execPath,
    [path.join(consumer, "node_modules", "agent-hud", "dist", "cli.js"), "demo"],
    { cwd: consumer },
  );
  assert.match(demo, /^gpt-5\.6-sol \| H \| 90k\/45% 26t/u);

  const providerProbe = [
    "import { contextPercent } from '@agent-hud/provider';",
    "const result = contextPercent({ context_window: { used_percentage: 42 } });",
    "if (result !== 42) throw new Error(`unexpected context: ${result}`);",
  ].join("\n");
  run(process.execPath, ["--input-type=module", "--eval", providerProbe], {
    cwd: consumer,
  });

  process.stdout.write(
    `Package smoke passed: ${provider.metadata.id}, ${plugin.metadata.id}\n`,
  );
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
