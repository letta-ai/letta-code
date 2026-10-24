import { afterEach, describe, expect, test } from "bun:test";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { __testSetBackend, getBackend } from "@/backend";
import { getResumeDataFromBackend } from "./check-approval";

const original = getBackend();
const agent = { id: "agent", message_ids: [] } as unknown as AgentState;
afterEach(() => __testSetBackend(original));

describe("strict default-conversation approval reads", () => {
  test("does not start a metadata fallback after a cancelled history read", async () => {
    const controller = new AbortController();
    const reason = new Error("history cancelled");
    let metadataReads = 0;
    const previous = process.env.LETTA_BACKFILL;
    process.env.LETTA_BACKFILL = "1";
    __testSetBackend(
      Object.create(
        original,
        Object.getOwnPropertyDescriptors({
          async getConversationResumeTail() {
            controller.abort(reason);
            throw reason;
          },
          async retrieveConversation() {
            metadataReads++;
            return { in_context_message_ids: [] };
          },
        }),
      ),
    );
    try {
      await expect(
        getResumeDataFromBackend(agent, "conv", {
          signal: controller.signal,
          throwOnReadError: true,
        }),
      ).rejects.toBe(reason);
      expect(metadataReads).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.LETTA_BACKFILL;
      else process.env.LETTA_BACKFILL = previous;
    }
  });
  test("surfaces a history failure when in-context message IDs are absent", async () => {
    const error = new Error("history unavailable");
    __testSetBackend(
      Object.create(
        original,
        Object.getOwnPropertyDescriptors({
          async getConversationResumeTail() {
            throw error;
          },
        }),
      ),
    );
    await expect(
      getResumeDataFromBackend(agent, "default", {
        includeMessageHistory: false,
        throwOnReadError: true,
      }),
    ).rejects.toBe(error);
  });
  test("keeps the non-strict interactive resume fallback", async () => {
    __testSetBackend(
      Object.create(
        original,
        Object.getOwnPropertyDescriptors({
          async getConversationResumeTail() {
            throw new Error("unavailable");
          },
        }),
      ),
    );
    expect(
      await getResumeDataFromBackend(agent, "default", {
        includeMessageHistory: false,
      }),
    ).toMatchObject({ pendingApprovals: [], messageHistory: [] });
  });
});
