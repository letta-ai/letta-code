import { describe, expect, test } from "bun:test";
import {
  decideVerdict,
  diffModelsJson,
  type ModelsJson,
} from "./diff-models-json.ts";

function model(slug: string, extra: Record<string, unknown> = {}) {
  return {
    slug,
    apply_patch_tool_type: "freeform",
    shell_type: "shell_command",
    supports_parallel_tool_calls: true,
    supports_search_tool: true,
    experimental_supported_tools: [],
    base_instructions: "Use apply_patch and multi_tool_use.parallel.",
    model_messages: {
      instructions_template: "You may call view_image when needed.",
    },
    ...extra,
  };
}

function models(...entries: Array<Record<string, unknown>>): ModelsJson {
  return { models: entries };
}

describe("diffModelsJson", () => {
  test("detects tool schema field changes", () => {
    const diff = diffModelsJson(
      models(model("gpt-5.5")),
      models(model("gpt-5.5", { shell_type: "unified_exec" })),
    );

    expect(diff.has_tool_schema_change).toBe(true);
    expect(diff.field_deltas).toEqual([
      {
        slug: "gpt-5.5",
        field: "shell_type",
        previous: "shell_command",
        current: "unified_exec",
      },
    ]);
  });

  test("detects prompt tool mention changes separately", () => {
    const diff = diffModelsJson(
      models(model("gpt-5.5")),
      models(
        model("gpt-5.5", {
          base_instructions: "Use apply_patch and web_search.",
          model_messages: { instructions_template: "No image tool mention." },
        }),
      ),
    );

    expect(diff.has_tool_schema_change).toBe(false);
    expect(diff.has_prompt_tool_change).toBe(true);
    expect(diff.field_deltas.map((d) => d.field)).toEqual([
      "prompt_tool_mentions",
    ]);
  });

  test("reports added and removed models", () => {
    const diff = diffModelsJson(
      models(model("gpt-5.4"), model("gpt-5.5")),
      models(model("gpt-5.5"), model("gpt-5.6")),
    );

    expect(diff.added_models).toEqual(["gpt-5.6"]);
    expect(diff.removed_models).toEqual(["gpt-5.4"]);
  });
});

describe("decideVerdict", () => {
  test("returns no-op for empty diff", () => {
    const models_diff = diffModelsJson(
      models(model("gpt-5.5")),
      models(model("gpt-5.5")),
    );
    expect(
      decideVerdict({
        models_diff,
        prompt_md_changed: false,
        tools_dir_changed: false,
        apply_patch_dir_changed: false,
        parse_error: false,
      }),
    ).toBe("no-op");
  });

  test("returns tool-surface review needed when tools dir changed", () => {
    const models_diff = diffModelsJson(
      models(model("gpt-5.5")),
      models(model("gpt-5.5")),
    );
    expect(
      decideVerdict({
        models_diff,
        prompt_md_changed: false,
        tools_dir_changed: true,
        apply_patch_dir_changed: false,
        parse_error: false,
      }),
    ).toBe("tool-surface review needed");
  });

  test("returns tool-schema update needed for models.json schema fields", () => {
    const models_diff = diffModelsJson(
      models(model("gpt-5.5")),
      models(model("gpt-5.5", { shell_type: "unified_exec" })),
    );
    expect(
      decideVerdict({
        models_diff,
        prompt_md_changed: false,
        tools_dir_changed: false,
        apply_patch_dir_changed: false,
        parse_error: false,
      }),
    ).toBe("tool-schema update needed");
  });

  test("returns prompt-only update for prompt changes", () => {
    const models_diff = diffModelsJson(
      models(model("gpt-5.5")),
      models(model("gpt-5.5")),
    );
    expect(
      decideVerdict({
        models_diff,
        prompt_md_changed: true,
        tools_dir_changed: false,
        apply_patch_dir_changed: false,
        parse_error: false,
      }),
    ).toBe("prompt-only update");
  });

  test("returns manual review on parse error", () => {
    expect(
      decideVerdict({
        models_diff: null,
        prompt_md_changed: false,
        tools_dir_changed: false,
        apply_patch_dir_changed: false,
        parse_error: true,
      }),
    ).toBe("manual review required");
  });
});
