import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AssistantMessage,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createOrUpdateLocalProvider } from "@/backend/local/local-provider-auth-store";
import {
  estimateLocalMessageTokens,
  LocalSlidingWindowCompactionPlanningError,
  planLocalSlidingWindowCompaction,
  summarizeLocalMessagesAll,
} from "./compaction";
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

function planningUserMessage(text: string): LocalMessage {
  return {
    id: `u-${Math.random().toString(36).slice(2)}`,
    role: "user",
    content: text,
    timestamp: Date.now(),
  };
}

function planningAssistantMessage(text: string): LocalMessage {
  return {
    id: `a-${Math.random().toString(36).slice(2)}`,
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-fable-5",
    usage: emptyLocalUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

/**
 * u a(small) u a(small) u a(small) u a(BIG) u a(small) u a(small)
 * Assistant cutoffs exist at indices 1/3/5/7/9; the bulk of the tokens
 * sits in the assistant at index 7, so meaningful headroom requires
 * evicting past it.
 */
function toolHeavyConversation(): {
  messages: LocalMessage[];
  bigRecord: LocalMessage;
} {
  const small = "x".repeat(1000);
  const user = "y".repeat(100);
  const big = "z".repeat(30000);
  const bigRecord = planningAssistantMessage(big);
  const messages: LocalMessage[] = [
    planningUserMessage(user),
    planningAssistantMessage(small),
    planningUserMessage(user),
    planningAssistantMessage(small),
    planningUserMessage(user),
    planningAssistantMessage(small),
    planningUserMessage(user),
    bigRecord,
    planningUserMessage(user),
    planningAssistantMessage(small),
    planningUserMessage(user),
    planningAssistantMessage(small),
  ];
  return { messages, bigRecord };
}

describe("planLocalSlidingWindowCompaction token awareness", () => {
  test("evicts token-aware when no context window is configured", () => {
    const { messages } = toolHeavyConversation();
    const total = estimateLocalMessageTokens(messages);

    const plan = planLocalSlidingWindowCompaction(messages, {});

    const kept = estimateLocalMessageTokens(plan.messagesToKeep);
    const goal = 0.7 * total;
    expect(kept).toBeLessThanOrEqual(goal + 8);
    // The first eviction step alone would have kept the big record.
    expect(plan.cutoffIndex).toBeGreaterThan(5);
  });

  test("keeps first-step behavior once the retention budget is met", () => {
    const { messages } = toolHeavyConversation();
    const total = estimateLocalMessageTokens(messages);
    const roomyWindow = Math.ceil(total / 0.3) + 1_000_000;

    const plan = planLocalSlidingWindowCompaction(messages, {
      contextWindow: roomyWindow,
    });

    expect(plan.cutoffIndex).toBe(5);
  });

  test("iterates until the configured budget is met", () => {
    const { messages, bigRecord } = toolHeavyConversation();
    // Retention budget is (1 - percentage) * contextWindow = 0.7 * 8000 =
    // 5600 tokens: too small to keep the big record at index 7 (the tail
    // from cutoff 5 estimates ~8325 tokens), so the planner must keep
    // stepping until it lands past it.
    const plan = planLocalSlidingWindowCompaction(messages, {
      contextWindow: 8000,
    });

    const kept = estimateLocalMessageTokens(plan.messagesToKeep);
    expect(kept).toBeLessThanOrEqual((1 - 0.3) * 8000 + 8);
    expect(plan.messagesToSummarize).toContainEqual(bigRecord);
  });

  test("falls back to full summarization when the tail alone exceeds the budget", () => {
    const small = "x".repeat(1000);
    const user = "y".repeat(100);
    const huge = "z".repeat(30000);
    const messages: LocalMessage[] = [
      planningUserMessage(user),
      planningAssistantMessage(small),
      planningUserMessage(user),
      planningAssistantMessage(small),
      planningUserMessage(user),
      planningAssistantMessage(small),
      planningUserMessage(user),
      planningAssistantMessage(small),
      planningUserMessage(user),
      planningAssistantMessage(huge),
      planningUserMessage(user),
      planningAssistantMessage(huge),
    ];

    expect(() =>
      planLocalSlidingWindowCompaction(messages, { contextWindow: 500 }),
    ).toThrow(LocalSlidingWindowCompactionPlanningError);
  });
});
