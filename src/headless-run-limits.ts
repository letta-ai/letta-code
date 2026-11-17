import { randomUUID } from "node:crypto";
import type { Buffers } from "./cli/helpers/accumulator";
import { writeWireMessageAsync } from "./stream-json-writer";
import type { ErrorMessage } from "./types/protocol";
import { calculateUsageCost } from "./usage/cost";
import {
  runBudgetExceeded,
  runBudgetLimit,
  runSpend,
  setAgentRunCost,
} from "./usage/run-budget";

interface RunLimitOptions {
  maxTurns: number | undefined;
  buffers: Buffers;
  outputFormat: string;
  sessionId: string;
  /** Model handle used to price this agent's own usage for the run budget. */
  model: string | undefined;
  exit: (code: number, reason: string) => Promise<never>;
}

/**
 * Checks that end a one-shot run: `--max-turns` (server-side step count), and
 * the run-wide cost budget that `letta dream --dynamic` sets, which covers this
 * agent's own usage plus its Workflow subagents (charged by the engine).
 */
export function createHeadlessRunLimits(options: RunLimitOptions) {
  const { buffers, outputFormat } = options;
  const stop = async (message: string, reason: string, id: string) => {
    if (outputFormat === "stream-json") {
      const errorMsg: ErrorMessage = {
        type: "error",
        message,
        stop_reason: "max_steps",
        session_id: options.sessionId,
        uuid: `error-${id}-${randomUUID()}`,
      };
      await writeWireMessageAsync(errorMsg);
    } else {
      console.error(message);
    }
    await options.exit(1, reason);
  };

  const checkMaxTurns = async (): Promise<void> => {
    const { maxTurns } = options;
    if (maxTurns !== undefined && buffers.usage.stepCount >= maxTurns) {
      await stop(
        `Maximum turns limit reached (${buffers.usage.stepCount}/${maxTurns} steps)`,
        "headless_max_steps_reached",
        "max-turns",
      );
    }
  };

  const checkRunBudget = async (): Promise<void> => {
    const limit = runBudgetLimit();
    if (limit === undefined) return;
    const u = buffers.usage;
    setAgentRunCost(
      calculateUsageCost(options.model, {
        input: Math.max(
          0,
          u.promptTokens - u.cachedInputTokens - u.cacheWriteTokens,
        ),
        output: u.completionTokens,
        cacheRead: u.cachedInputTokens,
        cacheWrite: u.cacheWriteTokens,
      }),
    );
    if (runBudgetExceeded()) {
      await stop(
        `Run cost budget reached ($${runSpend().toFixed(2)} spent of $${limit})`,
        "headless_run_budget_reached",
        "run-budget",
      );
    }
  };

  return { checkMaxTurns, checkRunBudget };
}
