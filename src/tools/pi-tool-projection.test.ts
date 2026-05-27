import { describe, expect, test } from "bun:test";
import {
  APPLY_PATCH_FREEFORM_DESCRIPTION,
  APPLY_PATCH_LARK_GRAMMAR,
  toPiTools,
} from "@/tools/pi-tool-projection";

describe("pi tool projection", () => {
  test("projects apply_patch as a pi custom tool with a function fallback", () => {
    const tools = toPiTools([
      {
        name: "apply_patch",
        description: "JSON schema fallback description",
        parameters: {
          type: "object",
          properties: { input: { type: "string" } },
          required: ["input"],
          additionalProperties: false,
        },
      },
    ]);

    expect(tools).toEqual([
      {
        type: "custom",
        name: "apply_patch",
        description: APPLY_PATCH_FREEFORM_DESCRIPTION,
        format: {
          type: "grammar",
          syntax: "lark",
          definition: APPLY_PATCH_LARK_GRAMMAR,
        },
        fallback: {
          parameters: {
            type: "object",
            properties: { input: { type: "string" } },
            required: ["input"],
            additionalProperties: false,
          },
        },
      },
    ]);
  });

  test("projects PascalCase ApplyPatch as a pi custom tool without changing execution name", () => {
    const tools = toPiTools([
      {
        name: "ApplyPatch",
        description: "JSON schema fallback description",
        parameters: {
          type: "object",
          properties: { input: { type: "string" } },
          required: ["input"],
        },
      },
    ]);

    expect(tools?.[0]).toMatchObject({
      type: "custom",
      name: "ApplyPatch",
      description: APPLY_PATCH_FREEFORM_DESCRIPTION,
      fallback: {
        parameters: {
          type: "object",
          properties: { input: { type: "string" } },
          required: ["input"],
        },
      },
    });
  });
});
