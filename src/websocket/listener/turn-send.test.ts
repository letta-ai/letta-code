import { describe, expect, test } from "bun:test";
import type { PreparedToolExecutionContext } from "@/tools/manager";
import { resolveDynamicTurnSendOptions } from "./turn-send";

describe("resolveDynamicTurnSendOptions", () => {
  test("reads the current model override and tool context for every retry", () => {
    const originalContext = {
      contextId: "context-chatgpt",
    } as PreparedToolExecutionContext;
    const autoContext = {
      contextId: "context-auto",
    } as PreparedToolExecutionContext;
    let overrideModel: string | undefined = "chatgpt-work/gpt-5.6";
    let preparedToolContext = originalContext;
    const params = {
      getOverrideModel: () => overrideModel,
      getPreparedToolContext: () => preparedToolContext,
    };

    expect(resolveDynamicTurnSendOptions(params)).toEqual({
      overrideModel: "chatgpt-work/gpt-5.6",
      preparedToolContext: originalContext,
    });

    overrideModel = "letta/auto";
    preparedToolContext = autoContext;
    expect(resolveDynamicTurnSendOptions(params)).toEqual({
      overrideModel: "letta/auto",
      preparedToolContext: autoContext,
    });
  });
});
