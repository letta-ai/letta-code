import { describe, expect, test } from "bun:test";
import {
  isChatGPTRateLimitResetCreditConsumeCommand,
  isChatGPTRateLimitResetCreditsListCommand,
  isChatGPTUsageReadCommand,
} from "@/websocket/listener/chatgpt-usage-protocol-inbound";
import { parseServerMessage } from "@/websocket/listener/protocol-inbound";

describe("ChatGPT usage protocol input", () => {
  test("preserves the existing usage read command", () => {
    expect(
      isChatGPTUsageReadCommand({
        type: "chatgpt_usage_read",
        request_id: "usage-1",
        target: "local",
        force_refresh: true,
      }),
    ).toBe(true);
  });

  test("parses reset-credit list commands", () => {
    const command = {
      type: "chatgpt_rate_limit_reset_credits_list",
      request_id: "credits-1",
      target: "api",
      provider_name: "chatgpt-pro",
      force_refresh: true,
    } as const;

    expect(isChatGPTRateLimitResetCreditsListCommand(command)).toBe(true);
    expect(parseServerMessage(Buffer.from(JSON.stringify(command)))).toEqual(
      command,
    );
  });

  test("parses reset-credit consume commands", () => {
    const command = {
      type: "chatgpt_rate_limit_reset_credit_consume",
      request_id: "consume-1",
      target: "local",
      idempotency_key: "redeem-1",
      reset_id: "credit-1",
    } as const;

    expect(isChatGPTRateLimitResetCreditConsumeCommand(command)).toBe(true);
    expect(parseServerMessage(Buffer.from(JSON.stringify(command)))).toEqual(
      command,
    );
  });

  test("rejects invalid reset-credit commands", () => {
    expect(
      isChatGPTRateLimitResetCreditConsumeCommand({
        type: "chatgpt_rate_limit_reset_credit_consume",
        request_id: "consume-1",
        target: "local",
        idempotency_key: " ",
      }),
    ).toBe(false);
    expect(
      isChatGPTRateLimitResetCreditsListCommand({
        type: "chatgpt_rate_limit_reset_credits_list",
        request_id: "credits-1",
        target: "workspace",
      }),
    ).toBe(false);
  });
});
