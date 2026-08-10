import { describe, expect, test } from "bun:test";
import {
  buildSlackModelPickerBlocks,
  resolveSlackSelectedModel,
  SLACK_MODEL_SELECT_ACTION_ID,
} from "@/channels-slack";

describe("public Slack model picker", () => {
  test("exports the shared picker blocks and action contract", () => {
    const blocks = buildSlackModelPickerBlocks({
      current: {
        modelLabel: "Auto",
        modelHandle: "letta/auto",
        scope: "conversation",
      },
      entries: [
        {
          id: "auto",
          handle: "letta/auto",
          label: "Auto",
          description: "Recommended default",
          isDefault: true,
        },
      ],
      availableHandles: ["letta/auto"],
      recentHandles: [],
    });

    expect(blocks).toContainEqual({
      type: "actions",
      elements: [
        expect.objectContaining({
          type: "static_select",
          action_id: SLACK_MODEL_SELECT_ACTION_ID,
        }),
      ],
    });
    expect(
      resolveSlackSelectedModel(undefined, {
        actions: [{ selected_option: { value: "letta/auto" } }],
      }),
    ).toBe("letta/auto");
  });
});
