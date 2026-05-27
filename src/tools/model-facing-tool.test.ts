import { describe, expect, test } from "bun:test";
import {
  functionToolForm,
  type ModelFacingToolForm,
  serializeFunctionOnlyToolPayload,
} from "@/tools/model-facing-tool";

const fallbackParameters = {
  type: "object",
  properties: {
    input: { type: "string" },
  },
  required: ["input"],
  additionalProperties: false,
};

describe("model-facing tool serialization", () => {
  test("serializes function tools without changing their schema", () => {
    const form = functionToolForm({
      description: "Function description",
      parameters: fallbackParameters,
    });

    expect(serializeFunctionOnlyToolPayload("ExampleTool", form)).toEqual({
      name: "ExampleTool",
      description: "Function description",
      parameters: fallbackParameters,
    });
  });

  test("downgrades custom tools to their function fallback for function-only payloads", () => {
    const form: ModelFacingToolForm = {
      type: "custom",
      description: "Custom freeform description",
      format: { type: "text" },
      functionFallback: {
        type: "function",
        description: "Fallback function description",
        parameters: fallbackParameters,
      },
    };

    expect(serializeFunctionOnlyToolPayload("ExampleTool", form)).toEqual({
      name: "ExampleTool",
      description: "Fallback function description",
      parameters: fallbackParameters,
    });
  });

  test("keeps OpenAI custom-tool metadata separate from the function fallback", () => {
    const form: ModelFacingToolForm = {
      type: "custom",
      description: "Custom freeform description",
      format: {
        type: "grammar",
        syntax: "lark",
        definition: "start: /.+/",
      },
      functionFallback: {
        type: "function",
        description: "Fallback function description",
        parameters: fallbackParameters,
      },
    };

    expect(form).toMatchObject({
      type: "custom",
      description: "Custom freeform description",
      format: {
        type: "grammar",
        syntax: "lark",
        definition: "start: /.+/",
      },
    });
    expect(serializeFunctionOnlyToolPayload("ExampleTool", form)).toEqual({
      name: "ExampleTool",
      description: "Fallback function description",
      parameters: fallbackParameters,
    });
  });
});
