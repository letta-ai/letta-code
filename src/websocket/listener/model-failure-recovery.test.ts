import { describe, expect, mock, test } from "bun:test";
import type { ChatGPTPlanRotationResult } from "@/agent/chatgpt-plan-rotation";
import { TEMP_QUOTA_OVERRIDE_MODEL } from "@/agent/turn-recovery-policy";
import {
  type RecoveryDependencies,
  recoverListenerModelFailure,
} from "./model-failure-recovery";

const quotaError = { error_code: "usage_limit_reached" };
const authError = {
  error_type: "llm_authentication",
  retryable: false,
  detail:
    "Failed to refresh ChatGPT OAuth token: refresh token is invalid or expired",
};

function dependencies(
  rotation: ChatGPTPlanRotationResult | null,
  options: { hosted?: boolean; enabled?: boolean } = {},
) {
  const rotatePlan = mock(async () => rotation);
  const value: RecoveryDependencies = {
    rotatePlan,
    supportsHostedAuto: () => options.hosted ?? true,
    autoSwapEnabled: () => options.enabled ?? true,
  };
  return { rotatePlan, value };
}

function recover(
  error: unknown,
  overrides: Partial<Parameters<typeof recoverListenerModelFailure>[0]> = {},
) {
  return recoverListenerModelFailure({
    agentId: "agent-1",
    conversationId: "conv-1",
    error,
    errorDetail:
      error === quotaError ? "provider says usage_limit_reached" : null,
    exhaustedProviders: new Set(),
    chatgptPlanSwaps: 0,
    autoFallbackAttempted: false,
    ...overrides,
  });
}

describe("recoverListenerModelFailure", () => {
  test("rotates a quota-exhausted plan before considering Auto", async () => {
    const { rotatePlan, value } = dependencies({
      fromProvider: "chatgpt-a",
      toProvider: "chatgpt-b",
      toHandle: "chatgpt-b/gpt-5.6",
      resetsAt: null,
      failureKind: "quota",
    });

    await expect(recover(quotaError, { dependencies: value })).resolves.toEqual(
      {
        kind: "plan_rotation",
        message: "chatgpt-a hit its usage limit — switched to chatgpt-b",
        chatgptPlanSwaps: 1,
        overrideModel: "chatgpt-b/gpt-5.6",
        attempt: 1,
        maxAttempts: 3,
      },
    );
    expect(rotatePlan).toHaveBeenCalledTimes(1);
  });

  test("does not hide an initial explicit account authentication failure", async () => {
    const { rotatePlan, value } = dependencies(null);

    await expect(
      recover(authError, { dependencies: value }),
    ).resolves.toBeNull();
    expect(rotatePlan).not.toHaveBeenCalled();
  });

  test("skips an expired account after quota recovery has started", async () => {
    const { value } = dependencies({
      fromProvider: "chatgpt-b",
      toProvider: "chatgpt-c",
      toHandle: "chatgpt-c/gpt-5.6",
      resetsAt: null,
      failureKind: "authentication",
    });

    await expect(
      recover(authError, { chatgptPlanSwaps: 1, dependencies: value }),
    ).resolves.toMatchObject({
      kind: "plan_rotation",
      message: "chatgpt-b credentials expired — switched to chatgpt-c",
      chatgptPlanSwaps: 2,
      overrideModel: "chatgpt-c/gpt-5.6",
    });
  });

  test("falls back to request-scoped Auto after the recovery chain runs dry", async () => {
    const { value } = dependencies(null);

    await expect(
      recover(authError, { chatgptPlanSwaps: 1, dependencies: value }),
    ).resolves.toEqual({
      kind: "auto_fallback",
      message:
        "The automatically selected ChatGPT account needs to reconnect; temporarily switching to Auto and continuing...",
      overrideModel: TEMP_QUOTA_OVERRIDE_MODEL,
      attempt: 1,
      maxAttempts: 1,
    });
  });

  test("does not use hosted Auto when disabled, local, attempted, or active", async () => {
    const disabled = dependencies(null, { enabled: false }).value;
    const local = dependencies(null, { hosted: false }).value;

    await expect(
      recover(quotaError, { dependencies: disabled }),
    ).resolves.toBeNull();
    await expect(
      recover(quotaError, { dependencies: local }),
    ).resolves.toBeNull();
    await expect(
      recover(quotaError, {
        dependencies: dependencies(null).value,
        autoFallbackAttempted: true,
      }),
    ).resolves.toBeNull();
    await expect(
      recover(authError, {
        dependencies: dependencies(null).value,
        chatgptPlanSwaps: 1,
        activeOverrideModel: TEMP_QUOTA_OVERRIDE_MODEL,
      }),
    ).resolves.toBeNull();
  });
});
