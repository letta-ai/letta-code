import { describe, expect, test } from "bun:test";
import type { ListModelsResponseModelEntry } from "@/types/protocol_v2";
import { parseChannelModelArgs } from "./model-reasoning-command";
import {
  buildChannelReasoningOptions,
  buildChannelReasoningUpdatePayload,
} from "./model-reasoning-options";
import { buildSlackModelPickerBlocks } from "./slack/model-picker-blocks";

describe("buildChannelReasoningOptions", () => {
  test("returns catalog reasoning tiers for a known model", () => {
    const options = buildChannelReasoningOptions("openai/gpt-5.4", []);

    expect(options.map((option) => option.effort)).toContain("high");
    expect(options.every((option) => option.modelId !== "openai/gpt-5.4")).toBe(
      true,
    );
  });

  test("returns direct effort choices for an OpenAI-compatible proxy", () => {
    const options = buildChannelReasoningOptions("openai/gpt-5.4", [
      {
        id: "openai/gpt-5.4",
        handle: "openai/gpt-5.4",
        label: "Custom GPT-5",
        description: "",
        updateArgs: { openai_compatible_proxy: true },
        reasoningCapabilities: {
          supported_efforts: ["low", "high"],
          mandatory: true,
        },
      },
    ]);

    expect(options.map((option) => option.effort)).toEqual([
      null,
      "low",
      "high",
    ]);
    expect(options.every((option) => option.modelId === "openai/gpt-5.4")).toBe(
      true,
    );
  });

  test("keeps a rendered proxy Default selection executable", () => {
    const entry: ListModelsResponseModelEntry = {
      id: "openai/gpt-5.4",
      handle: "openai/gpt-5.4",
      label: "Custom GPT-5",
      description: "",
      updateArgs: { openai_compatible_proxy: true },
      reasoningCapabilities: { supported_efforts: ["low", "high"] },
    };
    const reasoningOptions = buildChannelReasoningOptions(entry.handle, [
      entry,
    ]);
    const blocks = buildSlackModelPickerBlocks({
      current: { modelLabel: entry.label, modelHandle: entry.handle },
      entries: [entry],
      reasoningOptions,
    }) as Array<{
      type?: string;
      elements?: Array<{
        action_id?: string;
        options?: Array<{ value?: string }>;
      }>;
    }>;
    const selectedValue = blocks
      .find((block) => block.type === "actions")
      ?.elements?.find(
        (element) => element.action_id === "letta_channel_reasoning_select",
      )
      ?.options?.find((option) => option.value === "default")?.value;

    const parsed = parseChannelModelArgs(`reasoning ${selectedValue}`);
    expect(parsed).toEqual({ kind: "reasoning", reasoningEffort: null });
    if (parsed.kind !== "reasoning") throw new Error("Expected reasoning");
    expect(
      buildChannelReasoningUpdatePayload(
        entry.handle,
        parsed.reasoningEffort,
        reasoningOptions,
      ),
    ).toEqual({
      model_id: entry.handle,
      model_handle: entry.handle,
      reasoning_effort: null,
    });
  });

  test("keeps reasoning choices in the current context-window variant", () => {
    const options = buildChannelReasoningOptions(
      "anthropic/claude-opus-4-8",
      [],
      950_000,
    );

    expect(options).not.toHaveLength(0);
    expect(options.every((option) => option.modelId.includes("1m"))).toBe(true);
  });

  test("uses provider type to resolve user-specific ChatGPT handles", () => {
    const options = buildChannelReasoningOptions(
      "chatgpt-jin/gpt-5.5",
      [],
      undefined,
      "chatgpt_oauth",
    );

    expect(options.map((option) => option.effort)).toContain("high");
    expect(options.find((option) => option.effort === "high")?.modelId).toBe(
      "gpt-5.5-plus-pro-high",
    );
  });

  test("does not offer reasoning for an unsupported model", () => {
    expect(buildChannelReasoningOptions("custom/plain-model", [])).toEqual([]);
  });
});
