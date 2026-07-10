import { describe, expect, test } from "bun:test";
import { resolveStartupCreateFailure } from "@/cli/helpers/startup-create-failure";

describe("resolveStartupCreateFailure", () => {
  test("agent quota failure falls back to existing agent selection without create", () => {
    const fallback = resolveStartupCreateFailure(
      new Error(
        'Failed to create default agents: 402 {"error":"You have reached your limit for agents","limit":3}',
      ),
    );

    expect(fallback).toEqual({
      disableCreateAgent: true,
      failedAgentMessage:
        "Could not create a default agent because your Constellation agent limit is reached. Select an existing agent below, delete an agent, or upgrade at https://chat.letta.com/preferences/usage.",
      headlessMessage:
        "Could not create a default agent because your Constellation agent limit is reached. Run with --agent <id> to use an existing agent, delete an agent, or upgrade at https://chat.letta.com/preferences/usage.",
    });
  });

  test("agent-limit reason falls back to existing agent selection without create", () => {
    const fallback = resolveStartupCreateFailure(
      new Error("Failed to create default agents", {
        cause: new Error("429 agents-limit-exceeded"),
      }),
    );

    expect(fallback.disableCreateAgent).toBe(true);
  });

  test("non-agent 402 failures keep generic fallback copy", () => {
    const fallback = resolveStartupCreateFailure(
      new Error(
        'Failed to create default agents: 402 {"error":"You have reached your model usage limit","limit":3}',
      ),
    );

    expect(fallback).toEqual({
      disableCreateAgent: false,
      failedAgentMessage:
        'Could not create a default agent. Select an existing agent below, or try Create a new agent again. (Failed to create default agents: 402 {"error":"You have reached your model usage limit","limit":3})',
      headlessMessage:
        'Could not create a default agent. Run with --agent <id> to use an existing agent, or fix the error and try again. (Failed to create default agents: 402 {"error":"You have reached your model usage limit","limit":3})',
    });
  });

  test("non-Error create failures still fall back to existing agent selection", () => {
    const fallback = resolveStartupCreateFailure("network unavailable");

    expect(fallback).toEqual({
      disableCreateAgent: false,
      failedAgentMessage:
        "Could not create a default agent. Select an existing agent below, or try Create a new agent again. (network unavailable)",
      headlessMessage:
        "Could not create a default agent. Run with --agent <id> to use an existing agent, or fix the error and try again. (network unavailable)",
    });
  });
});
