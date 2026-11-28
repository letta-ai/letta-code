import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBuffers } from "@/cli/helpers/accumulator";
import { StreamProcessor } from "@/cli/helpers/stream-processor";
import {
  commitMemoryAtBudgetStop,
  createHeadlessRunLimits,
} from "@/headless-run-limits";
import {
  addWorkflowRunCost,
  runSpend,
  setAgentRunCost,
} from "@/usage/run-budget";

const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });

test("a budget stop commits memory left uncommitted", () => {
  const dir = mkdtempSync(join(tmpdir(), "budget-stop-memory-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.name", "test");
  git(dir, "config", "user.email", "test@example.com");
  writeFileSync(join(dir, "MEMORY.md"), "# Memory\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  writeFileSync(join(dir, "notes.md"), "a lesson\n");
  commitMemoryAtBudgetStop(dir);
  expect(git(dir, "status", "--porcelain")).toBe("");
  expect(git(dir, "log", "-1", "--format=%s")).toContain("budget stop");
});

let budgetDir: string;
const originalLimit = process.env.LETTA_RUN_MAX_COST_USD;
const originalSpendFile = process.env.LETTA_RUN_SPEND_FILE;

beforeEach(() => {
  budgetDir = mkdtempSync(join(tmpdir(), "headless-budget-"));
  process.env.LETTA_RUN_SPEND_FILE = join(budgetDir, "spend.json");
  setAgentRunCost(0);
  addWorkflowRunCost(-runSpend());
});

afterEach(() => {
  setAgentRunCost(0);
  addWorkflowRunCost(-runSpend());
  if (originalLimit === undefined) delete process.env.LETTA_RUN_MAX_COST_USD;
  else process.env.LETTA_RUN_MAX_COST_USD = originalLimit;
  if (originalSpendFile === undefined) delete process.env.LETTA_RUN_SPEND_FILE;
  else process.env.LETTA_RUN_SPEND_FILE = originalSpendFile;
  rmSync(budgetDir, { recursive: true, force: true });
});

function createBudgetMeter(limit: number) {
  process.env.LETTA_RUN_MAX_COST_USD = String(limit);
  const { withUsageMeter, checkRunBudget } = createHeadlessRunLimits({
    maxTurns: undefined,
    buffers: createBuffers("agent-test"),
    outputFormat: "text",
    sessionId: "agent-budget-meter-test",
    model: "anthropic/claude-haiku-5-5",
    exit: async (_code, reason) => {
      throw new Error(reason);
    },
  });
  const hook = withUsageMeter();
  if (!hook) throw new Error("Usage meter is disabled");
  const streamProcessor = new StreamProcessor();
  return {
    async record(prompt: number, api_cost_usd?: number, shouldOutput = true) {
      const chunk = {
        message_type: "usage_statistics" as const,
        prompt_tokens: prompt,
        completion_tokens: 0,
        total_tokens: prompt,
        api_cost_usd,
      };
      await hook({ chunk, shouldOutput, streamProcessor });
      await checkRunBudget();
    },
    report() {
      return JSON.parse(readFileSync(join(budgetDir, "spend.json"), "utf8"));
    },
  };
}

test("short turns stay at base pricing when their combined input crosses the tier", async () => {
  const meter = createBudgetMeter(0.02);
  for (let turn = 0; turn < 3; turn++) {
    await meter.record(50_000);
  }
  await meter.record(50_000, undefined, false);
  expect(meter.report()).toMatchObject({ agent_usd: 0.015 });
  expect(meter.report().wrap_up).toBeUndefined();

  await meter.record(50_000, 0.002);
  expect(meter.report()).toMatchObject({ agent_usd: 0.017 });
  expect(meter.report().wrap_up).toContain("85%");

  await expect(meter.record(50_000, 0.003)).rejects.toThrow(
    "headless_run_budget_reached",
  );
  expect(meter.report()).toMatchObject({ agent_usd: 0.02, remaining_usd: 0 });
});

test("a single long-context turn uses the higher tier", async () => {
  const meter = createBudgetMeter(1);
  await meter.record(120_000);
  expect(meter.report()).toMatchObject({ agent_usd: 0.06 });
});
