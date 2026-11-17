import { writeFileSync } from "node:fs";

/**
 * A spending limit for a whole headless run: the agent's own model usage plus
 * every Workflow subagent it starts. `letta dream --dynamic` sets it through
 * LETTA_RUN_MAX_COST_USD; without it nothing here has any effect.
 * The current spend is written to LETTA_RUN_SPEND_FILE so the agent can read it.
 */
let agentUsd = 0;
let workflowUsd = 0;

export function runBudgetLimit(): number | undefined {
  const limit = Number(process.env.LETTA_RUN_MAX_COST_USD);
  return Number.isFinite(limit) && limit > 0 ? limit : undefined;
}

export function runSpend(): number {
  return agentUsd + workflowUsd;
}

function publish(): void {
  const file = process.env.LETTA_RUN_SPEND_FILE;
  const limit = runBudgetLimit();
  if (!file || limit === undefined) return;
  const spent = runSpend();
  try {
    writeFileSync(
      file,
      `${JSON.stringify({ spent_usd: +spent.toFixed(4), limit_usd: limit, remaining_usd: +Math.max(0, limit - spent).toFixed(4), agent_usd: +agentUsd.toFixed(4), workflow_usd: +workflowUsd.toFixed(4) })}\n`,
    );
  } catch {
    // Reporting spend is best effort; enforcement does not depend on it.
  }
}

/** The agent's own cumulative cost so far. */
export function setAgentRunCost(usd: number | null): void {
  if (usd === null || !Number.isFinite(usd)) return;
  agentUsd = usd;
  publish();
}

/** Cost added by a Workflow subagent. */
export function addWorkflowRunCost(deltaUsd: number): void {
  workflowUsd += deltaUsd;
  publish();
}

export function runBudgetExceeded(): boolean {
  const limit = runBudgetLimit();
  return limit !== undefined && runSpend() >= limit;
}
