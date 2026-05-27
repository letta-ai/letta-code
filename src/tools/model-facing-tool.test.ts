import { describe, expect, test } from "bun:test";
import {
  functionToolForm,
  type ModelFacingToolForm,
  serializeFunctionToolPayload,
  serializeProviderRuntimeToolPayload,
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

    expect(serializeFunctionToolPayload("ExampleTool", form)).toEqual({
      name: "ExampleTool",
      description: "Function description",
      parameters: fallbackParameters,
    });
    expect(serializeProviderRuntimeToolPayload("ExampleTool", form)).toEqual({
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
      fallback: {
        type: "function",
        description: "Fallback function description",
        parameters: fallbackParameters,
      },
    };

    expect(serializeFunctionToolPayload("ExampleTool", form)).toEqual({
      name: "ExampleTool",
      description: "Fallback function description",
      parameters: fallbackParameters,
    });
  });

  test("preserves custom metadata only for provider-runtime payloads", () => {
    const form: ModelFacingToolForm = {
      type: "custom",
      description: "Custom freeform description",
      format: {
        type: "grammar",
        syntax: "lark",
        definition: "start: /.+/",
      },
      fallback: {
        type: "function",
        description: "Fallback function description",
        parameters: fallbackParameters,
        inputField: "input",
      },
    };

    expect(serializeProviderRuntimeToolPayload("ExampleTool", form)).toEqual({
      type: "custom",
      name: "ExampleTool",
      description: "Custom freeform description",
      format: {
        type: "grammar",
        syntax: "lark",
        definition: "start: /.+/",
      },
      fallback: {
        description: "Fallback function description",
        parameters: fallbackParameters,
        inputField: "input",
      },
    });
  });
});
