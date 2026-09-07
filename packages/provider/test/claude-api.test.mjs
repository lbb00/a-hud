import assert from "node:assert/strict";
import test from "node:test";
import { claudeApiEndpoint } from "../dist/index.js";

test("defaults ordinary Claude Code sessions to Anthropic's API", () => {
  assert.equal(claudeApiEndpoint({}), "api.anthropic.com");
  assert.equal(
    claudeApiEndpoint({ ANTHROPIC_BASE_URL: "" }),
    "api.anthropic.com",
    "the Anthropic SDK treats an empty base URL as its default",
  );
  assert.equal(
    claudeApiEndpoint({ CLAUDE_CODE_USE_BEDROCK: "0" }),
    "api.anthropic.com",
  );
  assert.equal(
    claudeApiEndpoint({ CLAUDE_CODE_USE_BEDROCK: "off" }),
    "api.anthropic.com",
  );
});

test("does not treat Claude control-plane URLs as model API routing", () => {
  assert.equal(
    claudeApiEndpoint({ CLAUDE_CODE_API_BASE_URL: "https://claude.example" }),
    "api.anthropic.com",
  );
  assert.equal(
    claudeApiEndpoint({ _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1" }),
    "api.anthropic.com",
  );
  assert.equal(
    claudeApiEndpoint({
      _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1",
      ANTHROPIC_BASE_URL: "https://model-gateway.example/v1",
    }),
    "model-gateway.example",
  );
});

test("uses Claude Code's explicit Anthropic-compatible base URL", () => {
  for (const [value, expected] of [
    ["https://api.deepseek.com/v1", "api.deepseek.com"],
    ["API.DeepSeek.com:443", "api.deepseek.com"],
    ["https://user:secret@127.0.0.1:8443/v1", "127.0.0.1"],
    ["https://[2001:db8::1]:8443/v1", "[2001:db8::1]"],
    ["https://API.ANTHROPIC.COM./v1", "api.anthropic.com"],
  ]) {
    assert.equal(claudeApiEndpoint({ ANTHROPIC_BASE_URL: value }), expected, value);
  }
});

test("treats present but unusable base URLs as unknown", () => {
  for (const value of [
    "   ",
    "http://",
    "not a URL",
    `https://${"a".repeat(201)}.example.com`,
  ]) {
    assert.equal(claudeApiEndpoint({ ANTHROPIC_BASE_URL: value }), undefined, value);
  }
});

test("does not claim Anthropic's API for cloud-provider modes", () => {
  const providers = [
    ["CLAUDE_CODE_USE_BEDROCK", "ANTHROPIC_BEDROCK_BASE_URL"],
    ["CLAUDE_CODE_USE_MANTLE", "ANTHROPIC_BEDROCK_MANTLE_BASE_URL"],
    ["CLAUDE_CODE_USE_VERTEX", "ANTHROPIC_VERTEX_BASE_URL"],
    ["CLAUDE_CODE_USE_FOUNDRY", "ANTHROPIC_FOUNDRY_BASE_URL"],
    ["CLAUDE_CODE_USE_ANTHROPIC_AWS", "ANTHROPIC_AWS_BASE_URL"],
    [
      "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
      "ANTHROPIC_GOOGLE_CLOUD_BASE_URL",
    ],
  ];
  for (const [flag, base] of providers) {
    assert.equal(claudeApiEndpoint({ [flag]: "1" }), undefined, flag);
    assert.equal(
      claudeApiEndpoint({
        [flag]: "true",
        [base]: "https://provider-gateway.example/v1",
      }),
      "provider-gateway.example",
      base,
    );
  }

  assert.equal(
    claudeApiEndpoint({ CLAUDE_CODE_USE_GATEWAY: "1" }),
    undefined,
    "a gateway route has no provider-specific base URL variable",
  );
  for (const value of ["yes", "on"]) {
    assert.equal(
      claudeApiEndpoint({ CLAUDE_CODE_USE_BEDROCK: value }),
      undefined,
      `Claude Code treats ${value} as an enabled boolean`,
    );
  }

  assert.equal(
    claudeApiEndpoint({
      CLAUDE_CODE_USE_BEDROCK: "true",
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/v1",
      ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock-gateway.example/v1",
    }),
    "bedrock-gateway.example",
  );
  assert.equal(
    claudeApiEndpoint({
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_MANTLE: "1",
      ANTHROPIC_BEDROCK_BASE_URL: "https://one.example",
      ANTHROPIC_BEDROCK_MANTLE_BASE_URL: "https://two.example",
    }),
    undefined,
    "a model-dependent multi-provider session has no single endpoint",
  );
});
