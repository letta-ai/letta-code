import { describe, expect, test } from "bun:test";
import {
  updateCloudReflectionConfig,
  updateCloudReflectionConversationProgress,
} from "./reflection";

describe("Cloud reflection API", () => {
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
