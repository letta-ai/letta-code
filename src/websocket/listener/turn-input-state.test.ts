import { describe, expect, test } from "bun:test";
import { normalizeMessageImageParts } from "@/utils/message-image-normalization";
import {
  createDeploymentRecoveryTurnInput,
  createTurnInputState,
  ensureTurnInputMessageOtids,
  rebuildTurnInputWithFreshDenials,
  refreshTurnInputOtidsForNewRequest,
} from "./turn-input-state";

describe("listener turn input state", () => {
  test("deployment recovery replaces accepted work with fresh internal continuations", () => {
    const first = createDeploymentRecoveryTurnInput();
    const second = createDeploymentRecoveryTurnInput();

    expect(first.messages).toHaveLength(1);
    expect(first.messages[0]).toMatchObject({
      type: "message",
      role: "user",
      content: [
        {
          type: "text",
          text: expect.stringContaining("<system-reminder>"),
        },
      ],
    });
    expect(JSON.stringify(first.messages)).not.toContain("tool_call_id");
    expect(JSON.stringify(first.messages)).not.toContain('"approvals"');
    expect(first.messages[0]?.otid).toBeString();
    expect(first.messages[0]?.otid).not.toBe(second.messages[0]?.otid);
  });

  test("assigns identities to messages introduced by turn transforms", () => {
    const messages = ensureTurnInputMessageOtids([
      {
        role: "user",
        content: "mod-introduced channel message",
      },
    ]);

    expect(messages[0]?.otid).toBeString();
  });

  test("moves image failure policy to refreshed message OTIDs", () => {
    const state = refreshTurnInputOtidsForNewRequest(
      createTurnInputState(
        [
          {
            role: "user",
            content: "channel attachment",
            otid: "original-channel-otid",
          },
        ],
        { "original-channel-otid": "drop" },
      ),
    );

    const refreshedOtid = state.messages[0]?.otid;
    expect(refreshedOtid).toBeString();
    expect(refreshedOtid).not.toBe("original-channel-otid");
    expect(state.imageFailureModesByMessageOtid).toEqual({
      [refreshedOtid as string]: "drop",
    });
  });

  test("keeps channel image preparation best-effort after an OTID refresh", async () => {
    const state = refreshTurnInputOtidsForNewRequest(
      createTurnInputState(
        [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "not-an-image",
                },
              },
            ],
            otid: "original-channel-otid",
          },
        ],
        { "original-channel-otid": "drop" },
      ),
    );

    const normalized = await normalizeMessageImageParts(state.messages, {
      failureModesByMessageOtid: state.imageFailureModesByMessageOtid,
      resize: async () => {
        throw new Error("unsupported image");
      },
    });

    expect(normalized[0]).toMatchObject({ content: [] });
  });

  test("preserves message policy while replacing stale approvals", () => {
    const state = rebuildTurnInputWithFreshDenials(
      createTurnInputState(
        [
          {
            type: "approval",
            approvals: [],
            otid: "stale-approval-otid",
          },
          {
            role: "user",
            content: "queued channel attachment",
            otid: "original-channel-otid",
          },
        ],
        { "original-channel-otid": "drop" },
      ),
      [
        {
          toolCallId: "tool-call-1",
          toolName: "Bash",
          toolArgs: '{"command":"pwd"}',
        },
      ],
      "stale approval",
    );

    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]).toMatchObject({ type: "approval" });
    const refreshedOtid = state.messages[1]?.otid;
    expect(refreshedOtid).toBeString();
    expect(refreshedOtid).not.toBe("original-channel-otid");
    expect(state.imageFailureModesByMessageOtid).toEqual({
      [refreshedOtid as string]: "drop",
    });
  });
});
