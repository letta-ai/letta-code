import { describe, expect, test } from "bun:test";
import { prepareToolExecutionContextForSpecificTools } from "@/tools/manager";
import {
  APPLY_PATCH_FREEFORM_DESCRIPTION,
  APPLY_PATCH_LARK_GRAMMAR,
  APPLY_PATCH_PASCAL_FREEFORM_DESCRIPTION,
  APPLY_PATCH_PI_CUSTOM_TOOL,
  buildPiToolDefinition,
} from "@/tools/pi-tool-definitions";

const APPLY_PATCH_FALLBACK_SCHEMA = {
  type: "object",
  properties: { input: { type: "string" } },
  required: ["input"],
  additionalProperties: false,
};

describe("pi tool definitions", () => {
  test("builds a custom tool with the normal function schema as fallback", () => {
    expect(
      buildPiToolDefinition({
        name: "apply_patch",
        description: "JSON schema fallback description",
        parameters: APPLY_PATCH_FALLBACK_SCHEMA,
        piCustomTool: APPLY_PATCH_PI_CUSTOM_TOOL,
      }),
    ).toEqual({
      type: "custom",
      name: "apply_patch",
      description: APPLY_PATCH_FREEFORM_DESCRIPTION,
      format: {
        type: "grammar",
        syntax: "lark",
        definition: APPLY_PATCH_LARK_GRAMMAR,
      },
      fallback: {
        description: "JSON schema fallback description",
        parameters: APPLY_PATCH_FALLBACK_SCHEMA,
      },
    });
  });

  test("keeps ordinary tools function-shaped", () => {
    expect(
      buildPiToolDefinition({
        name: "exec_command",
        description: "Run a command",
        parameters: {
          type: "object",
          properties: { cmd: { type: "string" } },
          required: ["cmd"],
        },
      }),
    ).toEqual({
      name: "exec_command",
      description: "Run a command",
      parameters: {
        type: "object",
        properties: { cmd: { type: "string" } },
        required: ["cmd"],
      },
    });
  });

  test("prepared contexts keep API tools as fallback functions and pi tools as native custom tools", async () => {
    const context = await prepareToolExecutionContextForSpecificTools([
      "apply_patch",
      "exec_command",
    ]);

    expect(
      context.clientTools.find((tool) => tool.name === "apply_patch"),
    ).toMatchObject({
      name: "apply_patch",
      description: expect.any(String),
      parameters: APPLY_PATCH_FALLBACK_SCHEMA,
    });

    expect(
      context.piTools.find((tool) => tool.name === "apply_patch"),
    ).toMatchObject({
      type: "custom",
      name: "apply_patch",
      description: APPLY_PATCH_FREEFORM_DESCRIPTION,
      fallback: {
        description: expect.any(String),
        parameters: APPLY_PATCH_FALLBACK_SCHEMA,
      },
    });

    expect(
      context.piTools.find((tool) => tool.name === "exec_command"),
    ).toMatchObject({
      name: "exec_command",
      description: expect.any(String),
      parameters: expect.any(Object),
    });
  });

  test("uses alias-specific custom descriptions", async () => {
    const context = await prepareToolExecutionContextForSpecificTools([
      "ApplyPatch",
    ]);

    expect(
      context.piTools.find((tool) => tool.name === "ApplyPatch"),
    ).toMatchObject({
      type: "custom",
      name: "ApplyPatch",
      description: APPLY_PATCH_PASCAL_FREEFORM_DESCRIPTION,
      fallback: {
        description: expect.any(String),
        parameters: APPLY_PATCH_FALLBACK_SCHEMA,
      },
    });
  });
});
