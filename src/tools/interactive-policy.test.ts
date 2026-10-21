import { afterEach, describe, expect, test } from "bun:test";
import { INTERACTIVE_USER_INPUT_TOOL_NAMES } from "./interactive-policy";
import {
  clearExternalTools,
  prepareToolExecutionContextForModel,
  registerExternalTools,
} from "./manager";

describe("interactive user-input tool policy", () => {
  afterEach(() => {
    clearExternalTools();
  });

  test("explicit exclusion overrides async question inclusion without filtering external tools", async () => {
    registerExternalTools([
      {
        name: "get_weather",
        description: "Get the weather",
        parameters: { type: "object", properties: {} },
      },
    ]);

    const prepared = await prepareToolExecutionContextForModel(
      "anthropic/claude-sonnet-4",
      {
        include: ["AskUserQuestionAsync"],
        exclude: [...INTERACTIVE_USER_INPUT_TOOL_NAMES],
      },
    );
    const names = prepared.clientTools.map((tool) => tool.name);

    expect(names).toContain("Bash");
    expect(names).toContain("get_weather");
    expect(names).not.toContain("AskUserQuestion");
  });

  test("questions are available only when explicitly included", async () => {
    const prepared = await prepareToolExecutionContextForModel(
      "anthropic/claude-sonnet-4",
      { include: ["AskUserQuestionAsync"] },
    );

    expect(prepared.clientTools.map((tool) => tool.name)).toContain(
      "AskUserQuestion",
    );
  });
});
