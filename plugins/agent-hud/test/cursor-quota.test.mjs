import assert from "node:assert/strict";
import test from "node:test";
import { renderSnapshot } from "../dist/render.js";

const DIM = "\u001b[2m";
const RED = "\u001b[31m";
const YELLOW = "\u001b[33m";
const RESET = "\u001b[0m";

function cursorLine(colors) {
  return renderSnapshot({
    platform: "cursor",
    model: "Grok 4.7",
    effort: "",
    project: "nook",
    cwd: "/nook",
    totalInput: null,
    contextSize: null,
    turns: 0,
    context: null,
    limits: [
      { label: "auto", percent: 3.89 },
      { label: "api", percent: 100 },
    ],
    resets: [],
    git: null,
    cost: null,
    tools: [],
    agents: [],
    plan: [],
  }, { colors, width: 80 }).split("\n")[0];
}

test("shows Cursor pools as a short pair and colors only the warning", () => {
  assert.equal(cursorLine(false), "Grok 4.7 | #3%/100%");
  const colored = cursorLine(true);
  assert.equal(colored, `Grok 4.7${DIM} | ${RESET}#3%/${RED}100%${RESET}`);
  assert.doesNotMatch(colored, /auto|api/);
});

test("keeps Claude's quota as one warning-colored token", () => {
  const line = renderSnapshot({
    platform: "claude",
    model: "Sonnet",
    effort: "",
    project: "nook",
    cwd: "/nook",
    totalInput: null,
    contextSize: null,
    turns: 0,
    context: null,
    limits: [
      { label: "5h", percent: 15.8 },
      { label: "7d", percent: 70.2 },
    ],
    resets: [],
    git: null,
    cost: null,
    tools: [],
    agents: [],
    plan: [],
  }, { colors: true, width: 80 }).split("\n")[0];
  assert.equal(line, `Sonnet${DIM} | ${RESET}${YELLOW}#15%/70%${RESET}`);
});
