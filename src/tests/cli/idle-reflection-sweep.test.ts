import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __idleReflectionSweepTestUtils } from "../../cli/helpers/idleReflectionSweep";
import { normalizeReflectionSettings } from "../../cli/helpers/memoryReminder";
import {
  appendTranscriptDeltaJsonl,
  buildAutoReflectionPayload,
  finalizeAutoReflectionPayload,
  getReflectionTranscriptPaths,
} from "../../cli/helpers/reflectionTranscript";
import {
  clearAllSubagents,
  registerSubagent,
} from "../../cli/helpers/subagentState";

describe("idle reflection sweep candidate discovery", () => {
  const agentId = "agent-idle-test";
  let testRoot: string;

  beforeEach(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "letta-idle-sweep-test-"));
    process.env.LETTA_TRANSCRIPT_ROOT = testRoot;
  });

  afterEach(async () => {
    delete process.env.LETTA_TRANSCRIPT_ROOT;
    clearAllSubagents();
    await rm(testRoot, { recursive: true, force: true });
  });

  async function appendCompletedTurns(
    conversationId: string,
    count: number,
  ): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      await appendTranscriptDeltaJsonl(agentId, conversationId, [
        {
          kind: "user",
          id: `${conversationId}-u${index}`,
          text: `user ${index}`,
          messageId: `${conversationId}-msg-u${index}`,
        },
        {
          kind: "assistant",
          id: `${conversationId}-a${index}`,
          text: `assistant ${index}`,
          phase: "finished",
          messageId: `${conversationId}-msg-a${index}`,
        },
      ]);
    }
  }

  async function ageTranscript(conversationId: string, hoursAgo: number) {
    const paths = getReflectionTranscriptPaths(agentId, conversationId);
    const state = JSON.parse(await readFile(paths.statePath, "utf-8")) as {
      last_transcript_appended_at?: string;
    };
    state.last_transcript_appended_at = new Date(
      Date.now() - hoursAgo * 60 * 60 * 1000,
    ).toISOString();
    await writeFile(paths.statePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  test("filters local idle candidates by active conversation, age, turns, and cursor", async () => {
    await appendCompletedTurns("active", 3);
    await appendCompletedTurns("idle-good", 3);
    await appendCompletedTurns("too-short", 2);
    await appendCompletedTurns("too-new", 3);
    await appendCompletedTurns("already-reflected", 3);

    const reflectedPayload = await buildAutoReflectionPayload(
      agentId,
      "already-reflected",
    );
    expect(reflectedPayload).not.toBeNull();
    if (!reflectedPayload) return;
    await finalizeAutoReflectionPayload(
      agentId,
      "already-reflected",
      reflectedPayload.payloadPath,
      reflectedPayload.endSnapshotLine,
      true,
      "idle-time",
    );

    await ageTranscript("active", 25);
    await ageTranscript("idle-good", 25);
    await ageTranscript("too-short", 25);
    await ageTranscript("too-new", 1);
    await ageTranscript("already-reflected", 25);

    const candidates =
      await __idleReflectionSweepTestUtils.discoverIdleReflectionCandidates({
        agentId,
        activeConversationId: "active",
        workingDirectory: "/tmp/work",
        reflectionSettings: normalizeReflectionSettings({
          trigger: "step-count",
          stepCount: 25,
          idleSweepEnabled: true,
          idleSweepIntervalHours: 24,
          idleConversationMinAgeHours: 24,
          idleMinUnreflectedTurns: 3,
        }),
        recompileContext: {
          recompileByConversation: new Map(),
          recompileQueuedByConversation: new Set(),
        },
      });

    expect(candidates.map((candidate) => candidate.conversationId)).toEqual([
      "idle-good",
    ]);
  });

  test("skips candidates with active reflection subagents or busy runtimes", async () => {
    await appendCompletedTurns("idle-good", 3);
    await appendCompletedTurns("reflection-active", 3);
    await appendCompletedTurns("runtime-busy", 3);

    await ageTranscript("idle-good", 25);
    await ageTranscript("reflection-active", 25);
    await ageTranscript("runtime-busy", 25);

    registerSubagent(
      "reflection-subagent",
      "reflection",
      "Reflecting",
      undefined,
      true,
      true,
      { agentId, conversationId: "reflection-active" },
    );

    const candidates =
      await __idleReflectionSweepTestUtils.discoverIdleReflectionCandidates({
        agentId,
        activeConversationId: "active",
        workingDirectory: "/tmp/work",
        reflectionSettings: normalizeReflectionSettings({
          trigger: "step-count",
          stepCount: 25,
          idleSweepEnabled: true,
          idleSweepIntervalHours: 24,
          idleConversationMinAgeHours: 24,
          idleMinUnreflectedTurns: 3,
        }),
        recompileContext: {
          recompileByConversation: new Map(),
          recompileQueuedByConversation: new Set(),
        },
        listenerRuntime: {
          conversationRuntimes: new Map([
            [
              "runtime-busy",
              {
                agentId,
                conversationId: "runtime-busy",
                isProcessing: true,
                isRecoveringApprovals: false,
                queuePumpActive: false,
                queuePumpScheduled: false,
                pendingTurns: 0,
                queuedMessagesByItemId: new Map(),
                queueRuntime: [],
              },
            ],
          ]),
        } as never,
      });

    expect(candidates.map((candidate) => candidate.conversationId)).toEqual([
      "idle-good",
    ]);
  });
});
