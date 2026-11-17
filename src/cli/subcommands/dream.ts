import { resolve } from "node:path";
import dreamPrompt from "@/cli/subcommands/dream/dream-prompt.md";

const DREAM_USAGE = `Usage: letta dream <trajectories-dir> [options]

Create a new agent and have it write its own memory from a directory of past
trajectories (for example, the output of \`letta trajectories export\`). The
agent shards the trajectories and runs one memory-writing worker per shard.
Other options are passed through to the headless run; choose the model and
reasoning effort with a catalog ID such as --model opus-5.5-1m-max.

  --reasoning-effort <level>  Reasoning effort for the new agent, for models
                              whose catalog ID has no effort tier (for example
                              BYOK handles such as lc-openrouter/qwen/qwen4-max).`;

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
  const rest: string[] = [];
  for (let i = 0; i < options.length; i++) {
    const arg = options[i] as string;
    // Headless applies this to the agent it creates (getNewAgentUpdateArgs).
    if (arg === "--reasoning-effort")
      process.env.LETTA_DREAM_REASONING_EFFORT = options[++i] ?? "";
    else if (arg.startsWith("--reasoning-effort="))
      process.env.LETTA_DREAM_REASONING_EFFORT = arg.slice(19);
    else rest.push(arg);
  }
  const prompt = dreamPrompt.replaceAll("{{corpus}}", resolve(dir));
  return [
    "-p",
    prompt,
    "--new-agent",
    "--memfs",
    "--base-tools",
    "none",
    "--yolo",
    ...rest,
  ];
}
