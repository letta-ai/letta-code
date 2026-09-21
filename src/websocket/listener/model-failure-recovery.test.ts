import { describe, expect, test } from "bun:test";
import type { ChatGPTPlanRotationResult } from "@/agent/chatgpt-plan-rotation";
import {
  LISTENER_TEMP_AUTO_MODEL,
  type RecoveryDependencies,
  recoverListenerModelFailure,
} from "./model-failure-recovery";

describe("recoverListenerModelFailure", () => {
  const quotaError = {
    error_code: "usage_limit_reached",
  };
  const authError = {
    error_type: "llm_authentication",
    message:
      "Failed to refresh ChatGPT OAuth token: refresh token is invalid or expired",
  };

  function createMockDependencies(
    overrides: Partial<RecoveryDependencies> = {},
  ): RecoveryDependencies {
    return {
      rotatePlan: async () => null,
      supportsHostedAuto: () => true,
      autoSwapEnabled: () => true,
      ...overrides,
    };
  }

  test("rejects initial authentication failure without preceding quota rotation", async () => {
    let rotateCalled = false;
    const dependencies = createMockDependencies({
      rotatePlan: async () => {
        rotateCalled = true;
        return null;
      },
    });

    const result = await recoverListenerModelFailure({
      agentId: "agent-1",
      conversationId: "conv-1",
      error: authError,
      errorDetail:
        "Failed to refresh ChatGPT OAuth token: refresh token is invalid or expired",
      exhaustedProviders: new Set(),
      chatgptPlanSwaps: 0,
      autoFallbackAttempted: false,
      dependencies,
    });

    expect(result).toBeNull();
    expect(rotateCalled).toBe(false);
  });

  test("rotates to a sibling plan on quota failure", async () => {
    const mockRotation: ChatGPTPlanRotationResult = {
      fromProvider: "chatgpt-caren",
      toProvider: "chatgpt-jin",
      toHandle: "chatgpt-jin/gpt-5.2",
      resetsAt: null,
      failureKind: "quota",
    };
    const dependencies = createMockDependencies({
      rotatePlan: async () => mockRotation,
    });

    const result = await recoverListenerModelFailure({
      agentId: "agent-1",
      conversationId: "conv-1",
      error: quotaError,
      errorDetail: null,
      exhaustedProviders: new Set(),
      chatgptPlanSwaps: 0,
      autoFallbackAttempted: false,
      dependencies,
    });

    expect(result).toEqual({
      kind: "plan_rotation",
      message: "chatgpt-caren hit its usage limit — switched to chatgpt-jin",
      chatgptPlanSwaps: 1,
    });
  });

  test("rotates to a sibling plan on auth failure after prior quota rotation", async () => {
    const mockRotation: ChatGPTPlanRotationResult = {
      fromProvider: "chatgpt-ari",
      toProvider: "chatgpt-jin",
      toHandle: "chatgpt-jin/gpt-5.2",
      resetsAt: null,
      failureKind: "authentication",
    };
    const dependencies = createMockDependencies({
      rotatePlan: async () => mockRotation,
    });

    const result = await recoverListenerModelFailure({
      agentId: "agent-1",
      conversationId: "conv-1",
      error: authError,
      errorDetail:
        "Failed to refresh ChatGPT OAuth token: refresh token is invalid or expired",
      exhaustedProviders: new Set(["chatgpt-caren"]),
      chatgptPlanSwaps: 1,
      autoFallbackAttempted: false,
      dependencies,
    });

    expect(result).toEqual({
      kind: "plan_rotation",
      message: "chatgpt-ari credentials expired — switched to chatgpt-jin",
      chatgptPlanSwaps: 2,
    });
  });

  test("falls back temporarily to Auto when rotated plan has expired credentials and no sibling remains", async () => {
    const dependencies = createMockDependencies({
      rotatePlan: async () => null,
      supportsHostedAuto: () => true,
      autoSwapEnabled: () => true,
    });

    const result = await recoverListenerModelFailure({
      agentId: "agent-1",
      conversationId: "conv-1",
      error: authError,
      errorDetail:
        "Failed to refresh ChatGPT OAuth token: refresh token is invalid or expired",
      exhaustedProviders: new Set(["chatgpt-hi-letta", "chatgpt-ari"]),
      chatgptPlanSwaps: 1,
      autoFallbackAttempted: false,
      dependencies,
    });

    expect(result).toEqual({
      kind: "auto_fallback",
      message:
        "The automatically selected ChatGPT account needs to reconnect; temporarily switching to Auto and continuing...",
      overrideModel: LISTENER_TEMP_AUTO_MODEL,
    });
  });

  test("falls back temporarily to Auto when quota limit is reached and no sibling remains", async () => {
    const dependencies = createMockDependencies({
      rotatePlan: async () => null,
      supportsHostedAuto: () => true,
      autoSwapEnabled: () => true,
    });

    const result = await recoverListenerModelFailure({
      agentId: "agent-1",
      conversationId: "conv-1",
      error: quotaError,
      errorDetail: "usage_limit_reached",
      exhaustedProviders: new Set(["chatgpt-hi-letta"]),
      chatgptPlanSwaps: 0,
      autoFallbackAttempted: false,
      dependencies,
    });

    expect(result).toEqual({
      kind: "auto_fallback",
      message:
        "Quota limit reached; temporarily switching to Auto and continuing...",
      overrideModel: LISTENER_TEMP_AUTO_MODEL,
    });
  });

  test("does not attempt Auto fallback if already attempted or already active", async () => {
    const dependencies = createMockDependencies({
      rotatePlan: async () => null,
    });

    const alreadyAttempted = await recoverListenerModelFailure({
      agentId: "agent-1",
      conversationId: "conv-1",
      error: quotaError,
      errorDetail: "usage_limit_reached",
      exhaustedProviders: new Set(["chatgpt-hi-letta"]),
      chatgptPlanSwaps: 0,
      autoFallbackAttempted: true,
      dependencies,
    });
    expect(alreadyAttempted).toBeNull();

    const alreadyActive = await recoverListenerModelFailure({
      agentId: "agent-1",
      conversationId: "conv-1",
      error: quotaError,
      errorDetail: "usage_limit_reached",
      exhaustedProviders: new Set(["chatgpt-hi-letta"]),
      chatgptPlanSwaps: 0,
      autoFallbackAttempted: false,
      activeOverrideModel: LISTENER_TEMP_AUTO_MODEL,
      dependencies,
    });
    expect(alreadyActive).toBeNull();
  });

  test("does not attempt Auto fallback if hosted Auto is unsupported or disabled", async () => {
    const unsupported = await recoverListenerModelFailure({
      agentId: "agent-1",
      conversationId: "conv-1",
      error: quotaError,
      errorDetail: "usage_limit_reached",
      exhaustedProviders: new Set(["chatgpt-hi-letta"]),
      chatgptPlanSwaps: 0,
      autoFallbackAttempted: false,
      dependencies: createMockDependencies({
        supportsHostedAuto: () => false,
      }),
    });
    expect(unsupported).toBeNull();

    const disabled = await recoverListenerModelFailure({
      agentId: "agent-1",
      conversationId: "conv-1",
      error: quotaError,
      errorDetail: "usage_limit_reached",
      exhaustedProviders: new Set(["chatgpt-hi-letta"]),
      chatgptPlanSwaps: 0,
      autoFallbackAttempted: false,
      dependencies: createMockDependencies({
        autoSwapEnabled: () => false,
      }),
    });
    expect(disabled).toBeNull();
  });
});
