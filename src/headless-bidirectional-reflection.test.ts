import { afterAll, describe, expect, test } from "bun:test";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createIsolatedCliTestEnv } from "@/test-utils/test-process-env";

type JsonObject = Record<string, unknown>;

interface ReflectionTranscriptState {
  total_completed_steps?: number;
  reflected_completed_steps?: number;
  steps_since_last_successful_reflection?: number;
  last_reflection_started_at?: string;
  last_reflection_succeeded_at?: string;
  reflected_through_message_id?: string;
}

interface BidirectionalReflectionSummary {
  code: number | null;
  signal: NodeJS.Signals | null;
  tmpRoot: string;
  agentId: string | null;
  conversationId: string | null;
  resultCount: number;
  reflectionLaunchCount: number;
  events: Array<{
    type?: unknown;
    subtype?: unknown;
    result?: unknown;
    conversationId?: unknown;
  }>;
  transcriptDir: string | null;
  transcriptLines: string[];
  payloadFiles: string[];
  state: ReflectionTranscriptState | null;
  stdoutTail: string;
  stderrTail: string;
}

const cliProcesses = new Set<ChildProcessWithoutNullStreams>();
const tempRoots: string[] = [];

afterAll(async () => {
  for (const child of cliProcesses) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
  }
  await Promise.all(
    tempRoots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("headless bidirectional auto-reflection", () => {
  test("records completed turns and launches step-count reflection from transcript state", async () => {
    const summary = await runBidirectionalReflectionScenario();

    expect(summary.code, formatSummary(summary)).toBe(0);
    expect(summary.signal, formatSummary(summary)).toBeNull();
    expect(summary.resultCount, formatSummary(summary)).toBe(3);
    expect(summary.agentId, formatSummary(summary)).toBeTruthy();
    expect(summary.conversationId, formatSummary(summary)).toBeTruthy();
    expect(summary.transcriptDir, formatSummary(summary)).toBeTruthy();

    expect(summary.transcriptLines, formatSummary(summary)).toHaveLength(6);
    expect(summary.transcriptLines[0]).toContain('"kind":"user"');
    expect(summary.transcriptLines[0]).toContain("hello one");
    expect(summary.transcriptLines[1]).toContain('"kind":"assistant"');
    expect(summary.transcriptLines[1]).toContain(
      '"source_message_id":"letta-msg-1"',
    );

    // Reflection launches post-turn, so every completed turn gets reflected.
    // The harness waits for each reflection cycle to finish before sending the
    // next message, making the final state exact: any silent breakage in the
    // trigger or launcher fails these assertions.
    expect(summary.reflectionLaunchCount, formatSummary(summary)).toBe(3);
    expect(summary.payloadFiles.length, formatSummary(summary)).toBe(3);
    expect(summary.state?.total_completed_steps, formatSummary(summary)).toBe(
      3,
    );
    expect(
      summary.state?.reflected_completed_steps,
      formatSummary(summary),
    ).toBe(3);
    expect(
      summary.state?.steps_since_last_successful_reflection,
      formatSummary(summary),
    ).toBe(0);
    expect(
      summary.state?.last_reflection_started_at,
      formatSummary(summary),
    ).toBeTruthy();
    expect(
      summary.state?.last_reflection_succeeded_at,
      formatSummary(summary),
    ).toBeTruthy();
    expect(
      summary.state?.reflected_through_message_id,
      formatSummary(summary),
    ).toBe("letta-msg-3");
  }, 30_000);
});

async function runBidirectionalReflectionScenario(): Promise<BidirectionalReflectionSummary> {
  const tmpRoot = await mkdtemp(join(tmpdir(), "letta-bidir-reflection-test-"));
  tempRoots.push(tmpRoot);
  const homeDir = join(tmpRoot, "home");
  const projectDir = join(tmpRoot, "project");
  const localBackendDir = join(tmpRoot, "local-backend");
  const transcriptRoot = join(tmpRoot, "transcripts");
  mkdirSync(join(homeDir, ".letta"), { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(localBackendDir, { recursive: true });
  mkdirSync(transcriptRoot, { recursive: true });

  writeFileSync(
    join(homeDir, ".letta", "settings.json"),
    JSON.stringify(
      {
        tokenStreaming: false,
        sessionContextEnabled: true,
        memoryReminderInterval: 1,
        reflectionTrigger: "step-count",
        reflectionStepCount: 1,
        agents: [],
      },
      null,
      2,
    ),
  );

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const cliEntry = join(repoRoot, "src", "index.ts");
  const child = spawn(
    process.execPath,
    [
      "--loader=.md:text",
      "--loader=.mdx:text",
      "--loader=.txt:text",
      "run",
      cliEntry,
      "--backend",
      "local",
      "--new-agent",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--no-system-info-reminder",
    ],
    {
      cwd: projectDir,
      env: createIsolatedCliTestEnv({
        HOME: homeDir,
        LETTA_LOCAL_BACKEND_DIR: localBackendDir,
        LETTA_LOCAL_BACKEND_EXECUTOR: "deterministic",
        LETTA_TRANSCRIPT_ROOT: transcriptRoot,
        // This test exercises transcript-driven reflection, not kernel sandbox
        // behavior. Keep it independent of host bwrap/seatbelt availability.
        LETTA_FS_SANDBOX: "0",
        USER_CWD: projectDir,
        LETTA_DEBUG: "1",
        NO_COLOR: "1",
      }),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  cliProcesses.add(child);

  let stdout = "";
  let stderr = "";
  let pendingStdout = "";
  let sentFirstMessage = false;
  let resultCount = 0;
  let closeScheduled = false;
  let agentId: string | null = null;
  let conversationId: string | null = null;
  const events: BidirectionalReflectionSummary["events"] = [];

  const sendUser = (content: string) => {
    child.stdin.write(
      `${JSON.stringify({ type: "user", message: { content } })}\n`,
    );
  };

  const transcriptDir = () =>
    agentId && conversationId
      ? join(transcriptRoot, agentId, conversationId)
      : null;

  const scheduleCloseAfterReflection = () => {
    if (closeScheduled) return;
    closeScheduled = true;
    void waitForReflectionProgress(transcriptDir, {
      reflectedCompletedSteps: 3,
      payloadCount: 3,
      timeoutMs: 10_000,
    }).finally(() => {
      child.stdin.end();
    });
  };

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    stdout += text;
    pendingStdout += text;

    while (true) {
      const newlineIndex = pendingStdout.indexOf("\n");
      if (newlineIndex < 0) break;
      const line = pendingStdout.slice(0, newlineIndex).trim();
      pendingStdout = pendingStdout.slice(newlineIndex + 1);
      if (!line) continue;

      let parsed: JsonObject;
      try {
        parsed = JSON.parse(line) as JsonObject;
      } catch {
        continue;
      }

      agentId = typeof parsed.agent_id === "string" ? parsed.agent_id : agentId;
      conversationId =
        typeof parsed.conversation_id === "string"
          ? parsed.conversation_id
          : conversationId;
      events.push({
        type: parsed.type,
        subtype: parsed.subtype,
        result: parsed.result,
        conversationId: parsed.conversation_id,
      });

      if (
        parsed.type === "system" &&
        parsed.subtype === "init" &&
        !sentFirstMessage
      ) {
        sentFirstMessage = true;
        sendUser("hello one");
      }

      if (parsed.type === "result") {
        resultCount += 1;
        // Each turn's reflection launches post-turn. The next turn is allowed
        // to start only after that background reflection finishes; otherwise
        // the active-reflection guard correctly skips duplicate launches and
        // the final counts would depend on timing instead of being exact.
        if (resultCount === 1) {
          void waitForReflectionProgress(transcriptDir, {
            reflectedCompletedSteps: 1,
            payloadCount: 1,
            timeoutMs: 10_000,
          }).finally(() => sendUser("hello two"));
        } else if (resultCount === 2) {
          void waitForReflectionProgress(transcriptDir, {
            reflectedCompletedSteps: 2,
            payloadCount: 2,
            timeoutMs: 10_000,
          }).finally(() => sendUser("hello three"));
        } else if (resultCount === 3) {
          scheduleCloseAfterReflection();
        }
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const timeout = setTimeout(() => {
    child.kill("SIGTERM");
  }, 25_000);

  const { code, signal } = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolvePromise) => {
    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      cliProcesses.delete(child);
      resolvePromise({ code, signal });
    });
  });

  const finalTranscriptDir = transcriptDir();
  const state = finalTranscriptDir
    ? readReflectionState(finalTranscriptDir)
    : null;
  const transcriptLines = finalTranscriptDir
    ? readTranscriptLines(finalTranscriptDir)
    : [];
  const payloadFiles = finalTranscriptDir
    ? readPayloadFiles(finalTranscriptDir)
    : [];

  return {
    code,
    signal,
    tmpRoot,
    agentId,
    conversationId,
    resultCount,
    reflectionLaunchCount: countOccurrences(
      stderr,
      "Launched reflection subagent (step-count)",
    ),
    events,
    transcriptDir: finalTranscriptDir,
    transcriptLines,
    payloadFiles,
    state,
    stdoutTail: tail(stdout),
    stderrTail: tail(stderr),
  };
}

async function waitForReflectionProgress(
  getTranscriptDir: () => string | null,
  options: {
    reflectedCompletedSteps: number;
    payloadCount: number;
    timeoutMs: number;
  },
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < options.timeoutMs) {
    const dir = getTranscriptDir();
    const state = dir ? readReflectionState(dir) : null;
    const payloadCount = dir ? readPayloadFiles(dir).length : 0;
    if (
      (state?.reflected_completed_steps ?? 0) >=
        options.reflectedCompletedSteps &&
      payloadCount >= options.payloadCount
    ) {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
}

function readReflectionState(dir: string): ReflectionTranscriptState | null {
  try {
    return JSON.parse(
      readFileSync(join(dir, "state.json"), "utf-8"),
    ) as ReflectionTranscriptState;
  } catch {
    return null;
  }
}

function readTranscriptLines(dir: string): string[] {
  try {
    return readFileSync(join(dir, "transcript.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

function readPayloadFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter(
        (name) => name.startsWith("payload-auto-") && name.endsWith(".json"),
      )
      .sort();
  } catch {
    return [];
  }
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let index = 0;
  while (true) {
    index = text.indexOf(needle, index);
    if (index === -1) return count;
    count += 1;
    index += needle.length;
  }
}

function tail(text: string): string {
  return text.split("\n").slice(-80).join("\n");
}

function formatSummary(summary: BidirectionalReflectionSummary): string {
  return JSON.stringify(
    {
      code: summary.code,
      signal: summary.signal,
      tmpRoot: summary.tmpRoot,
      agentId: summary.agentId,
      conversationId: summary.conversationId,
      resultCount: summary.resultCount,
      reflectionLaunchCount: summary.reflectionLaunchCount,
      transcriptDir: summary.transcriptDir,
      payloadFiles: summary.payloadFiles,
      state: summary.state,
      transcriptLines: summary.transcriptLines,
      events: summary.events,
      stdoutTail: summary.stdoutTail,
      stderrTail: summary.stderrTail,
    },
    null,
    2,
  );
}
