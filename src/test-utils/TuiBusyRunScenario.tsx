import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";

const scenario = process.argv[2];
if (!scenario || !["busy", "normal", "accepted-own-otid"].includes(scenario)) {
  throw new Error(`Unknown TUI busy-run scenario: ${scenario ?? "missing"}`);
}

const home = mkdtempSync(join(tmpdir(), "letta-busy-run-"));
const require = createRequire(import.meta.url);
require("node:os").homedir = () => home;
Object.assign(process.env, {
  HOME: home,
  USERPROFILE: home,
  LETTA_HOME: join(home, ".letta"),
  MEMORY_DIR: join(home, "memory"),
  LETTA_MEMORY_DIR: join(home, "memory"),
  LETTA_LOCAL_BACKEND_DIR: join(home, "local-backend"),
  LETTA_TRANSCRIPT_ROOT: join(home, "transcripts"),
  LETTA_DEBUG_FILE: join(home, "debug.log"),
  LETTA_CODE_TELEM: "0",
  LETTA_API_KEY: "test-no-live-access",
  LETTA_BASE_URL: "http://127.0.0.1:1",
  LETTA_TEST_SECRETS_SERVICE_PREFIX: `letta-busy-run-${process.pid}`,
});
globalThis.fetch = Object.assign(
  async () => {
    throw new Error("Unexpected network request from isolated TUI fixture");
  },
  { preconnect: () => {} },
);

const { render } = await import("ink");
const { createElement } = await import("react");
const { APIError } = await import("@letta-ai/letta-client/core/error");
const { __testSetBackend, getBackend } = await import("@/backend");
const { createBuffers } = await import("@/cli/helpers/accumulator");
const { createContextTracker } = await import("@/cli/helpers/context-tracker");
const { useConversationLoop } = await import("@/cli/app/use-conversation-loop");
const { SessionStats } = await import("@/agent/stats");
const { createDisabledModAdapter } = await import(
  "@/mods/disabled-mod-adapter"
);
const { prepareCurrentToolExecutionContext } = await import("@/tools/manager");
const { settingsManager } = await import("@/settings-manager");

type Context = Parameters<typeof useConversationLoop>[0];
type ResumeBody = Parameters<
  ReturnType<typeof getBackend>["streamConversationMessages"]
>[1];
type Scenario = "busy" | "normal" | "accepted-own-otid";
type SentPayload = { otid?: string; content?: unknown; [key: string]: unknown };

const runId = "run-11111111-1111-4111-8111-111111111111";
const requestOtid = "33333333-3333-4333-8333-333333333333";
const userText = "Keep this new input after the blocking run finishes.";
const noop = () => {};
const ref = <T,>(current: T) => ({ current });
const errors: unknown[] = [];
const sentPayloads: unknown[] = [];
const acceptedPayloads: unknown[] = [];
function capturedMessages(body: SentPayload): unknown {
  return structuredClone(body.messages ?? body);
}
const resumeBodies: ResumeBody[] = [];
let blockingRunActive = true;
let runPolls = 0;
const originalNow = Date.now;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const timers = new Map<
  ReturnType<typeof setTimeout>,
  {
    due: number;
    callback: (...args: unknown[]) => void;
    args: unknown[];
  }
>();
let pump: ReturnType<typeof setTimeout> | null = null;
let clock = 0;
const blockerCompletesAt = 90_000;

function scheduleNextTimer(): void {
  if (pump || timers.size === 0) return;
  pump = originalSetTimeout(() => {
    pump = null;
    let next:
      | [
          ReturnType<typeof setTimeout>,
          {
            due: number;
            callback: (...args: unknown[]) => void;
            args: unknown[];
          },
        ]
      | undefined;
    for (const entry of timers) {
      if (!next || entry[1].due < next[1].due) next = entry;
    }
    if (!next) return;
    const [handle, timer] = next;
    timers.delete(handle);
    originalClearTimeout(handle);
    clock = Math.max(clock, timer.due);
    timer.callback(...timer.args);
    scheduleNextTimer();
  }, 0);
}

await settingsManager.initialize();
const preparedToolContext = await prepareCurrentToolExecutionContext({
  workingDirectory: home,
});
const disabledMods = createDisabledModAdapter();
const context: Context = {
  abortControllerRef: ref(null),
  agentIdRef: ref("agent-synthetic"),
  appendError: (error) => {
    errors.push(error);
  },
  appendTaskNotificationEvents: () => false,
  approvalToolContextIdRef: ref(null),
  autoAllowedExecutionRef: ref(null),
  buffersRef: ref(createBuffers("agent-synthetic")),
  clearApprovalToolContext: noop,
  closeTrajectorySegment: noop,
  consumeQueuedMessages: () => null,
  queueModeRef: ref("immediate"),
  contextTrackerRef: ref(createContextTracker()),
  chatgptPlanSwapsRef: ref(0),
  chatgptExhaustedProvidersRef: ref(new Set()),
  conversationBusyRetriesRef: ref(0),
  conversationGenerationRef: ref(0),
  conversationIdRef: ref("conv-synthetic"),
  currentModelId: "synthetic-model",
  emptyResponseRetriesRef: ref(0),
  executingToolCallIdsRef: ref([]),
  generateConversationDescription: async () => {},
  modAdapter: {
    ...disabledMods,
    ...disabledMods.getSnapshot(),
    context: {} as Context["modAdapter"]["context"],
  },
  generateConversationTitle: async () => null,
  hasConversationModelOverrideRef: ref(false),
  interruptQueuedRef: ref(false),
  isAutoConversationTitleInFlightRef: ref(false),
  lastDequeuedMessageRef: ref(null),
  lastRunIdRef: ref(null),
  lastSentInputRef: ref(null),
  llmApiErrorRetriesRef: ref(0),
  llmConfigRef: ref(null),
  maybeRunPostTurnReflection: async () => {},
  needsEagerApprovalCheck: false,
  openTrajectorySegment: noop,
  pendingInterruptRecoveryConversationIdRef: ref(null),
  pendingTranscriptStartLineIndexRef: ref(null),
  precomputedDiffsRef: ref(new Map()),
  prepareScopedToolExecutionContext: async () => ({
    preparedToolContext,
    toolset: "letta",
    toolsetPreference: "auto",
    effectiveModel: "synthetic-model",
    agent: null,
  }),
  processingConversationRef: ref(0),
  queuedApprovalResultsRef: ref(null),
  queueApprovalResults: noop,
  queueSnapshotRef: ref([]),
  quotaAutoSwapAttemptedRef: ref(false),
  refreshDerived: noop,
  refreshDerivedThrottled: noop,
  resetTrajectoryBases: noop,
  restoreQueueOnCancelRef: ref(false),
  sessionStatsRef: ref(new SessionStats()),
  setAgentDescription: noop,
  setAgentLastRunAt: noop,
  setAgentState: noop,
  setApprovalContexts: noop,
  setApprovalResults: noop,
  setAutoDeniedApprovals: noop,
  setAutoHandledResults: noop,
  setCurrentModelHandle: noop,
  setCurrentModelId: noop,
  setDequeueEpoch: noop,
  setInterruptRequested: noop,
  lastStopReasonRef: ref(null),
  setIsExecutingTool: noop,
  setLlmConfig: noop,
  setNeedsEagerApprovalCheck: noop,
  setNetworkPhase: noop,
  setExecutionPhase: noop,
  setPendingApprovals: noop,
  setRestoreQueueOnCancel: noop,
  setRestoredInput: noop,
  setStreaming: noop,
  setConversationSummary: noop,
  setTempModelOverride: noop,
  setThinkingMessage: noop,
  setTrajectoryElapsedBaseMs: noop,
  setTrajectoryTokenBase: noop,
  setUiPermissionMode: noop,
  shouldAutoGenerateConversationTitleRef: ref(false),
  syncTrajectoryElapsedBase: noop,
  syncTrajectoryTokenBase: noop,
  tempModelOverrideRef: ref(null),
  toolAbortControllerRef: ref(null),
  toolResultsInFlightRef: ref(false),
  trajectoryRunTokenStartRef: ref(0),
  trajectorySegmentStartRef: ref(null),
  trajectoryTokenDisplayRef: ref(0),
  tuiQueueRef: ref(null),
  uiPermissionModeRef: ref(
    "default" as Context["uiPermissionModeRef"]["current"],
  ),
  updateStreamingOutput: noop,
  userCancelledRef: ref(false),
  waitingForQueueCancelRef: ref(false),
};

const originalBackend = getBackend();
function stopStream(streamRunId: string) {
  return {
    controller: new AbortController(),
    async *[Symbol.asyncIterator]() {
      yield {
        message_type: "stop_reason",
        stop_reason: "end_turn",
        run_id: streamRunId,
        seq_id: 1,
      };
    },
  };
}
const fakeBackend = Object.create(
  originalBackend,
  Object.getOwnPropertyDescriptors({
    capabilities: { ...originalBackend.capabilities, localModelCatalog: false },
    async createConversationMessageStream(_id: string, body: SentPayload) {
      sentPayloads.push(capturedMessages(body));
      if (scenario === "normal") {
        acceptedPayloads.push(capturedMessages(body));
        return stopStream("run-normal");
      }
      if (scenario === "accepted-own-otid" && sentPayloads.length === 1) {
        acceptedPayloads.push(capturedMessages(body));
        throw new APIError(
          409,
          {
            detail: `Another request (run_id=${runId}) is currently being processed for this conversation.`,
            run_id: runId,
          },
          undefined,
          new Headers(),
        );
      }
      if (scenario === "busy" && clock >= blockerCompletesAt) {
        blockingRunActive = false;
        acceptedPayloads.push(capturedMessages(body));
        return stopStream("run-original-input");
      }
      throw new APIError(
        409,
        {
          detail: `Another request (run_id=${runId}) is currently being processed for this conversation.`,
          run_id: runId,
        },
        undefined,
        new Headers(),
      );
    },
    async streamConversationMessages(_id: string, body: ResumeBody) {
      resumeBodies.push(body);
      if (scenario === "accepted-own-otid" && body?.otid === requestOtid) {
        return stopStream("run-own-request");
      }
      if (body?.run_id === runId) {
        return {
          controller: new AbortController(),
          async *[Symbol.asyncIterator]() {
            await new Promise((resolve) =>
              setTimeout(resolve, Math.max(0, blockerCompletesAt - clock)),
            );
            blockingRunActive = false;
            yield {
              message_type: "stop_reason",
              stop_reason: "end_turn",
              run_id: runId,
              seq_id: 1,
            };
          },
        };
      }
      throw new APIError(
        404,
        { detail: "No run found for the provided otid" },
        undefined,
        new Headers(),
      );
    },
    async retrieveRun(id: string) {
      if (id !== runId)
        throw new Error("Fixture polled a run outside its synthetic blocker");
      runPolls += 1;
      blockingRunActive = clock < blockerCompletesAt;
      return {
        id,
        agent_id: "agent-synthetic",
        status: blockingRunActive ? "running" : "completed",
      };
    },
    async retrieveAgent() {
      throw new Error(
        "Agent metadata is unavailable in this transport fixture",
      );
    },
  }),
);
__testSetBackend(fakeBackend);
if (scenario === "busy") {
  Date.now = () => clock;
  globalThis.setTimeout = ((
    callback: (...args: unknown[]) => void,
    delay = 0,
    ...args: unknown[]
  ) => {
    const handle = originalSetTimeout(() => {}, 2_147_483_647);
    handle.unref();
    timers.set(handle, { due: clock + Math.max(0, delay), callback, args });
    scheduleNextTimer();
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((
    handle: ReturnType<typeof originalSetTimeout> | string | number | undefined,
  ) => {
    timers.delete(handle as ReturnType<typeof originalSetTimeout>);
    originalClearTimeout(handle);
  }) as typeof clearTimeout;
}

class CaptureStream extends Writable {
  columns = 100;
  rows = 24;
  isTTY = true;
  override _write(_chunk: unknown, _encoding: string, callback: () => void) {
    callback();
  }
}
const stdout = new CaptureStream();
const stdin = new PassThrough();
let processConversation: ReturnType<typeof useConversationLoop> | undefined;
function Probe() {
  processConversation = useConversationLoop(context);
  return null;
}
const instance = render(createElement(Probe), {
  stdout: stdout as unknown as NodeJS.WriteStream,
  stderr: stdout as unknown as NodeJS.WriteStream,
  stdin: stdin as unknown as NodeJS.ReadStream,
  exitOnCtrlC: false,
  patchConsole: false,
});

try {
  if (!processConversation)
    throw new Error("The actual interactive hook did not mount");
  await processConversation([
    {
      type: "message",
      role: "user",
      content: userText,
      otid: requestOtid,
    },
  ]);
  console.log(
    `TUI_BUSY_RESULT=${JSON.stringify({
      runtime: process.version,
      bun: process.versions.bun ?? null,
      source: "useConversationLoop",
      scenario: scenario as Scenario,
      virtualElapsedMs: clock,
      blockerCompletesAt,
      sentPayloads,
      acceptedPayloads,
      runPolls,
      lastStopReason: context.lastStopReasonRef.current,
      resumeBodies,
      errors,
    })}`,
  );
} finally {
  Date.now = originalNow;
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
  if (pump) originalClearTimeout(pump);
  for (const handle of timers.keys()) originalClearTimeout(handle);
  instance.unmount();
  __testSetBackend(originalBackend);
}
