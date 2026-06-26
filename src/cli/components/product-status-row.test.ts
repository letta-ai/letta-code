import { describe, expect, test } from "bun:test";
import {
  chatUrlForBackgroundAgent,
  shouldRenderPlainBackgroundAgentUrl,
} from "./ProductStatusRow";

describe("ProductStatusRow helpers", () => {
  test("uses the exact background agent chat URL", () => {
    expect(
      chatUrlForBackgroundAgent({
        agentURL: "https://app.letta.com/chat/agent-1?conversation=conv-1",
      }),
    ).toBe("https://app.letta.com/chat/agent-1?conversation=conv-1");
  });

  test("does not treat local agent IDs as app URLs", () => {
    expect(chatUrlForBackgroundAgent({ agentURL: "agent-local-abc" })).toBe(
      null,
    );
  });

  test("renders a visible URL fallback in tmux", () => {
    expect(shouldRenderPlainBackgroundAgentUrl({ TMUX: "/tmp/tmux-501" })).toBe(
      true,
    );
    expect(shouldRenderPlainBackgroundAgentUrl({})).toBe(false);
  });
});
