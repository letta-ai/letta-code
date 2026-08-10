import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Letta from "@letta-ai/letta-client";
import { createModEngine } from "@/mods/mod-engine";
import { preserveApprovalFirstOrdering } from "@/mods/turn-start-input";
import type { ModContext, ModConversationMessage } from "@/mods/types";

const approvalA = {
  type: "approval" as const,
  approvals: [{ approve: true, tool_call_id: "tool-a" }],
};
const approvalB = {
  type: "approval" as const,
  approvals: [{ approve: false, tool_call_id: "tool-b" }],
};
const userMessage = {
  type: "message" as const,
  role: "user" as const,
  content: "continue",
};
const reminder = {
  type: "message" as const,
  role: "user" as const,
  content: "<system-reminder>goal</system-reminder>",
};

describe("preserveApprovalFirstOrdering", () => {
  test("keeps approval continuations ahead of transformed messages", () => {
    const transformed = [reminder, approvalA, approvalB, userMessage];

    expect(preserveApprovalFirstOrdering(true, transformed)).toEqual([
      approvalA,
      approvalB,
      reminder,
      userMessage,
    ]);
  });

  test("does not reorder batches that were not approval continuations", () => {
    const transformed = [reminder, approvalA, userMessage];

    expect(preserveApprovalFirstOrdering(false, transformed)).toBe(transformed);
  });

  test("leaves already valid and approval-only batches unchanged", () => {
    const valid = [approvalA, reminder, userMessage];
    const approvalOnly = [approvalA, approvalB];

    expect(preserveApprovalFirstOrdering(true, valid)).toBe(valid);
    expect(preserveApprovalFirstOrdering(true, approvalOnly)).toBe(
      approvalOnly,
    );
  });
});

test("turn_start handlers cannot move reminders ahead of approvals", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "letta-turn-start-order-"));
  const modsDirectory = path.join(root, "mods");
  mkdirSync(modsDirectory, { recursive: true });
  writeFileSync(
    path.join(modsDirectory, "prepend-reminder.ts"),
    `export default function activate(letta) {
      letta.events.on("turn_start", (event) => ({
        input: [
          { type: "message", role: "user", content: "<system-reminder>goal</system-reminder>" },
          ...event.input,
        ],
      }));
    }`,
  );

  const engine = createModEngine({
    cacheDirectory: path.join(root, "cache"),
    getClient: async () => ({}) as unknown as Letta,
    globalModsDirectory: modsDirectory,
  });

  try {
    await engine.reload();
    const event = {
      agentId: "agent-1",
      conversationId: "conversation-1",
      input: [approvalA, approvalB, userMessage] as ModConversationMessage[],
    };
    const context = {
      agent: { id: "agent-1", name: "Amelia" },
      cwd: "/tmp/project",
      sessionId: "conversation-1",
    } as ModContext;

    await engine.emitEvent("turn_start", event, context);

    expect(event.input).toEqual([approvalA, approvalB, reminder, userMessage]);
  } finally {
    engine.dispose();
    rmSync(root, { force: true, recursive: true });
  }
});
