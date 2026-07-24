import { describe, expect, test } from "bun:test";
import { getEmptyStateActionDescriptors } from "@/cli/components/ModelSelector";

describe("ModelSelector empty-state actions", () => {
  test("always includes /connect", () => {
    expect(getEmptyStateActionDescriptors(false)).toEqual([
      {
        id: "connect",
        label: "/connect",
        description: "Connect your LLM API keys (OpenAI, Anthropic, etc.)",
      },
    ]);
  });

  test("includes /login only when logged out", () => {
    expect(getEmptyStateActionDescriptors(true)).toEqual([
      {
        id: "connect",
        label: "/connect",
        description: "Connect your LLM API keys (OpenAI, Anthropic, etc.)",
      },
      {
        id: "login",
        label: "/login",
        description: "Sign in with Letta",
      },
    ]);
  });
});
