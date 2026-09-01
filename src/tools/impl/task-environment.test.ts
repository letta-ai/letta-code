import { describe, expect, test } from "bun:test";
import type { Backend } from "@/backend";
import {
  resolveRemoteTaskTarget,
  validateTaskEnvironmentRequest,
} from "./task-environment";

describe("validateTaskEnvironmentRequest", () => {
  test("rejects the local backend", () => {
    const error = validateTaskEnvironmentRequest({
      fork: true,
      isDeployingExisting: false,
      localBackend: true,
    });
    expect(error).toContain("API backend");
  });

  test("rejects fresh subagent types", () => {
    const error = validateTaskEnvironmentRequest({
      fork: false,
      isDeployingExisting: false,
      localBackend: false,
    });
    expect(error).toContain("fork");
    expect(error).toContain("agent_id");
  });

  test("rejects default conversation without agent_id", () => {
    const error = validateTaskEnvironmentRequest({
      fork: false,
      isDeployingExisting: true,
      localBackend: false,
      conversationId: "default",
    });
    expect(error).toContain("agent_id");
  });

  test("accepts fork requests on the API backend", () => {
    expect(
      validateTaskEnvironmentRequest({
        fork: true,
        isDeployingExisting: false,
        localBackend: false,
      }),
    ).toBeNull();
  });

  test("accepts deploy-existing requests", () => {
    expect(
      validateTaskEnvironmentRequest({
        fork: false,
        isDeployingExisting: true,
        localBackend: false,
        agentId: "agent-1",
      }),
    ).toBeNull();
  });
});

describe("resolveRemoteTaskTarget", () => {
  function backendFixture(events: string[]) {
    return {
      retrieveConversation: async (conversationId: string) => {
        events.push(`retrieve:${conversationId}`);
        return { id: conversationId, agent_id: "agent-owner" };
      },
      createConversation: async (body: { agent_id: string }) => {
        events.push(`create:${body.agent_id}`);
        return { id: "conv-new" };
      },
    } as unknown as Backend;
  }

  test("uses both ids when provided", async () => {
    const events: string[] = [];
    const target = await resolveRemoteTaskTarget({
      backend: backendFixture(events),
      agentId: "agent-1",
      conversationId: "conv-1",
    });
    expect(target).toEqual({ agentId: "agent-1", conversationId: "conv-1" });
    expect(events).toEqual([]);
  });

  test("derives the owning agent from a conversation id", async () => {
    const events: string[] = [];
    const target = await resolveRemoteTaskTarget({
      backend: backendFixture(events),
      conversationId: "conv-1",
    });
    expect(target).toEqual({
      agentId: "agent-owner",
      conversationId: "conv-1",
    });
    expect(events).toEqual(["retrieve:conv-1"]);
  });

  test("creates a fresh conversation when only agent_id is given", async () => {
    const events: string[] = [];
    const target = await resolveRemoteTaskTarget({
      backend: backendFixture(events),
      agentId: "agent-1",
    });
    expect(target).toEqual({ agentId: "agent-1", conversationId: "conv-new" });
    expect(events).toEqual(["create:agent-1"]);
  });

  test("keeps the default conversation for agent-scoped deploys", async () => {
    const events: string[] = [];
    const target = await resolveRemoteTaskTarget({
      backend: backendFixture(events),
      agentId: "agent-1",
      conversationId: "default",
    });
    expect(target).toEqual({ agentId: "agent-1", conversationId: "default" });
    expect(events).toEqual([]);
  });

  test("throws when neither id is provided", async () => {
    await expect(
      resolveRemoteTaskTarget({ backend: backendFixture([]) }),
    ).rejects.toThrow(/agent_id or conversation_id/);
  });
});
