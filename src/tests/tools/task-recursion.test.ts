import { describe, expect, test } from "bun:test";
import {
  getTaskExecutionMetadata,
  getTaskRecursionLimitError,
} from "../../tools/impl/Task";

describe("Task recursion metadata", () => {
  test("derives child depth and inherited advisory budget", () => {
    const metadata = getTaskExecutionMetadata(undefined, {
      LETTA_TASK_DEPTH: "1",
      LETTA_TASK_MAX_DEPTH: "4",
      LETTA_TASK_BUDGET_TOKENS: "800",
    } as NodeJS.ProcessEnv);

    expect(metadata).toEqual({
      currentDepth: 1,
      childDepth: 2,
      maxDepth: 4,
      budgetTokens: 800,
    });
  });

  test("explicit budget overrides inherited advisory budget", () => {
    const metadata = getTaskExecutionMetadata(250, {
      LETTA_TASK_DEPTH: "0",
      LETTA_TASK_MAX_DEPTH: "5",
      LETTA_TASK_BUDGET_TOKENS: "800",
    } as NodeJS.ProcessEnv);

    expect(metadata.budgetTokens).toBe(250);
  });

  test("blocks recursion when current depth reaches configured max", () => {
    expect(
      getTaskRecursionLimitError({
        LETTA_TASK_DEPTH: "5",
        LETTA_TASK_MAX_DEPTH: "5",
      } as NodeJS.ProcessEnv),
    ).toBe(
      "Error: Task recursion limit reached at depth 5 (max 5). Further delegation is blocked.",
    );
  });

  test("allows recursion when current depth is below configured max", () => {
    expect(
      getTaskRecursionLimitError({
        LETTA_TASK_DEPTH: "4",
        LETTA_TASK_MAX_DEPTH: "5",
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });
});
