import { describe, expect, test } from "bun:test";
import { ACTING_USER_ID_HEADER } from "@/agent/acting-user";
import type { Backend } from "@/backend";
import { createStartupBackend } from "./headless-startup-backend";

type StartupBackend = Pick<
  Backend,
  "retrieveAgent" | "retrieveConversation" | "createConversation"
>;

function recordingBackend(
  calls: Array<{ operation: string; options: unknown }>,
): StartupBackend {
  return {
    retrieveAgent: async (_agentId, options) => {
      calls.push({ operation: "retrieveAgent", options });
      return {} as never;
    },
    retrieveConversation: async (_conversationId, options) => {
      calls.push({ operation: "retrieveConversation", options });
      return {} as never;
    },
    createConversation: async (_body, options) => {
      calls.push({ operation: "createConversation", options });
      return {} as never;
    },
  };
}

async function exerciseStartupBackend(
  usesRemoteComputer: boolean,
  actingUserId?: string,
) {
  const calls: Array<{ operation: string; options: unknown }> = [];
  const backend = createStartupBackend(
    recordingBackend(calls),
    usesRemoteComputer,
    actingUserId,
  );

  await backend.retrieveAgent("agent-target", { include: ["agent.tools"] });
  await backend.retrieveConversation("conv-target");
  await backend.createConversation({ agent_id: "agent-target" });
  return calls;
}

describe("headless startup backend", () => {
  test("attributes every remote startup resource request to the sender", async () => {
    const calls = await exerciseStartupBackend(true, "user-sender");

    expect(calls.map(({ operation }) => operation)).toEqual([
      "retrieveAgent",
      "retrieveConversation",
      "createConversation",
    ]);
    for (const { options } of calls) {
      expect(options).toMatchObject({
        headers: { [ACTING_USER_ID_HEADER]: "user-sender" },
      });
    }
    expect(calls[0]?.options).toMatchObject({ include: ["agent.tools"] });
  });

  test("keeps direct CLI startup authenticated only as its API key", async () => {
    const calls = await exerciseStartupBackend(false, "user-sender");

    expect(calls.map(({ options }) => options)).toEqual([
      { include: ["agent.tools"] },
      undefined,
      undefined,
    ]);
  });

  test("does not add an empty acting-user header", async () => {
    const calls = await exerciseStartupBackend(true, "");

    expect(calls.map(({ options }) => options)).toEqual([
      { include: ["agent.tools"] },
      undefined,
      undefined,
    ]);
  });
});
