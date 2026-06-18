const LEARN_MODE_FLAG = "LETTA_CODE_LEARN_MODE";
const LEARN_TARGET_AGENT_FLAG = "LETTA_CODE_LEARN_TARGET_AGENT";
const LEARN_TARGET_NAME_FLAG = "LETTA_CODE_LEARN_TARGET_NAME";
const LEARN_REQUEST_FLAG = "LETTA_CODE_LEARN_REQUEST";

export interface LearnStartupNormalization {
  args: string[];
  env: Record<string, string>;
  helpText?: string;
}

function readValue(
  argv: string[],
  index: number,
  optionName: string,
): { nextIndex: number; value: string } {
  const arg = argv[index] ?? "";
  const equalsPrefix = `${optionName}=`;
  if (arg.startsWith(equalsPrefix)) {
    const value = arg.slice(equalsPrefix.length);
    if (!value) throw new Error(`${optionName} requires a value`);
    return { nextIndex: index, value };
  }

  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${optionName} requires a value`);
  }
  return { nextIndex: index + 1, value };
}

const PASSTHROUGH_OPTIONS_WITH_VALUES = new Set([
  "--allowedTools",
  "--base-tools",
  "--conversation",
  "--disallowedTools",
  "--embedding",
  "--input-format",
  "--memfs-startup",
  "--model",
  "--output-format",
  "--permission-mode",
  "--pre-load-skills",
  "--skill-sources",
  "--skills",
  "--system",
  "--system-custom",
  "--tools",
  "--toolset",
]);

function looksLikeAgentId(value: string): boolean {
  return value.startsWith("agent-") || value.startsWith("agent_");
}

export function formatLearnUsage(error?: string): string {
  return [
    ...(error ? [`Error: ${error}`, ""] : []),
    "Usage:",
    "  letta learn [agent-id|agent-name] [options]",
    "",
    "Creates a fresh MetaAgent session for improving another Letta Code agent.",
    "The MetaAgent can inspect target memory/traces, propose adaptations, and run mod learning workflows.",
    "",
    "Learn options:",
    "  --target-agent <id>       Target agent ID to optimize",
    "  --target-name <name>      Target agent name to optimize",
    "  --agent <id>              Alias for --target-agent inside `letta learn`",
    "  --name <name>             Alias for --target-name inside `letta learn`",
    "  --request <text>          Specific improvement/adaptation request",
    "  --improvement <text>      Alias for --request",
    "",
    "Common Letta options such as --model, --backend, --toolset, and --permission-mode are forwarded to the MetaAgent session.",
    "",
    "Examples:",
    "  letta learn",
    "  letta learn agent-abc123 --request 'stop looping on failed CI checks'",
    "  letta learn --name Bob --model gpt-5.5",
  ].join("\n");
}

export function normalizeLearnStartupArgs(
  argv: string[],
): LearnStartupNormalization | null {
  const [command, ...rest] = argv;
  if (command !== "learn") return null;

  const forwardedArgs: string[] = [
    "--new-agent",
    "--personality",
    "meta",
    "--new",
  ];
  const env: Record<string, string> = {
    [LEARN_MODE_FLAG]: "1",
  };
  let positionalTarget: string | null = null;

  try {
    for (let index = 0; index < rest.length; index += 1) {
      const arg = rest[index] ?? "";
      if (arg === "--help" || arg === "-h" || arg === "help") {
        return { args: [], env: {}, helpText: formatLearnUsage() };
      }

      if (arg === "--target-agent" || arg === "--agent") {
        const { nextIndex, value } = readValue(rest, index, arg);
        env[LEARN_TARGET_AGENT_FLAG] = value;
        index = nextIndex;
        continue;
      }

      if (arg === "--target-name" || arg === "--name") {
        const { nextIndex, value } = readValue(rest, index, arg);
        env[LEARN_TARGET_NAME_FLAG] = value;
        index = nextIndex;
        continue;
      }

      if (arg === "--request" || arg === "--improvement") {
        const { nextIndex, value } = readValue(rest, index, arg);
        env[LEARN_REQUEST_FLAG] = value;
        index = nextIndex;
        continue;
      }

      if (arg.startsWith("--target-agent=")) {
        env[LEARN_TARGET_AGENT_FLAG] = arg.slice("--target-agent=".length);
        continue;
      }

      if (arg.startsWith("--agent=")) {
        env[LEARN_TARGET_AGENT_FLAG] = arg.slice("--agent=".length);
        continue;
      }

      if (arg.startsWith("--target-name=")) {
        env[LEARN_TARGET_NAME_FLAG] = arg.slice("--target-name=".length);
        continue;
      }

      if (arg.startsWith("--name=")) {
        env[LEARN_TARGET_NAME_FLAG] = arg.slice("--name=".length);
        continue;
      }

      if (arg.startsWith("--request=")) {
        env[LEARN_REQUEST_FLAG] = arg.slice("--request=".length);
        continue;
      }

      if (arg.startsWith("--improvement=")) {
        env[LEARN_REQUEST_FLAG] = arg.slice("--improvement=".length);
        continue;
      }

      if (arg.startsWith("--")) {
        forwardedArgs.push(arg);
        const optionName = arg.includes("=")
          ? arg.slice(0, arg.indexOf("="))
          : arg;
        if (
          PASSTHROUGH_OPTIONS_WITH_VALUES.has(optionName) &&
          !arg.includes("=")
        ) {
          const value = rest[index + 1];
          if (!value || value.startsWith("--")) {
            throw new Error(`${optionName} requires a value`);
          }
          forwardedArgs.push(value);
          index += 1;
        }
        continue;
      }

      if (positionalTarget) {
        throw new Error(`Unexpected argument: ${arg}`);
      }
      positionalTarget = arg;
    }
  } catch (error) {
    return {
      args: [],
      env: {},
      helpText: formatLearnUsage(
        error instanceof Error ? error.message : String(error),
      ),
    };
  }

  if (positionalTarget) {
    if (looksLikeAgentId(positionalTarget)) {
      env[LEARN_TARGET_AGENT_FLAG] = positionalTarget;
    } else {
      env[LEARN_TARGET_NAME_FLAG] = positionalTarget;
    }
  }

  return { args: forwardedArgs, env };
}

export function buildLearnModeReminderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (env[LEARN_MODE_FLAG] !== "1") return null;

  const targetAgent = env[LEARN_TARGET_AGENT_FLAG];
  const targetName = env[LEARN_TARGET_NAME_FLAG];
  const request = env[LEARN_REQUEST_FLAG];
  const targetLine = targetAgent
    ? `Target agent id: ${targetAgent}`
    : targetName
      ? `Target agent name: ${targetName}`
      : "No target agent was supplied. Ask the user to select one before doing optimization work.";
  const requestLine = request
    ? `Requested improvement/adaptation: ${request}`
    : "No specific improvement was supplied. Offer the user the choice between describing one and asking you to propose improvements from evidence.";

  return `<system-reminder>\nYou were launched via \`letta learn\`. This is a MetaAgent learning session for improving another Letta Code agent.\n\n${targetLine}\n${requestLine}\n\nWorkflow reminder:\n1. Identify or confirm exactly one target agent.\n2. Ask whether the user wants a specific improvement applied or wants you to propose about five improvements from traces/memory/evidence.\n3. When mod optimization is appropriate, use the existing mod-learning path: /mods learn in the TUI, or \`bun scripts/mod-learning/learn-mod.ts ...\` from shell when you need to run it yourself. Surface run directories, reports, HTML reports, and conversation links.\n</system-reminder>`;
}
