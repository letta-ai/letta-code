import { describe, expect, test } from "bun:test";
import { sanitizeConversationCreateBody } from "./conversation-body";

const cloudCapabilities = { localMemfs: false };
const localCapabilities = { localMemfs: true };

describe("sanitizeConversationCreateBody", () => {
  test("strips model_settings on cloud backend", () => {
    const body = {
      agent_id: "agent-1",
      model: "lc-zai-coding/glm-5.1",
      model_settings: { parallel_tool_calls: true, provider_type: "zai_coding" },
    };
    const result = sanitizeConversationCreateBody(body, cloudCapabilities);
    expect(result).not.toHaveProperty("model_settings");
    expect(result).toMatchObject({ agent_id: "agent-1", model: "lc-zai-coding/glm-5.1" });
  });

  test("strips empty model_settings object on cloud backend", () => {
    const body = { agent_id: "agent-1", model_settings: {} };
    const result = sanitizeConversationCreateBody(body, cloudCapabilities);
    expect(result).not.toHaveProperty("model_settings");
  });

  test("strips null model_settings on cloud backend", () => {
    const body = { agent_id: "agent-1", model_settings: null };
    const result = sanitizeConversationCreateBody(body, cloudCapabilities);
    expect(result).not.toHaveProperty("model_settings");
  });

  test("passes body through unchanged when model_settings is absent (cloud)", () => {
    const body = { agent_id: "agent-1", model: "anthropic/claude-opus-4-5" };
    const result = sanitizeConversationCreateBody(body, cloudCapabilities);
    expect(result).toBe(body);
  });

  test("preserves model_settings on local backend", () => {
    const body = {
      agent_id: "agent-local-1",
      model: "openai/gpt-5-mini",
      model_settings: { provider_type: "openai", parallel_tool_calls: false },
    };
    const result = sanitizeConversationCreateBody(body, localCapabilities);
    expect(result).toBe(body);
    expect(result).toHaveProperty("model_settings");
  });

  test("does not mutate the original body", () => {
    const body = {
      agent_id: "agent-1",
      model_settings: { provider_type: "zai_coding" },
    };
    const original = { ...body };
    sanitizeConversationCreateBody(body, cloudCapabilities);
    expect(body).toEqual(original);
  });
});
