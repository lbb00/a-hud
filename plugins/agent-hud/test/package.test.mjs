import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = path.resolve(root, "../..");

test("wires Oxlint into the workspace quality gate", async () => {
  const manifest = JSON.parse(
    await fs.readFile(path.join(workspaceRoot, "package.json"), "utf8"),
  );
  const config = JSON.parse(
    await fs.readFile(path.join(workspaceRoot, ".oxlintrc.json"), "utf8"),
  );

  assert.equal(manifest.scripts.lint, "oxlint . --deny-warnings");
  assert.match(manifest.scripts.check, /npm run lint/);
  assert.match(manifest.scripts.check, /npm run docs:check/);
  assert.match(manifest.scripts.test, /scripts\/\*\.test\.mjs/u);
  assert.match(manifest.scripts["release:check"], /npm run package:lint/);
  assert.match(manifest.scripts["package:lint"], /publint/u);
  assert.match(manifest.scripts["package:lint"], /attw/u);
  assert.equal(manifest.devDependencies.publint, "^0.3.22");
  assert.equal(manifest.devDependencies["@arethetypeswrong/cli"], "^0.18.5");
  assert.match(manifest.devDependencies.oxlint, /^\^1\./);
  assert.equal(manifest.engines.node, "^20.19.0 || >=22.12.0");
  assert.equal(manifest.engines.npm, ">=11.16.0");
  assert.equal(config.categories.correctness, "error");
  assert.equal(config.categories.suspicious, "error");
  assert.ok(config.ignorePatterns.includes("**/dist/**"));
  assert.deepEqual(
    config.plugins,
    ["eslint", "typescript", "unicorn", "oxc", "import", "node", "promise"],
  );
});

test("ships open-source governance, secure CI, and reviewed install scripts", async () => {
  const manifest = JSON.parse(
    await fs.readFile(path.join(workspaceRoot, "package.json"), "utf8"),
  );
  const pluginManifest = JSON.parse(
    await fs.readFile(path.join(root, "package.json"), "utf8"),
  );
  const providerManifest = JSON.parse(
    await fs.readFile(path.join(workspaceRoot, "packages/provider/package.json"), "utf8"),
  );
  const ci = await fs.readFile(
    path.join(workspaceRoot, ".github/workflows/ci.yml"),
    "utf8",
  );
  const policyFiles = [
    "CHANGELOG.md",
    "CODE_OF_CONDUCT.md",
    "CONTRIBUTING.md",
    "LICENSE",
    "SECURITY.md",
  ];

  await Promise.all(
    policyFiles.map((file) => fs.access(path.join(workspaceRoot, file))),
  );
  await fs.access(path.join(workspaceRoot, "packages/provider/LICENSE"));
  assert.equal(manifest.license, "MIT");
  assert.equal(pluginManifest.license, "MIT");
  assert.equal(providerManifest.license, "MIT");
  assert.equal(manifest.allowScripts["esbuild@0.25.12"], true);
  assert.equal(pluginManifest.files.includes("test"), false);
  assert.equal(pluginManifest.files.includes("src"), false);
  assert.ok(pluginManifest.files.includes("dist"));
  assert.ok(pluginManifest.files.includes("LICENSE"));
  assert.ok(pluginManifest.files.includes("README.zh-CN.md"));
  assert.deepEqual(pluginManifest.dependencies, undefined);
  assert.equal(pluginManifest.devDependencies["get-east-asian-width"], "^1.6.0");
  assert.ok(providerManifest.files.includes("LICENSE"));
  assert.ok(providerManifest.files.includes("README.zh-CN.md"));
  assert.match(ci, /^permissions:\n  contents: read$/mu);
  assert.match(ci, /npm run package:lint/u);
  assert.match(ci, /npm run package:smoke/u);
  assert.match(ci, /Published runtime \/ Node 18/u);
  assert.doesNotMatch(ci, /uses: [^@\n]+@v\d+/u);
  assert.match(ci, /actions\/checkout@[a-f\d]{40} # v7\.0\.1/u);
  assert.match(ci, /actions\/setup-node@[a-f\d]{40} # v6\.5\.0/u);
});

test("ships TypeScript source as an ESM package with a compiled CLI", async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(manifest.type, "module");
  assert.equal(manifest.bin["agent-hud"], "./dist/cli.js");
  const claudeManifest = JSON.parse(
    await fs.readFile(path.join(root, ".claude-plugin", "plugin.json"), "utf8"),
  );
  const codexManifest = JSON.parse(
    await fs.readFile(path.join(root, ".codex-plugin", "plugin.json"), "utf8"),
  );
  const cursorManifest = JSON.parse(
    await fs.readFile(path.join(root, ".cursor-plugin", "plugin.json"), "utf8"),
  );
  const antigravityManifest = JSON.parse(
    await fs.readFile(path.join(root, "plugin.json"), "utf8"),
  );
  assert.equal(claudeManifest.version, manifest.version);
  assert.equal(codexManifest.version, manifest.version);
  assert.equal(cursorManifest.version, manifest.version);
  assert.equal(antigravityManifest.name, manifest.name);

  const sourceFiles = (await fs.readdir(path.join(root, "src"))).sort();
  assert.ok(sourceFiles.includes("cli.ts"));
  assert.ok(sourceFiles.includes("types.ts"));
  assert.equal(sourceFiles.some((name) => name.endsWith(".mjs")), false);

  const builtCli = await fs.readFile(path.join(root, "dist", "cli.js"), "utf8");
  assert.match(builtCli, /^#!\/usr\/bin\/env node/);
  assert.doesNotMatch(builtCli, /from ["']@agent-hud\/provider["']/);
  assert.match(builtCli, /AGENT_HUD_DATA_DIR/);
});

test("keeps collection out of the UI plugin source", async () => {
  const sourceNames = await fs.readdir(path.join(root, "src"));
  assert.deepEqual(
    sourceNames.filter((name) => ["io.ts", "store.ts", "telemetry.ts", "git.ts"].includes(name)),
    [],
  );
  const renderSource = await fs.readFile(path.join(root, "src", "render.ts"), "utf8");
  assert.doesNotMatch(renderSource, /child_process|readFile|writeFile|fetch\(/);
});

test("compiled CLI runs from an isolated directory without provider node_modules", async (t) => {
  const isolated = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hud-bundle-"));
  t.after(() => fs.rm(isolated, { recursive: true, force: true }));
  await fs.copyFile(path.join(root, "dist", "cli.js"), path.join(isolated, "cli.mjs"));
  const result = spawnSync(process.execPath, [path.join(isolated, "cli.mjs"), "demo"], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^gpt-5\.6-sol \| H \| 90k\/45% 26t/);
});

test("registers only lifecycle hooks shared by Claude and Codex", async () => {
  const hooks = JSON.parse(await fs.readFile(path.join(root, "hooks", "hooks.json"), "utf8"));
  assert.ok(hooks.hooks.PostToolUseFailure);
  assert.ok(hooks.hooks.PermissionRequest);
  // Codex 0.146 does not accept Claude's Notification hook event in the shared
  // hook manifest. The provider can still consume it from Claude/user hooks.
  assert.equal(hooks.hooks.Notification, undefined);
});

test("UI adapter never reads a nested host status schema", async () => {
  const source = await fs.readFile(path.join(root, "src", "adapter.ts"), "utf8");
  assert.doesNotMatch(
    source,
    /ClaudeStatusInput|CursorStatusInput|AntigravityStatusInput|context_window|rate_limits|total_cost_usd/,
  );
  assert.match(source, /ClaudeSessionFacts/);
  assert.match(source, /HostSessionFacts/);
});

test("keeps the Chinese overview aligned with the setup contract", async () => {
  const rootReadme = await fs.readFile(
    path.join(workspaceRoot, "README.zh-CN.md"),
    "utf8",
  );

  assert.match(rootReadme, /`setup all` 会配置全部四个宿主/u);
  assert.match(rootReadme, /`setup both` 只配置 Claude Code 和 Codex/u);
  assert.match(rootReadme, /不展示不可用的 5h 额度/u);
  assert.match(rootReadme, /内部 transcript 不属于稳定契约，不会被解析/u);
  assert.doesNotMatch(rootReadme, /cli\.zh-CN\.md/iu);
});

test("documentation and comments do not reference external HUD projects", async () => {
  const excludedDirectories = new Set(["dist", "node_modules"]);
  const documentationExtensions = new Set([".md"]);
  const sourceExtensions = new Set([".js", ".mjs", ".sh", ".ts"]);
  const externalProjectNames = [
    ["claude", "hud"].join("-"),
    ["codex", "hud"].join("-"),
    ["codex", "bar"].join(""),
    ["ab", "top"].join(""),
    ["agent", "pulse"].join(""),
    ["cc", "statusline"].join(""),
    ["cc", "usage"].join(""),
    ["tmux", "agent", "status"].join("-"),
  ];
  const references = new RegExp(externalProjectNames.join("|"), "iu");

  async function scan(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (excludedDirectories.has(entry.name)) continue;
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await scan(filePath);
        continue;
      }

      const extension = path.extname(entry.name);
      if (!documentationExtensions.has(extension) && !sourceExtensions.has(extension)) {
        continue;
      }
      const content = await fs.readFile(filePath, "utf8");
      const inspected = documentationExtensions.has(extension)
        ? content
        : [
            ...content.matchAll(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gmu),
          ].map(([comment]) => comment).join("\n");
      assert.doesNotMatch(
        inspected,
        references,
        `${path.relative(workspaceRoot, filePath)} references an external HUD project`,
      );
    }
  }

  await scan(workspaceRoot);
});
