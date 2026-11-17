import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addWorkflowRunCost,
  runBudgetExceeded,
  runSpend,
  setAgentRunCost,
} from "@/usage/run-budget";

afterEach(() => {
  delete process.env.LETTA_RUN_MAX_COST_USD;
  delete process.env.LETTA_RUN_SPEND_FILE;
});

test("the run budget counts the agent's own cost and its Workflow subagents", () => {
  const file = join(tmpdir(), `run-budget-test-${process.pid}.json`);
  process.env.LETTA_RUN_MAX_COST_USD = "10";
  process.env.LETTA_RUN_SPEND_FILE = file;
  setAgentRunCost(4);
  addWorkflowRunCost(5);
  expect(runSpend()).toBe(9);
  expect(runBudgetExceeded()).toBe(false);
  setAgentRunCost(5); // cumulative, so it replaces the earlier 4
  expect(runBudgetExceeded()).toBe(true);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
    spent_usd: 10,
    limit_usd: 10,
    remaining_usd: 0,
    agent_usd: 5,
    workflow_usd: 5,
  });
});
