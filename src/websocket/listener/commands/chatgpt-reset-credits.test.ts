import { describe, expect, test } from "bun:test";
import type {
  ConsumeChatGPTRateLimitResetCreditInput,
  ReadChatGPTRateLimitResetCreditsInput,
} from "@/providers/chatgpt-reset-credit-service";
import {
  buildChatGPTResetCreditConsumeResponse,
  buildChatGPTResetCreditsListResponse,
} from "@/websocket/listener/commands/chatgpt-reset-credits";

const credits = {
  providerName: "chatgpt-pro",
  fetchedAt: "2026-08-06T12:00:00.000Z",
  availableCount: 1,
  credits: [
    {
      id: "credit-1",
      resetType: "weekly",
      status: "available",
      grantedAt: "2026-08-01T12:00:00.000Z",
      expiresAt: null,
      title: "Weekly reset",
      description: null,
    },
  ],
};

describe("ChatGPT reset-credit listener commands", () => {
  test("builds list responses and forwards the refresh flag", async () => {
    let received: ReadChatGPTRateLimitResetCreditsInput | undefined;
    const response = await buildChatGPTResetCreditsListResponse(
      {
        type: "chatgpt_rate_limit_reset_credits_list",
        request_id: "list-1",
        target: "api",
        provider_name: "chatgpt-pro",
        force_refresh: true,
      },
      {
        readCredits: async (input) => {
          received = input;
          return { success: true, credits };
        },
      },
    );

    expect(received).toMatchObject({
      target: "api",
      providerName: "chatgpt-pro",
      forceRefresh: true,
    });
    expect(response).toEqual({
      type: "chatgpt_rate_limit_reset_credits_list_response",
      request_id: "list-1",
      success: true,
      target: "api",
      credits,
    });
  });

  test("forwards idempotency fields and includes refreshed state", async () => {
    let received: ConsumeChatGPTRateLimitResetCreditInput | undefined;
    const refreshedUsage = {
      providerName: "chatgpt-pro",
      fetchedAt: "2026-08-06T12:00:01.000Z",
      summary: "100% left",
      primary: null,
      secondary: null,
      additional: [],
    };
    const response = await buildChatGPTResetCreditConsumeResponse(
      {
        type: "chatgpt_rate_limit_reset_credit_consume",
        request_id: "consume-1",
        target: "local",
        provider_name: "chatgpt-pro",
        idempotency_key: "redeem-1",
        reset_id: "credit-1",
      },
      {
        consumeCredit: async (input) => {
          received = input;
          return {
            success: true,
            outcome: "reset",
            refreshedUsage,
            refreshedCredits: credits,
          };
        },
      },
    );

    expect(received).toMatchObject({
      target: "local",
      providerName: "chatgpt-pro",
      idempotencyKey: "redeem-1",
      resetId: "credit-1",
    });
    expect(response).toMatchObject({
      type: "chatgpt_rate_limit_reset_credit_consume_response",
      request_id: "consume-1",
      success: true,
      outcome: "reset",
      refreshed_usage: refreshedUsage,
      refreshed_credits: credits,
    });
  });

  test("returns structured service errors", async () => {
    const response = await buildChatGPTResetCreditConsumeResponse(
      {
        type: "chatgpt_rate_limit_reset_credit_consume",
        request_id: "consume-2",
        target: "api",
        idempotency_key: "redeem-2",
      },
      {
        consumeCredit: async () => ({
          success: false,
          error: {
            code: "rate_limited",
            message: "Try again later.",
            retryAfterMs: 1_000,
          },
        }),
      },
    );

    expect(response).toEqual({
      type: "chatgpt_rate_limit_reset_credit_consume_response",
      request_id: "consume-2",
      success: false,
      target: "api",
      error: {
        code: "rate_limited",
        message: "Try again later.",
        retryAfterMs: 1_000,
      },
    });
  });
});
