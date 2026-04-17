#!/usr/bin/env bun
/**
 * Headless scenario test runner
 *
 * Runs a single multi-step scenario against the LeTTA Code CLI (headless) for a given
 * model and output format. Intended for CI matrix usage.
 *
 * Usage:
 *   bun tsx src/tests/headless-scenario.ts --model gpt-4.1 --output stream-json --parallel on
 */

import { spawn } from "node:child_process";
import { createIsolatedCliTestEnv } from "./testProcessEnv";

type Args = {
  model: string;
  output: "text" | "json" | "stream-json";
  parallel: "on" | "off" | "hybrid";
};

function parseArgs(argv: string[]): Args {
  const args: {
    model?: string;
    output: Args["output"];
    parallel: Args["parallel"];
  } = {
    output: "text",
    parallel: "on",
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--model") args.model = argv[++i];
    else if (v === "--output") args.output = argv[++i] as Args["output"];
    else if (v === "--parallel") args.parallel = argv[++i] as Args["parallel"];
  }
  if (!args.model) throw new Error("Missing --model");
  if (!["text", "json", "stream-json"].includes(args.output))
    throw new Error(`Invalid --output ${args.output}`);
  if (!["on", "off", "hybrid"].includes(args.parallel))
    throw new Error(`Invalid --parallel ${args.parallel}`);
  return args as Args;
}

// Tests run against Letta Cloud; only LETTA_API_KEY is required.
async function ensurePrereqs(_model: string): Promise<"ok" | "skip"> {
  if (!process.env.LETTA_API_KEY) {
    console.log("SKIP: Missing env LETTA_API_KEY");
    return "skip";
  }
  return "ok";
}

function scenarioPrompt(): string {
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

async function runCLI(
  model: string,
  output: Args["output"],
): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "bun",
      [
        "run",
        "dev",
        "-p",
        scenarioPrompt(),
        "--yolo",
        "--new-agent",
        "--no-memfs",
        "--base-tools",
        "memory,web_search,fetch_webpage,conversation_search",
        "--output-format",
        output,
        "-m",
        model,
      ],
      {
        env: createIsolatedCliTestEnv(),
      },
    );

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        console.error("CLI failed:", stderr || stdout);
      }
      resolve({ stdout, code: code ?? 1 });
    });

    proc.on("error", reject);
  });
}

const REQUIRED_MARKERS = ["BANANA"];
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

function validateOutput(stdout: string, output: Args["output"]) {
  if (output === "text") {
    assertContainsAll(stdout, REQUIRED_MARKERS);
    return;
  }

  if (output === "json") {
    try {
      const obj = JSON.parse(stdout);
      const result = String(obj?.result ?? "");
      assertContainsAll(result, REQUIRED_MARKERS);
      return;
    } catch (e) {
      throw new Error(`Invalid JSON output: ${(e as Error).message}`);
    }
  }

  const streamText = extractStreamJsonAssistantText(stdout);
  if (!streamText) {
    throw new Error("No assistant/result content found in stream-json output");
  }
  assertContainsAll(streamText, REQUIRED_MARKERS);
}

async function main() {
  const { model, output } = parseArgs(process.argv.slice(2));
  const prereq = await ensurePrereqs(model);
  if (prereq === "skip") return;

  let stdout = "";
  let code = 0;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    ({ stdout, code } = await runCLI(model, output));
    if (code !== 0) {
      lastError = new Error(`CLI exited with code ${code}`);
    } else {
      try {
        validateOutput(stdout, output);
        console.log(`OK: ${model} / ${output}`);
        return;
      } catch (error) {
        lastError = error as Error;
      }
    }

    if (attempt < MAX_ATTEMPTS) {
      console.error(
        `[headless-scenario] attempt ${attempt}/${MAX_ATTEMPTS} failed for ${model} / ${output}: ${lastError?.message ?? "unknown error"}`,
      );
      await Bun.sleep(500);
    }
  }

  try {
    if (code !== 0) {
      process.exit(code);
    }
    if (lastError) {
      throw lastError;
    }
  } catch (e) {
    // Dump full stdout to aid debugging
    console.error(`\n===== BEGIN STDOUT (${model} / ${output}) =====`);
    console.error(stdout);
    console.error(`===== END STDOUT (${model} / ${output}) =====\n`);

    if (output === "stream-json") {
      const lines = stdout.split(/\r?\n/).filter(Boolean);
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
