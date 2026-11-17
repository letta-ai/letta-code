import { resolve } from "node:path";
import dreamPrompt from "@/cli/subcommands/dream/dream-prompt.md";
import dynamicDreamPrompt from "@/cli/subcommands/dream/dynamic-dream-prompt.md";

const DREAM_USAGE = `Usage: letta dream <trajectories-dir> [options]

Create a new agent and have it write its own memory from a directory of past
trajectories (for example, the output of \`letta trajectories export\`). The
agent shards the trajectories and runs one memory-writing worker per shard.
Other options are passed through to the headless run; choose the model and
reasoning effort with a catalog ID such as --model opus-5.5-1m-max.

  --dynamic            Give the agent only the goal and a budget, and let it
                       decide how to work (alone, or with its own Workflow).
  --budget-usd <n>     Spending limit in USD for --dynamic (required with it).`;

function usageError(message: string): never {
  console.error(`${message}\n\n${DREAM_USAGE}`);
  process.exit(1);
}

/**
 * Rewrites `letta dream <dir> [options]` into a headless run that creates a
 * new MemFS agent and sends it the dream prompt. Other argv is returned as is.
 */
export function expandDreamCommand(args: string[]): string[] {
  if (args[0] !== "dream") return args;
  const [dir, ...options] = args.slice(1);
  if (!dir || dir.startsWith("-")) {
    console.log(DREAM_USAGE);
    process.exit(dir === "-h" || dir === "--help" ? 0 : 1);
  }
  let dynamic = false;
  let budget: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < options.length; i++) {
    const arg = options[i] as string;
    if (arg === "--dynamic") dynamic = true;
    else if (arg === "--budget-usd") budget = options[++i] ?? "";
    else if (arg.startsWith("--budget-usd=")) budget = arg.slice(13);
    else rest.push(arg);
  }
  let prompt = dreamPrompt;
  if (dynamic) {
    const usd = Number(budget);
    if (budget === undefined || !Number.isFinite(usd) || usd <= 0) {
      usageError("--dynamic needs --budget-usd <positive number>.");
    }
    prompt = dynamicDreamPrompt.replaceAll("{{budget}}", String(usd));
  } else if (budget !== undefined) {
    usageError("--budget-usd only applies with --dynamic.");
  }
  return [
    "-p",
    prompt.replaceAll("{{corpus}}", resolve(dir)),
    "--new-agent",
    "--memfs",
    "--base-tools",
    "none",
    "--yolo",
    ...rest,
  ];
}
