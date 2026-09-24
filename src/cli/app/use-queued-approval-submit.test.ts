import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import { appendOptimisticUserLine } from "@/cli/app/ids";
import type {
  ProcessConversation,
  ProcessConversationOptions,
} from "@/cli/app/types";
import { processNewTurnWithQueuedApprovals } from "@/cli/app/use-queued-approval-submit";
import { createBuffers, onChunk } from "@/cli/helpers/accumulator";

function addCommittedUserLine(buffers: ReturnType<typeof createBuffers>): void {
  buffers.byId.set("user-1", {
    kind: "user",
    id: "user-1",
    text: "hello",
    otid: "otid-u1",
  });
  buffers.userLineIdByOtid.set("otid-u1", "user-1");
  buffers.order.push("user-1");
}

const userMessage = {
  type: "message",
  role: "user",
  content: "run skill",
} as MessageCreate;

describe("processNewTurnWithQueuedApprovals", () => {
  test("evicts committed lines before starting a command-driven turn", async () => {
    const buffers = createBuffers();
    addCommittedUserLine(buffers);
    buffers.tokenCount = 99;
    buffers.interrupted = true;
    let seenOrder: string[] | undefined;
    let seenInput: unknown;
    let seenOptions: ProcessConversationOptions | undefined;

    await processNewTurnWithQueuedApprovals({
      buffers,
      committedIds: new Set(["user-1"]),
      consumeQueuedApprovalInput: () => null,
      input: [userMessage],
      isTurnInFlight: () => false,
      processConversation: (async (input, options) => {
        seenOrder = [...buffers.order];
        seenInput = input;
        seenOptions = options;
      }) satisfies ProcessConversation,
    });

    expect(seenOrder).toEqual([]);
    expect(buffers.byId.has("user-1")).toBe(false);
    expect(buffers.tokenCount).toBe(0);
    expect(buffers.interrupted).toBe(false);
    expect(seenInput).toEqual([userMessage]);
    expect(seenOptions?.transcriptStartLineIndex).toBeNull();
  });

  test("prepends queued approvals without evicting and keeps an explicit transcript index", async () => {
    const buffers = createBuffers();
    addCommittedUserLine(buffers);
    const queuedApproval = {
      type: "approval",
      approvals: [],
      otid: "otid-approval",
    } as ApprovalCreate;
    let seenInput: unknown;
    let seenOptions: ProcessConversationOptions | undefined;

    await processNewTurnWithQueuedApprovals({
      buffers,
      committedIds: new Set(["user-1"]),
      consumeQueuedApprovalInput: () => queuedApproval,
      input: [userMessage],
      isTurnInFlight: () => false,
      options: { transcriptStartLineIndex: 0 },
      processConversation: (async (input, options) => {
        expect(buffers.byId.has("user-1")).toBe(true);
        seenInput = input;
        seenOptions = options;
      }) satisfies ProcessConversation,
    });

    expect(seenInput).toEqual([queuedApproval, userMessage]);
    expect(seenOptions?.transcriptStartLineIndex).toBe(0);
  });

  test("queued approvals keep the interrupted turn's lines and saved transcript index", async () => {
    const buffers = createBuffers();
    addCommittedUserLine(buffers);
    buffers.tokenCount = 42;
    const queuedApproval = {
      type: "approval",
      approvals: [],
      otid: "otid-approval",
    } as ApprovalCreate;
    let seenInput: unknown;
    let seenOptions: ProcessConversationOptions | undefined;

    // Command paths pass no options.
    await processNewTurnWithQueuedApprovals({
      buffers,
      committedIds: new Set(["user-1"]),
      consumeQueuedApprovalInput: () => queuedApproval,
      input: [userMessage],
      isTurnInFlight: () => false,
      processConversation: (async (input, options) => {
        seenInput = input;
        seenOptions = options;
      }) satisfies ProcessConversation,
    });

    expect(seenInput).toEqual([queuedApproval, userMessage]);
    // No explicit index: with approval input, processConversation keeps the
    // saved pendingTranscriptStartLineIndexRef of the interrupted turn.
    expect(seenOptions?.transcriptStartLineIndex).toBeUndefined();
    expect(buffers.order).toEqual(["user-1"]);
    expect(buffers.byId.has("user-1")).toBe(true);
    expect(buffers.tokenCount).toBe(42);
  });

  test("never evicts while a turn is in flight", async () => {
    // A turn is streaming: its user line and first text block are committed.
    const buffers = createBuffers();
    const userLineId =
      appendOptimisticUserLine(buffers, "fix the login bug", "otid-u") ?? "";
    onChunk(buffers, {
      message_type: "assistant_message",
      id: "msg-1",
      otid: "otid-a",
      content: "First block.",
    } as never);
    onChunk(buffers, {
      message_type: "reasoning_message",
      id: "msg-r",
      otid: "otid-r",
      reasoning: "thinking",
    } as never);
    const committedIds = new Set([userLineId, "msg-1"]);
    const orderBefore = [...buffers.order];
    const tokenCountBefore = buffers.tokenCount;

    // A busy-safe command (e.g. /mods generate-env) reaches the helper mid-turn.
    await processNewTurnWithQueuedApprovals({
      buffers,
      committedIds,
      consumeQueuedApprovalInput: () => null,
      input: [userMessage],
      isTurnInFlight: () => true,
      processConversation: (async () => {}) satisfies ProcessConversation,
    });

    expect(buffers.order).toEqual(orderBefore);
    expect(buffers.byId.get(userLineId)?.kind).toBe("user");
    expect(buffers.tokenCount).toBe(tokenCountBefore);

    // The next text block of the same message still opens a visible line.
    onChunk(buffers, {
      message_type: "assistant_message",
      id: "msg-1",
      otid: "otid-c",
      content: "Second block.",
    } as never);
    const secondBlock = buffers.order
      .map((id) => buffers.byId.get(id))
      .find(
        (line) => line?.kind === "assistant" && line.text === "Second block.",
      );
    expect(secondBlock).toBeDefined();
    expect(committedIds.has(secondBlock?.id ?? "")).toBe(false);
  });

  test("keeps uncommitted live lines so mid-turn stragglers survive the next new turn", async () => {
    const buffers = createBuffers();
    addCommittedUserLine(buffers);
    buffers.byId.set("live-1", {
      kind: "assistant",
      id: "live-1",
      text: "still streaming",
      phase: "streaming",
    });
    buffers.order.push("live-1");
    let seenOrder: string[] | undefined;

    await processNewTurnWithQueuedApprovals({
      buffers,
      committedIds: new Set(["user-1"]),
      consumeQueuedApprovalInput: () => null,
      input: [userMessage],
      isTurnInFlight: () => false,
      processConversation: (async () => {
        seenOrder = [...buffers.order];
      }) satisfies ProcessConversation,
    });

    expect(seenOrder).toEqual(["live-1"]);
    expect(buffers.byId.has("live-1")).toBe(true);
  });
});

describe("new-turn eviction hookup", () => {
  test("command/skill/mod paths start turns through processConversationWithQueuedApprovals, which evicts", () => {
    const submitSource = readFileSync(
      fileURLToPath(new URL("./use-submit-handler.ts", import.meta.url)),
      "utf-8",
    );
    const queuedSource = readFileSync(
      fileURLToPath(
        new URL("./use-queued-approval-submit.ts", import.meta.url),
      ),
      "utf-8",
    );

    expect(queuedSource).toContain("prepareBuffersForTurn(args.buffers");
    expect(queuedSource).toContain("processNewTurnWithQueuedApprovals({");
    expect(queuedSource.indexOf("prepareBuffersForTurn(")).toBeLessThan(
      queuedSource.indexOf("await args.processConversation("),
    );

    const typedEnterEvict = submitSource.indexOf(
      "prepareBuffersForTurn(buffersRef.current, emittedIdsRef.current)",
    );
    expect(typedEnterEvict).toBeGreaterThan(0);

    const commandMarkers = [
      "matchedCustomCommand",
      'result.type === "prompt"',
      "parseModsGenerateEnvCommand",
      'trimmed === "/statusline"',
      'trimmed === "/skill-creator"',
      'trimmed === "/init"',
      'trimmed === "/doctor"',
      'trimmed.startsWith("/empanada")',
      "matchedSkill",
    ];
    let searchFrom = 0;
    for (const marker of commandMarkers) {
      const markerIndex = submitSource.indexOf(marker, searchFrom);
      expect(markerIndex).toBeGreaterThanOrEqual(0);
      const callIndex = submitSource.indexOf(
        "processConversationWithQueuedApprovals(",
        markerIndex,
      );
      expect(callIndex).toBeGreaterThan(markerIndex);
      expect(callIndex).toBeLessThan(typedEnterEvict);
      searchFrom = markerIndex + marker.length;
    }

    const typedEnterProcess = submitSource.indexOf(
      "await processConversation(initialInput, {",
      typedEnterEvict,
    );
    expect(typedEnterProcess).toBeGreaterThan(typedEnterEvict);
  });

  test("mid-turn reentry does not evict: processConversation is called without prepareBuffersForTurn", () => {
    const loopSource = readFileSync(
      fileURLToPath(new URL("./use-conversation-loop.ts", import.meta.url)),
      "utf-8",
    );
    const approvalSource = readFileSync(
      fileURLToPath(new URL("./use-approval-flow.ts", import.meta.url)),
      "utf-8",
    );

    expect(loopSource).not.toContain("prepareBuffersForTurn");
    expect(approvalSource).not.toContain("prepareBuffersForTurn");
    expect(loopSource).toContain("{ allowReentry: true }");
    expect(approvalSource).toContain("{ allowReentry: true }");
  });
});
