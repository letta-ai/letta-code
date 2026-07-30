#!/usr/bin/env bun
/**
 * Headless bidirectional reflection scenario.
 *
 * Intended for CI as a dedicated Reflection / Headless check. It exercises the
 * authenticated API headless bidirectional path with MemFS enabled and verifies
 * that auto-reflection creates the right transcript metadata and payload.
 */

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
import reflectionSubagentMd from "@/agent/subagents/builtin/reflection.md";
import { formatCapturedOutput } from "@/integration-tests/process-diagnostics";
import { createAuthenticatedCliTestEnv } from "./test-process-env";

interface Args {
  model: string;
  reflectionModel: string;
}

interface ReflectionTranscriptState {
  schema_version?: string;
  reflected_through_message_id?: string;
  total_completed_steps?: number;
  reflected_completed_steps?: number;
  steps_since_last_successful_reflection?: number;
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
const DEFAULT_REFLECTION_MODEL = "gpt-5.4-mini-low";

function parseArgs(argv: string[]): Args {
  const args: Args = {
    model: "auto",
    reflectionModel: DEFAULT_REFLECTION_MODEL,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--model") {
      args.model = argv[++i] ?? args.model;
    } else if (value === "--reflection-model") {
      args.reflectionModel = argv[++i] ?? args.reflectionModel;
    } else if (value === "--help" || value === "-h") {
      console.log(
        "Usage: bun run src/test-utils/headless-reflection-scenario.ts [--model auto] [--reflection-model gpt-5.4-mini-low]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return args;
}

async function runLiveBidirectionalReflectionSmoke(
  args: Args,
): Promise<LiveReflectionSummary> {
  const tmpRoot = await mkdtemp(join(tmpdir(), "letta-live-bidir-reflection-"));
  const homeDir = join(tmpRoot, "home");
  const projectDir = join(tmpRoot, "project");
  const transcriptRoot = join(tmpRoot, "transcripts");
  await mkdir(join(homeDir, ".letta"), { recursive: true });
  await mkdir(join(homeDir, ".letta", "agents"), { recursive: true });
  await mkdir(projectDir, { recursive: true });
  await mkdir(transcriptRoot, { recursive: true });

  await writeFile(
    join(homeDir, ".letta", "agents", "reflection.md"),
    reflectionSubagentMd.replace(
      "\nmodel: inherit\n",
      `\nmodel: ${args.reflectionModel}\n`,
    ),
  );

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
      model: args.model,
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
  model: string;
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
        paths.model,
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
      (state?.total_completed_steps ?? 0) >= 2 &&
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

function assertTrue(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertScenario(summary: LiveReflectionSummary): void {
  const details = formatSummary(summary);
  assertTrue(summary.code === 0, `Expected exit code 0.\n${details}`);
  assertTrue(summary.signal === null, `Expected no signal.\n${details}`);
  assertTrue(summary.agentId, `Missing agent id.\n${details}`);
  assertTrue(summary.conversationId, `Missing conversation id.\n${details}`);
  assertTrue(
    summary.resultCount >= 2,
    `Expected at least two completed steps.\n${details}`,
  );
  assertTrue(
    summary.reflectionLaunchCount >= 1,
    `Expected reflection launch log.\n${details}`,
  );
  assertTrue(
    summary.transcriptLines.length >= 4,
    `Expected user/assistant transcript rows.\n${details}`,
  );
  assertTrue(
    summary.transcriptLines.join("\n").includes(TURN_ONE_MARKER),
    `Transcript missing first marker.\n${details}`,
  );
  assertTrue(
    summary.transcriptLines.join("\n").includes(TURN_TWO_MARKER),
    `Transcript missing second marker.\n${details}`,
  );
  assertTrue(
    summary.payloadFiles.length >= 1,
    `Expected at least one auto reflection payload.\n${details}`,
  );
  assertTrue(
    summary.state?.schema_version === "v3_assistant_steps",
    `Unexpected reflection state schema.\n${details}`,
  );
  assertTrue(
    (summary.state?.total_completed_steps ?? 0) >= 2,
    `Reflection state did not record completed steps.\n${details}`,
  );
  assertTrue(
    summary.state?.last_reflection_started_at,
    `Reflection state did not record launch timestamp.\n${details}`,
  );

  const firstPayload = parsePayload(summary.firstPayloadText);
  assertTrue(
    firstPayload.roles[0] === "meta",
    `Payload missing leading metadata record.\n${details}`,
  );
  assertTrue(
    !firstPayload.roles.includes("system"),
    `Payload unexpectedly includes a system message.\n${details}`,
  );
  assertTrue(
    firstPayload.roles.includes("user"),
    `Payload missing user message.\n${details}`,
  );
  assertTrue(
    firstPayload.roles.includes("assistant"),
    `Payload missing assistant message.\n${details}`,
  );
  assertTrue(
    firstPayload.text.includes(TURN_ONE_MARKER),
    `Payload missing first marker.\n${details}`,
  );
  assertTrue(
    !firstPayload.text.includes(TURN_TWO_MARKER),
    `Payload should not include second marker from after the launch snapshot.\n${details}`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.LETTA_API_KEY) {
    console.log("SKIP: Missing env LETTA_API_KEY");
    return;
  }

  const summary = await runLiveBidirectionalReflectionSmoke(args);
  assertScenario(summary);
  console.log(
    `OK: reflection / headless / ${args.model} / reflection ${args.reflectionModel}`,
  );
}

main().catch((error) => {
  console.error(String(error?.stack || error));
  process.exit(1);
});
