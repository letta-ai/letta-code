import { describe, expect, test } from "bun:test";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { calculateUsageCost, priceUsageEvent, resolveCostModel } from "./cost";

const model = ANTHROPIC_MODELS["claude-sonnet-4-5"];

describe("client usage cost", () => {
  test("prices input and output from the catalog", () => {
    expect(
      calculateUsageCost(model, { input: 1_000, output: 100 }),
    ).toBeCloseTo(0.0045);
  });
  test("prices cache reads, short writes and one-hour writes separately", () => {
    expect(
      calculateUsageCost(model, {
        input: 100,
        output: 40,
        cacheRead: 200,
        cacheWrite: 50,
        cacheWrite1h: 20,
      }),
    ).toBeCloseTo(0.0011925);
  });
  test("adds separately billed reasoning without counting included reasoning twice", () => {
    expect(
      calculateUsageCost(model, {
        input: 0,
        output: 10,
        reasoningSeparate: 20,
      }),
    ).toBeCloseTo(0.00045);
  });
  test.each(["ollama", "lmstudio", "llama-cpp"])("%s is free", (provider) => {
    expect(
      calculateUsageCost(`${provider}/custom`, { input: 100, output: 20 }),
    ).toBe(0);
  });
  test.each(["unknown/model", "ollama-cloud/custom", "openai/not-a-model"])(
    "%s is unpriced",
    (handle) => {
      expect(calculateUsageCost(handle, { input: 100, output: 20 })).toBeNull();
    },
  );
  test("zero rates and malformed usage fail closed", () => {
    expect(
      calculateUsageCost(
        {
          ...model,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
        { input: 100, output: 20 },
      ),
    ).toBeNull();
    expect(
      calculateUsageCost(model, { input: Number.NaN, output: 20 }),
    ).toBeNull();
  });
  test("cloud handles map to exact catalog entries", () => {
    expect(resolveCostModel("anthropic/claude-sonnet-4-5")?.id).toBe(model.id);
    expect(resolveCostModel("openai/gpt-4o")?.provider).toBe("openai");
    expect(resolveCostModel("google_ai/gemini-2.5-pro")?.provider).toBe(
      "google",
    );
    expect(
      resolveCostModel("bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0")
        ?.provider,
    ).toBe("amazon-bedrock");
  });
  test("context tier rates are selected using all input tokens", () => {
    const tiered = {
      ...model,
      cost: {
        ...model.cost,
        tiers: [
          {
            inputTokensAbove: 100,
            input: 6,
            output: 30,
            cacheRead: 0.6,
            cacheWrite: 7.5,
          },
        ],
      },
    };
    expect(
      calculateUsageCost(tiered, { input: 80, cacheRead: 30, output: 10 }),
    ).toBeCloseTo(0.000798);
  });
  test("normalizes inclusive cloud cache counts and separate local cache counts", () => {
    const shared = {
      message_type: "usage_statistics",
      completion_tokens: 100,
      cached_input_tokens: 500,
      cache_write_tokens: 100,
      cache_write_1h_tokens: 20,
      reasoning_tokens: 30,
      total_tokens: 1200,
    };
    const cloud = priceUsageEvent(
      { ...shared, prompt_tokens: 1100 },
      "anthropic/claude-sonnet-4-5",
    );
    const local = priceUsageEvent(
      { ...shared, prompt_tokens: 500 },
      "anthropic/claude-sonnet-4-5",
    );
    expect(cloud.api_cost_usd).toBeCloseTo(0.00357);
    expect(local.api_cost_usd).toBeCloseTo(cloud.api_cost_usd as number);
  });
  test("ambiguous cache accounting fails closed", () => {
    const event = {
      message_type: "usage_statistics",
      prompt_tokens: 1000,
      completion_tokens: 100,
      cached_input_tokens: 500,
      cost_usd: 99,
    };
    expect(
      priceUsageEvent(event, "anthropic/claude-sonnet-4-5").api_cost_usd,
    ).toBeNull();
  });
  test.each([undefined, 99, null])(
    "ignores server cost %s on cloud events",
    (cost_usd) => {
      const event = {
        message_type: "usage_statistics",
        prompt_tokens: 1000,
        completion_tokens: 100,
        cost_usd,
      };
      expect(
        priceUsageEvent(event, "anthropic/claude-sonnet-4-5").api_cost_usd,
      ).toBeCloseTo(0.0045);
      expect(priceUsageEvent(event, "unknown/model").api_cost_usd).toBeNull();
    },
  );
});
