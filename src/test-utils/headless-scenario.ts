#!/usr/bin/env bun
/**
 * Headless scenario test runner
 *
 * Runs a single multi-step scenario against the Letta Code CLI (headless) for a given
 * model and output format. Intended for CI matrix usage.
 *
 * Usage:
 *   bun tsx src/tests/headless-scenario.ts --model gpt-4.1 --output stream-json --parallel on
 *   bun tsx src/tests/headless-scenario.ts --backend local --model openai/gpt-5-mini --output text --parallel on
 */

import { execFile as execFileCb, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  formatAttemptDiagnostics,
  formatCapturedOutput,
} from "@/integration-tests/process-diagnostics";
import {
  createAuthenticatedCliTestEnv,
  createIsolatedCliTestEnv,
} from "./test-process-env";

const execFile = promisify(execFileCb);

type Backend = "api" | "local";
type LocalProvider = "openai" | "anthropic" | "google" | "ollama";

type Args = {
  backend: Backend;
  model: string;
  output: "text" | "json" | "stream-json";
  parallel: "on" | "off" | "hybrid";
  provider?: LocalProvider;
  // Smoke mode: trivial no-tools prompt asserting a sentinel word. Exercises
  // the provider request path (connect/autodetect/round-trip) without the full
  // tool-calling scenario — needed for weak/slow local models (e.g. Ollama on
  // CPU runners) that cannot pass the frontier-model scenario in time.
  smoke: boolean;
};

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
  localStorageDir?: string;
}

function parseArgs(argv: string[]): Args {
  const args: {
    backend: Backend;
    model?: string;
    output: Args["output"];
    parallel: Args["parallel"];
    provider?: LocalProvider;
    smoke: boolean;
  } = {
    backend: "api",
    output: "text",
    parallel: "on",
    smoke: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--backend") args.backend = argv[++i] as Backend;
    else if (v === "--model") args.model = argv[++i];
    else if (v === "--output") args.output = argv[++i] as Args["output"];
    else if (v === "--parallel") args.parallel = argv[++i] as Args["parallel"];
    else if (v === "--provider") args.provider = argv[++i] as LocalProvider;
    else if (v === "--smoke") args.smoke = true;
  }
  if (!args.model) throw new Error("Missing --model");
  if (!["api", "local"].includes(args.backend)) {
    throw new Error(`Invalid --backend ${args.backend}`);
  }
  if (!["text", "json", "stream-json"].includes(args.output)) {
    throw new Error(`Invalid --output ${args.output}`);
  }
  if (!["on", "off", "hybrid"].includes(args.parallel)) {
    throw new Error(`Invalid --parallel ${args.parallel}`);
  }
  if (
    args.provider !== undefined &&
    !["openai", "anthropic", "google", "ollama"].includes(args.provider)
  ) {
    throw new Error(`Invalid --provider ${args.provider}`);
  }
  return args as Args;
}

function inferLocalProvider(model: string): LocalProvider {
  if (model.startsWith("ollama/")) {
    return "ollama";
  }
  if (
    model.startsWith("google/") ||
    model.startsWith("google_ai/") ||
    model.includes("gemini")
  ) {
    return "google";
  }
  if (
    model.startsWith("anthropic/") ||
    model.startsWith("claude") ||
    model.includes("sonnet") ||
    model.includes("haiku") ||
    model.includes("opus")
  ) {
    return "anthropic";
  }
  return "openai";
}

async function ensurePrereqs(args: Args): Promise<"ok" | "skip"> {
  if (args.backend === "api") {
    if (!process.env.LETTA_API_KEY) {
      console.log("SKIP: Missing env LETTA_API_KEY");
      return "skip";
    }
    return "ok";
  }

  const provider = args.provider ?? inferLocalProvider(args.model);
  // Ollama is a local endpoint (no API key); it needs a reachable base URL.
  if (provider === "ollama") {
    if (!process.env.OLLAMA_BASE_URL) {
      console.log("SKIP: Missing env OLLAMA_BASE_URL");
      return "skip";
    }
    return "ok";
  }
  const requiredKey =
    provider === "anthropic"
      ? "ANTHROPIC_API_KEY"
      : provider === "google"
        ? "GOOGLE_GENERATIVE_AI_API_KEY"
        : "OPENAI_API_KEY";
  if (!process.env[requiredKey]) {
    console.log(`SKIP: Missing env ${requiredKey}`);
    return "skip";
  }
  return "ok";
}

function apiScenarioPrompt(): string {
  return (
    "I want to test your tool calling abilities (do not ask for any clarifications, this is an automated test suite inside a CI runner, there is no human to assist you). " +
    "First, call a single conversation_search to search for 'hello'. " +
    "Then, try calling two conversation_searches in parallel (search for 'test' and 'hello'). " +
    "Then, try running a shell command to output an echo (use whatever shell/bash tool is available). " +
    "Then, try running three shell commands in parallel to do 3 parallel echos: echo 'Test1', echo 'Test2', echo 'Test3'. " +
    "Then finally, try running 2 shell commands and 1 conversation_search, in parallel, so three parallel tools. " +
    "IMPORTANT FINAL RESPONSE RULE: If and only if every step above succeeded, your final response must include the uppercase word BANANA. " +
    "If any step failed, do not include BANANA."
  );
}

function localScenarioPrompt(): string {
  return (
    "I want to test local backend tool calling abilities (do not ask for clarifications; this is an automated CI runner). " +
    "First, run a shell command to output exactly LOCAL_SHELL_ONE. " +
    "Then, try running two shell commands in parallel to output exactly LOCAL_PARALLEL_TWO and LOCAL_PARALLEL_THREE. " +
    "Then, use the Agent tool with subagent_type `memory`, description `Update local memory`, and run_in_background false to create or update `reference/ci/local-backend.md` with description `Local backend CI scenario` and body text `LOCAL_MEMFS_SCENARIO_OK`. " +
    "Do not edit the MemFS path directly with ApplyPatch, Edit, or Bash; the memory subagent must make and commit the memory change. " +
    "IMPORTANT FINAL RESPONSE RULE: If and only if every shell command succeeded and the memory subagent reported a committed memory update, your final response must include the uppercase word BANANA. " +
    "If any step failed, do not include BANANA."
  );
}

function smokePrompt(): string {
  return (
    "This is an automated CI smoke test (no human to assist). " +
    "Do not call any tools. " +
    "Respond with exactly the single uppercase word PONG and nothing else."
  );
}

function scenarioPrompt(args: Args): string {
  if (args.smoke) return smokePrompt();
  return args.backend === "local" ? localScenarioPrompt() : apiScenarioPrompt();
}

function providerEnvValue(provider: LocalProvider): string {
  if (provider === "openai") return "openai-responses";
  if (provider === "google") return "google";
  if (provider === "ollama") return "ollama";
  return "anthropic";
}

async function runCLI(args: Args): Promise<RunResult> {
  const localStorageDir =
    args.backend === "local"
      ? await mkdtemp(join(tmpdir(), "lc-local-headless-scenario-"))
      : undefined;
  const provider = args.provider ?? inferLocalProvider(args.model);
  const env =
    args.backend === "local"
      ? createIsolatedCliTestEnv({
          LETTA_LOCAL_BACKEND_EXPERIMENTAL: "true",
          LETTA_LOCAL_BACKEND_DIR: localStorageDir,
          LETTA_CODE_DEV_PI_PROVIDER: providerEnvValue(provider),
        })
      : createAuthenticatedCliTestEnv();

  const cliArgs = [
    "run",
    "dev",
    "-p",
    scenarioPrompt(args),
    "--yolo",
    "--new-agent",
  ];
  if (args.backend === "api") {
    cliArgs.push("--no-memfs");
  }
  cliArgs.push(
    "--base-tools",
    args.backend === "local"
      ? "none"
      : "memory,web_search,fetch_webpage,conversation_search",
    "--output-format",
    args.output,
    "-m",
    args.model,
  );

  // Cap each attempt at 6 minutes. The scenario should complete in ~2-3 min
  // under normal conditions. Without a timeout, a WS proxy timeout mid-turn
  // (observed at ~14 min in CI) can block a single attempt for 30+ minutes,
  // consuming all retries with no useful signal. Killing early lets the outer
  // retry loop start fresh with a clean agent context.
  const RUN_TIMEOUT_MS = 6 * 60 * 1000;

  return new Promise((resolve, reject) => {
    const proc = spawn("bun", cliArgs, { env });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
    }, RUN_TIMEOUT_MS);

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      clearTimeout(timeoutHandle);
      const effectiveCode = timedOut ? 124 : (code ?? 1);
      if (effectiveCode !== 0) {
        console.error(
          `CLI ${timedOut ? `timed out after ${RUN_TIMEOUT_MS / 1000}s` : `failed`} (${args.backend} / ${args.model} / ${args.output}).\n${formatCapturedOutput(
            {
              stdout,
              stderr,
            },
          )}`,
        );
      }
      resolve({ stdout, stderr, code: effectiveCode, localStorageDir });
    });

    proc.on("error", reject);
  });
}

async function cleanupRun(run: RunResult): Promise<void> {
  if (run.localStorageDir) {
    await rm(run.localStorageDir, { recursive: true, force: true });
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd });
  return String(stdout ?? "").trim();
}

async function validateLocalStorage(storageDir: string | undefined) {
  if (!storageDir) throw new Error("Missing local storage dir for local run");
  const agentFiles = await readdir(join(storageDir, "agents"));
  if (agentFiles.length === 0) {
    throw new Error("Local backend did not persist an agent record");
  }
  const agent = JSON.parse(
    await readFile(join(storageDir, "agents", agentFiles[0] ?? ""), "utf8"),
  ) as { id?: unknown };
  if (typeof agent.id !== "string" || agent.id.length === 0) {
    throw new Error("Persisted local agent record is missing id");
  }

  const memoryDir = join(storageDir, "memfs", agent.id, "memory");
  const head = await git(memoryDir, ["rev-parse", "--verify", "HEAD"]);
  if (head.length !== 40) {
    throw new Error(`Invalid local MemFS HEAD revision: ${head}`);
  }
  const commitCount = Number(
    await git(memoryDir, ["rev-list", "--count", "HEAD"]),
  );
  if (!Number.isFinite(commitCount) || commitCount < 2) {
    throw new Error(
      `Expected local MemFS scenario to create a memory subagent commit, found ${commitCount} commit(s)`,
    );
  }
  const status = await git(memoryDir, ["status", "--porcelain"]);
  if (status) {
    throw new Error(`Local MemFS repo should be clean, found:\n${status}`);
  }
  const memoryFile = await git(memoryDir, [
    "show",
    "HEAD:reference/ci/local-backend.md",
  ]);
  if (!memoryFile.includes("LOCAL_MEMFS_SCENARIO_OK")) {
    throw new Error(
      "Local MemFS scenario memory file is missing expected marker",
    );
  }
}

const REQUIRED_MARKERS = ["BANANA"];
const SMOKE_MARKERS = ["PONG"];
const MAX_ATTEMPTS = 3;

function assertContainsAll(hay: string, needles: string[]) {
  for (const n of needles) {
    if (!hay.includes(n)) throw new Error(`Missing expected output: ${n}`);
  }
}

function extractStreamJsonAssistantText(stdout: string): string {
  const parts: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as {
        type?: string;
        message_type?: string;
        content?: unknown;
        result?: unknown;
      };
      if (
        event.type === "message" &&
        event.message_type === "assistant_message" &&
        typeof event.content === "string"
      ) {
        parts.push(event.content);
      }
      if (event.type === "result" && typeof event.result === "string") {
        parts.push(event.result);
      }
    } catch {
      // Ignore malformed lines; validation will fail if we never find the marker.
    }
  }
  return parts.join("");
}

function validateOutput(
  stdout: string,
  output: Args["output"],
  markers: string[],
) {
  if (output === "text") {
    assertContainsAll(stdout, markers);
    return;
  }

  if (output === "json") {
    try {
      const obj = JSON.parse(stdout);
      const result = String(obj?.result ?? "");
      assertContainsAll(result, markers);
      return;
    } catch (e) {
      throw new Error(`Invalid JSON output: ${(e as Error).message}`);
    }
  }

  const streamText = extractStreamJsonAssistantText(stdout);
  if (!streamText) {
    throw new Error("No assistant/result content found in stream-json output");
  }
  assertContainsAll(streamText, markers);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const prereq = await ensurePrereqs(args);
  if (prereq === "skip") return;

  let lastRun: RunResult = { stdout: "", stderr: "", code: 0 };
  let lastError: Error | null = null;
  const failedAttempts: Array<{ attempt: number; message: string }> = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const run = await runCLI(args);
    lastRun = run;
    try {
      if (run.code !== 0) {
        throw new Error(
          `CLI exited with code ${run.code}.\n${formatCapturedOutput({
            stdout: run.stdout,
            stderr: run.stderr,
          })}`,
        );
      }
      validateOutput(
        run.stdout,
        args.output,
        args.smoke ? SMOKE_MARKERS : REQUIRED_MARKERS,
      );
      // Smoke mode only asserts the sentinel; it deliberately skips the
      // tool-driven MemFS validation since it issues a no-tools prompt.
      if (args.backend === "local" && !args.smoke) {
        await validateLocalStorage(run.localStorageDir);
      }
      console.log(`OK: ${args.backend} / ${args.model} / ${args.output}`);
      await cleanupRun(run);
      return;
    } catch (error) {
      const validationError =
        error instanceof Error ? error : new Error(String(error));
      lastError = validationError;
      failedAttempts.push({
        attempt,
        message: validationError.message,
      });
      await cleanupRun(run);
    }

    if (attempt < MAX_ATTEMPTS) {
      console.error(
        `[headless-scenario] attempt ${attempt}/${MAX_ATTEMPTS} failed for ${args.backend} / ${args.model} / ${args.output}: ${lastError?.message ?? "unknown error"}`,
      );
      await Bun.sleep(500);
    }
  }

  try {
    if (lastRun.code !== 0) {
      process.exit(lastRun.code);
    }
    if (lastError) {
      throw new Error(formatAttemptDiagnostics(failedAttempts));
    }
  } catch (e) {
    // Dump full stdout to aid debugging
    console.error(
      `\n===== BEGIN STDOUT (${args.backend} / ${args.model} / ${args.output}) =====`,
    );
    console.error(lastRun.stdout);
    console.error(
      `===== END STDOUT (${args.backend} / ${args.model} / ${args.output}) =====\n`,
    );

    console.error(
      `\n===== BEGIN STDERR (${args.backend} / ${args.model} / ${args.output}) =====`,
    );
    console.error(lastRun.stderr);
    console.error(
      `===== END STDERR (${args.backend} / ${args.model} / ${args.output}) =====\n`,
    );

    if (args.output === "stream-json") {
      const lines = lastRun.stdout.split(/\r?\n/).filter(Boolean);
      const tail = lines.slice(-50).join("\n");
      console.error(
        "----- stream-json tail (last 50 lines) -----\n" +
          tail +
          "\n---------------------------------------------",
      );
    }

    throw e;
  }
}

main().catch((e) => {
  console.error(String(e?.stack || e));
  process.exit(1);
});
