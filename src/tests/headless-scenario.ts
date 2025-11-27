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
    "First, call a single web_search to get the weather in SF. " +
    "Then, try calling two web_searches in parallel. " +
    "Then, try running a shell command to output an echo (use whatever shell/bash tool is available). " +
    "Then, try running three shell commands in parallel to do 3 parallel echos: echo 'Test1', echo 'Test2', echo 'Test3'. " +
    "Then finally, try running 2 shell commands and 1 web_search, in parallel, so three parallel tools. " +
    "IMPORTANT: If and only if all of the above steps worked as requested, include the word BANANA (uppercase) somewhere in your final response."
  );
}

async function runCLI(
  model: string,
  output: Args["output"],
): Promise<{ stdout: string; code: number }> {
  const cmd = [
    "bun",
    "run",
    "dev",
    "-p",
    scenarioPrompt(),
    "--yolo",
    "--new",
    "--output-format",
    output,
    "-m",
    model,
  ];
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) {
    console.error("CLI failed:", err || out);
  }
  return { stdout: out, code };
}

function assertContainsAll(hay: string, needles: string[]) {
  for (const n of needles) {
    if (!hay.includes(n)) throw new Error(`Missing expected output: ${n}`);
  }
}

async function main() {
  const { model, output } = parseArgs(process.argv.slice(2));
  const prereq = await ensurePrereqs(model);
  if (prereq === "skip") return;

  const { stdout, code } = await runCLI(model, output);
  if (code !== 0) {
    process.exit(code);
  }

  try {
    // Validate by output mode
    if (output === "text") {
      assertContainsAll(stdout, ["BANANA"]);
    } else if (output === "json") {
      try {
        const obj = JSON.parse(stdout);
        const result = String(obj?.result ?? "");
        assertContainsAll(result, ["BANANA"]);
      } catch (e) {
        throw new Error(`Invalid JSON output: ${(e as Error).message}`);
      }
    } else if (output === "stream-json") {
      // stream-json prints one JSON object per line; find the final result event
      const lines = stdout.split(/\r?\n/).filter(Boolean);
      const resultLine = lines.find((l) => {
        try {
          const o = JSON.parse(l);
          return o?.type === "result";
        } catch {
          return false;
        }
      });
      if (!resultLine) throw new Error("No final result event in stream-json");
      const evt = JSON.parse(resultLine);
      const result = String(evt?.result ?? "");
      assertContainsAll(result, ["BANANA"]);
    }

    console.log(`OK: ${model} / ${output}`);
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
