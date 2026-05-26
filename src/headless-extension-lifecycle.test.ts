import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import {
  createHeadlessExtensionContext,
  HEADLESS_EXTENSION_CAPABILITIES,
} from "@/headless-extension-runtime";

function readHeadlessSource(): string {
  return readFileSync(
    fileURLToPath(new URL("./headless.ts", import.meta.url)),
    "utf-8",
  );
}

describe("headless extension lifecycle", () => {
  test("uses lifecycle-only extension capabilities", () => {
    expect(HEADLESS_EXTENSION_CAPABILITIES).toEqual({
      tools: false,
      commands: false,
      events: {
        lifecycle: true,
      },
      ui: {
        panels: false,
        statusValues: false,
        customStatuslineRenderer: false,
      },
    });
  });

  test("builds extension context for headless lifecycle events", () => {
    const context = createHeadlessExtensionContext({
      agent: {
        id: "agent-1",
        name: "Amelia",
        llm_config: {
          context_window: 200000,
          model: "opus",
          reasoning_effort: "high",
        },
      } as AgentState,
      conversationId: "conversation-1",
      lastRunId: "run-1",
      permissionMode: "unrestricted",
      reflectionSettings: { trigger: "step-count", stepCount: 3 },
    });

    expect(context.agent).toEqual({ id: "agent-1", name: "Amelia" });
    expect(context.sessionId).toBe("conversation-1");
    expect(context.lastRunId).toBe("run-1");
    expect(context.permissionMode).toBe("unrestricted");
    expect(context.reflection).toEqual({ mode: "step-count", stepCount: 3 });
    expect(context.contextWindow.size).toBe(200000);
  });

  test("loads the runtime before headless modes and emits lifecycle events on exit", () => {
    const source = readHeadlessSource();

    const runtimeIndex = source.indexOf(
      "const headlessExtensionRuntime = createHeadlessExtensionRuntime",
    );
    const bidirectionalIndex = source.indexOf(
      "// If input-format is stream-json, use bidirectional mode",
    );
    expect(runtimeIndex).toBeGreaterThan(-1);
    expect(bidirectionalIndex).toBeGreaterThan(runtimeIndex);

    expect(source).toContain("await headlessExtensionRuntime.reload()");
    expect(source).toContain("await emitHeadlessConversationOpen({");
    expect(source).toContain("await emitHeadlessConversationClose({");
    expect(source).toContain("headlessExtensionRuntime.dispose()");
  });
});
