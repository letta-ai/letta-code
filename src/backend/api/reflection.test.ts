import { describe, expect, test } from "bun:test";
import {
  retrieveCloudReflectionConfig,
  updateCloudReflectionConfig,
  updateCloudReflectionConversationProgress,
} from "./reflection";

describe("Cloud reflection API", () => {
  test("retrieves the agent config", async () => {
    const calls: Array<{ method: string; path: string }> = [];
    const config = {
      agent_id: "agent/1",
      enabled: true,
      min_turn_count: 25,
      cutover: true,
      created_at: "2026-08-13T00:00:00.000Z",
      updated_at: "2026-08-13T00:00:00.000Z",
    };
    const request = async <T>(method: string, path: string): Promise<T> => {
      calls.push({ method, path });
      return config as unknown as T;
    };

    await expect(
      retrieveCloudReflectionConfig("agent/1", request),
    ).resolves.toEqual(config);
    expect(calls).toEqual([
      { method: "GET", path: "/v1/agents/agent%2F1/reflection" },
    ]);
  });

  test("patches the agent config endpoint", async () => {
    const calls: Array<{
      method: string;
      path: string;
      body?: Record<string, unknown>;
    }> = [];
    const request = async <T>(
      method: string,
      path: string,
      body?: Record<string, unknown>,
    ): Promise<T> => {
      calls.push({ method, path, body });
      return {} as T;
    };

    await updateCloudReflectionConfig(
      "agent/1",
      { enabled: true, min_turn_count: 25 },
      request,
    );

    expect(calls).toEqual([
      {
        method: "PATCH",
        path: "/v1/agents/agent%2F1/reflection",
        body: { enabled: true, min_turn_count: 25 },
      },
    ]);
  });

  test("patches the conversation progress endpoint", async () => {
    const calls: Array<{
      method: string;
      path: string;
      body?: Record<string, unknown>;
    }> = [];
    const request = async <T>(
      method: string,
      path: string,
      body?: Record<string, unknown>,
    ): Promise<T> => {
      calls.push({ method, path, body });
      return {} as T;
    };

    await updateCloudReflectionConversationProgress(
      "agent/1",
      "conversation/1",
      { reflected_through_message_id: "message-1" },
      request,
    );

    expect(calls).toEqual([
      {
        method: "PATCH",
        path: "/v1/agents/agent%2F1/conversations/conversation%2F1/reflection",
        body: { reflected_through_message_id: "message-1" },
      },
    ]);
  });
});
