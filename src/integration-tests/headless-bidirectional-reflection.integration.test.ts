import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthenticatedCliTestEnv } from "@/test-utils/test-process-env";
import { formatCapturedOutput } from "./process-diagnostics";

interface ReflectionTranscriptState {
  schema_version?: string;
  reflected_through_message_id?: string;
  total_completed_turns?: number;
  reflected_completed_turns?: number;
  turns_since_last_successful_reflection?: number;
  last_reflection_started_at?: string;
  last_reflection_succeeded_at?: string;
}

interface PayloadFile {
  name: string;
  path: string;
  mtimeMs: number;
}

interface LiveReflectionSummary {
  code: number | null;
  signal: NodeJS.Signals | null;
  tmpRoot: string;
  agentId: string | null;
  conversationId: string | null;
  resultCount: number;
  reflectionLaunchCount: number;
  transcriptDir: string | null;
  transcriptLines: string[];
  payloadFiles: PayloadFile[];
  firstPayloadText: string;
  state: ReflectionTranscriptState | null;
  stdout: string;
  stderr: string;
}

const TURN_ONE_MARKER = "LIVE_REFLECTION_TURN_ONE_MARKER";
const TURN_TWO_MARKER = "LIVE_REFLECTION_TURN_TWO_MARKER";

describe("headless bidirectional reflection integration", () => {
  test(
    "launches reflection with the newly recorded transcript payload",
    async () => {
      if (!process.env.LETTA_API_KEY) {
        console.log("SKIP: Missing LETTA_API_KEY");
        return;
      }

      const summary = await runLiveBidirectionalReflectionSmoke();

      expect(summary.code, formatSummary(summary)).toBe(0);
      expect(summary.signal, formatSummary(summary)).toBeNull();
      expect(summary.agentId, formatSummary(summary)).toBeTruthy();
      expect(summary.conversationId, formatSummary(summary)).toBeTruthy();
      expect(
        summary.resultCount,
        formatSummary(summary),
      ).toBeGreaterThanOrEqual(2);
      expect(
        summary.reflectionLaunchCount,
        formatSummary(summary),
      ).toBeGreaterThanOrEqual(1);

      expect(
        summary.transcriptLines.length,
        formatSummary(summary),
      ).toBeGreaterThanOrEqual(4);
      expect(
        summary.transcriptLines.join("\n"),
        formatSummary(summary),
      ).toContain(TURN_ONE_MARKER);
      expect(
        summary.transcriptLines.join("\n"),
        formatSummary(summary),
      ).toContain(TURN_TWO_MARKER);
      expect(
        summary.payloadFiles.length,
        formatSummary(summary),
      ).toBeGreaterThanOrEqual(1);

      expect(summary.state?.schema_version, formatSummary(summary)).toBe(
        "v2_message_id",
      );
      expect(
        summary.state?.total_completed_turns,
        formatSummary(summary),
      ).toBeGreaterThanOrEqual(2);
      expect(
        summary.state?.last_reflection_started_at,
        formatSummary(summary),
      ).toBeTruthy();

      const firstPayload = parsePayload(summary.firstPayloadText);
      expect(firstPayload.roles, formatSummary(summary)).toContain("system");
      expect(firstPayload.roles, formatSummary(summary)).toContain("user");
      expect(firstPayload.roles, formatSummary(summary)).toContain("assistant");
      expect(firstPayload.text, formatSummary(summary)).toContain(
        TURN_ONE_MARKER,
      );
      expect(firstPayload.text, formatSummary(summary)).not.toContain(
        TURN_TWO_MARKER,
      );
    },
    { timeout: 180_000 },
  );
});

async function runLiveBidirectionalReflectionSmoke(): Promise<LiveReflectionSummary> {
  const tmpRoot = await mkdtemp(join(tmpdir(), "letta-live-bidir-reflection-"));
  const homeDir = join(tmpRoot, "home");
  const projectDir = join(tmpRoot, "project");
  const transcriptRoot = join(tmpRoot, "transcripts");
  await mkdir(join(homeDir, ".letta"), { recursive: true });
  await mkdir(projectDir, { recursive: true });
  await mkdir(transcriptRoot, { recursive: true });

  await writeFile(
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

  try {
    return await runLiveBidirectionalCli({
      tmpRoot,
      homeDir,
      projectDir,
      transcriptRoot,
    });
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

async function runLiveBidirectionalCli(paths: {
  tmpRoot: string;
  homeDir: string;
  projectDir: string;
  transcriptRoot: string;
}): Promise<LiveReflectionSummary> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "bun",
      [
        "run",
        "dev",
        "--new-agent",
        "--memfs",
        "--memfs-startup",
        "skip",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--reflection-trigger",
        "step-count",
        "--reflection-step-count",
        "1",
        "--no-system-info-reminder",
        "--yolo",
        "-m",
        "sonnet-4.6-low",
      ],
      {
        cwd: process.cwd(),
        env: createAuthenticatedCliTestEnv({
          HOME: paths.homeDir,
          LETTA_TRANSCRIPT_ROOT: paths.transcriptRoot,
          USER_CWD: paths.projectDir,
          LETTA_DEBUG: "1",
          NO_COLOR: "1",
        }),
      },
    );

    let stdout = "";
    let stderr = "";
    let pendingStdout = "";
    let agentId: string | null = null;
    let conversationId: string | null = null;
    let resultCount = 0;
    let closing = false;

    const transcriptDir = () =>
      agentId && conversationId
        ? join(paths.transcriptRoot, agentId, conversationId)
        : null;

    const sendUser = (content: string) => {
      proc.stdin.write(
        `${JSON.stringify({ type: "user", message: { content } })}\n`,
      );
    };

    const closeWhenReflectionPayloadExists = () => {
      if (closing) return;
      closing = true;
      void waitForLaunchArtifacts(transcriptDir, 90_000).finally(() => {
        proc.stdin.end();
      });
    };

    proc.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      pendingStdout += text;

      while (true) {
        const newlineIndex = pendingStdout.indexOf("\n");
        if (newlineIndex < 0) break;
        const line = pendingStdout.slice(0, newlineIndex).trim();
        pendingStdout = pendingStdout.slice(newlineIndex + 1);
        if (!line) continue;

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }

        agentId =
          typeof parsed.agent_id === "string" ? parsed.agent_id : agentId;
        conversationId =
          typeof parsed.conversation_id === "string"
            ? parsed.conversation_id
            : conversationId;

        if (parsed.type === "system" && parsed.subtype === "init") {
          sendUser(`Reply with OK only. Do not use tools. ${TURN_ONE_MARKER}`);
        }

        if (parsed.type === "result") {
          resultCount += 1;
          if (resultCount === 1) {
            setTimeout(
              () =>
                sendUser(
                  `Reply with OK only. Do not use tools. ${TURN_TWO_MARKER}`,
                ),
              1_000,
            );
          } else if (resultCount === 2) {
            closeWhenReflectionPayloadExists();
          }
        }
      }
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(
        new Error(
          `Timed out waiting for live bidirectional reflection smoke.\n${formatCapturedOutput(
            {
              stdout,
              stderr,
              extra: {
                agent_id: agentId ?? "(unknown)",
                conversation_id: conversationId ?? "(unknown)",
                result_count: resultCount,
              },
            },
          )}`,
        ),
      );
    }, 180_000);

    proc.on("close", (code, signal) => {
      clearTimeout(timeout);
      void buildSummary({
        code,
        signal,
        tmpRoot: paths.tmpRoot,
        transcriptRoot: paths.transcriptRoot,
        transcriptDir: transcriptDir(),
        agentId,
        conversationId,
        resultCount,
        stdout,
        stderr,
      })
        .then(resolve)
        .catch(reject);
    });
  });
}

async function waitForLaunchArtifacts(
  getTranscriptDir: () => string | null,
  timeoutMs: number,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const dir = getTranscriptDir();
    const state = dir ? await readReflectionState(dir) : null;
    const payloadFiles = dir ? await readPayloadFiles(dir) : [];
    if (
      (state?.total_completed_turns ?? 0) >= 2 &&
      state?.last_reflection_started_at &&
      payloadFiles.length >= 1
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function buildSummary(args: {
  code: number | null;
  signal: NodeJS.Signals | null;
  tmpRoot: string;
  transcriptRoot: string;
  transcriptDir: string | null;
  agentId: string | null;
  conversationId: string | null;
  resultCount: number;
  stdout: string;
  stderr: string;
}): Promise<LiveReflectionSummary> {
  const state = args.transcriptDir
    ? await readReflectionState(args.transcriptDir)
    : null;
  const transcriptLines = args.transcriptDir
    ? await readTranscriptLines(args.transcriptDir)
    : [];
  const payloadFiles = args.transcriptDir
    ? await readPayloadFiles(args.transcriptDir)
    : [];
  const firstPayloadText = payloadFiles[0]
    ? await readFile(payloadFiles[0].path, "utf-8")
    : "";

  return {
    code: args.code,
    signal: args.signal,
    tmpRoot: args.tmpRoot,
    agentId: args.agentId,
    conversationId: args.conversationId,
    resultCount: args.resultCount,
    reflectionLaunchCount: countOccurrences(
      args.stderr,
      "Launched reflection subagent (step-count)",
    ),
    transcriptDir: args.transcriptDir,
    transcriptLines,
    payloadFiles,
    firstPayloadText,
    state,
    stdout: tail(args.stdout),
    stderr: tail(args.stderr),
  };
}

async function readReflectionState(
  dir: string,
): Promise<ReflectionTranscriptState | null> {
  try {
    return JSON.parse(
      await readFile(join(dir, "state.json"), "utf-8"),
    ) as ReflectionTranscriptState;
  } catch {
    return null;
  }
}

async function readTranscriptLines(dir: string): Promise<string[]> {
  try {
    return (await readFile(join(dir, "transcript.jsonl"), "utf-8"))
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function readPayloadFiles(dir: string): Promise<PayloadFile[]> {
  try {
    const names = await readdir(dir);
    const payloads = names.filter(
      (name) => name.startsWith("payload-auto-") && name.endsWith(".json"),
    );
    const withStats = await Promise.all(
      payloads.map(async (name) => {
        const path = join(dir, name);
        return { name, path, mtimeMs: (await stat(path)).mtimeMs };
      }),
    );
    return withStats.sort((a, b) => a.mtimeMs - b.mtimeMs);
  } catch {
    return [];
  }
}

function parsePayload(payloadText: string): { roles: string[]; text: string } {
  const parsed = JSON.parse(payloadText) as Array<{
    role?: string;
    content?: unknown;
  }>;
  return {
    roles: parsed
      .map((entry) => entry.role)
      .filter((role): role is string => typeof role === "string"),
    text: JSON.stringify(parsed),
  };
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

function formatSummary(summary: LiveReflectionSummary): string {
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
      transcriptLines: summary.transcriptLines,
      payloadFiles: summary.payloadFiles.map((file) => file.name),
      state: summary.state,
      firstPayloadText: summary.firstPayloadText.slice(0, 2_000),
      stdout: summary.stdout,
      stderr: summary.stderr,
    },
    null,
    2,
  );
}
