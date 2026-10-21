import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AssistantMessage,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createOrUpdateLocalProvider } from "@/backend/local/local-provider-auth-store";
import { summarizeLocalMessagesAll } from "./compaction";
import { emptyLocalUsage, type LocalMessage } from "./local-message";

function summaryAssistantMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "summary of prior work" }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-fable-5",
    usage: emptyLocalUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

describe("local compaction summarizer options", () => {
  test("sends the OpenCode Go conversation identity during compaction", async () => {
    const previousKey = process.env.OPENCODE_API_KEY;
    process.env.OPENCODE_API_KEY = "test-opencode-key";
    try {
      let capturedOptions:
        | (SimpleStreamOptions & Record<string, unknown>)
        | undefined;
      await summarizeLocalMessagesAll({
        conversationId: "conv-opencode-compaction",
        agent: {
          id: "agent-local-1",
          name: "Local",
          description: null,
          system: "",
          tags: [],
          model: "opencode-go/glm-5.2",
          model_settings: {},
        },
        messages: [
          {
            id: "ui-msg-1",
            role: "user",
            content: "please summarize this conversation",
            timestamp: Date.now(),
          },
        ],
        complete: async (_model, _context, options) => {
          capturedOptions = options;
          return summaryAssistantMessage();
        },
      });

      expect(capturedOptions?.sessionId).toBe("conv-opencode-compaction");
      expect(capturedOptions?.headers).toEqual({
        "x-opencode-session": "conv-opencode-compaction",
      });
    } finally {
      if (previousKey === undefined) delete process.env.OPENCODE_API_KEY;
      else process.env.OPENCODE_API_KEY = previousKey;
    }
  });

  test("uses Opus for Fable compaction summaries while preserving reasoning", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-compaction-"));
    try {
      await createOrUpdateLocalProvider({
        storageDir,
        providerType: "anthropic",
        providerName: "lc-anthropic",
        apiKey: "secret-key",
      });

      const messages: LocalMessage[] = [
        {
          id: "ui-msg-1",
          role: "user",
          content: "please summarize this conversation",
          timestamp: Date.now(),
        },
      ];

      let capturedOptions:
        | (SimpleStreamOptions & Record<string, unknown>)
        | undefined;
      let capturedModelId: string | undefined;
      const summary = await summarizeLocalMessagesAll({
        conversationId: "conv-fable-compaction",
        agent: {
          id: "agent-local-1",
          name: "Local",
          description: null,
          system: "",
          tags: [],
          model: "anthropic/claude-fable-5",
          model_settings: {
            provider_type: "anthropic",
            effort: "max",
            thinking: { type: "enabled" },
          },
        },
        messages,
        localProviderAuthStorageDir: storageDir,
        complete: async (model, _context, options) => {
          capturedModelId = model.id;
          capturedOptions = options;
          return summaryAssistantMessage();
        },
      });

      expect(summary).toBe("summary of prior work");
      // Fable 5 can refuse compaction-summarizer prompts and pi-ai currently
      // masks that refusal as "An unknown error occurred". Use Opus for the
      // auxiliary summary call while preserving the session reasoning level.
      expect(capturedModelId).toBe("claude-opus-4-8");
      // Pi parity (createSummarizationOptions): summarization requests carry
      // the session thinking level. Without options.reasoning, pi-ai sends
      // `thinking: {type: "disabled"}`, which adaptive-thinking Anthropic
      // models (claude-fable-5) reject with a 400 invalid_request_error.
      expect(capturedOptions?.reasoning).toBe("xhigh");
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("omits reasoning when model settings disable thinking", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-compaction-"));
    try {
      await createOrUpdateLocalProvider({
        storageDir,
        providerType: "anthropic",
        providerName: "lc-anthropic",
        apiKey: "secret-key",
      });

      let capturedOptions:
        | (SimpleStreamOptions & Record<string, unknown>)
        | undefined;
      let capturedModelId: string | undefined;
      await summarizeLocalMessagesAll({
        conversationId: "conv-anthropic-compaction",
        agent: {
          id: "agent-local-1",
          name: "Local",
          description: null,
          system: "",
          tags: [],
          model: "anthropic/claude-sonnet-4-6",
          model_settings: {
            provider_type: "anthropic",
            thinking: { type: "disabled" },
          },
        },
        messages: [
          {
            id: "ui-msg-1",
            role: "user",
            content: "please summarize this conversation",
            timestamp: Date.now(),
          },
        ],
        localProviderAuthStorageDir: storageDir,
        complete: async (model, _context, options) => {
          capturedModelId = model.id;
          capturedOptions = options;
          return summaryAssistantMessage();
        },
      });

      expect(capturedModelId).toBe("claude-sonnet-4-6");
      expect(capturedOptions?.reasoning).toBeUndefined();
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
