import { parseArgs } from "node:util";
import { settingsManager } from "@/settings-manager";

function printUsage(): void {
  console.log(
    `
Usage:
  letta dream [options]

Run a memory reflection pass for an agent and wait for it to finish.

Options:
  --agent <id>                Agent id (default: $LETTA_AGENT_ID, then the
                              last-used agent for the current server)
  --conv <id>                 Conversation transcript to process
                              (default: "default")
  --timeout <seconds>         Fail if the reflection pass has not completed
                              in this many seconds (default: 1500)
  -i, --instruction <text>    Additional instruction for the reflection pass
  --json                      Emit machine-readable JSON output
  -h, --help                  Show this help

Notes:
  - Requires the memory filesystem to be enabled for the agent.
  - Processes conversation transcript content recorded since the last
    successful reflection; exits 0 with no action when nothing is new.
`.trim(),
  );
}

const DREAM_OPTIONS = {
  help: { type: "boolean", short: "h" },
  agent: { type: "string" },
  conv: { type: "string" },
  timeout: { type: "string" },
  instruction: { type: "string", short: "i" },
  json: { type: "boolean" },
} as const;

const DEFAULT_TIMEOUT_SECONDS = 1500;

function parseDreamArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    options: DREAM_OPTIONS,
    strict: true,
    allowPositionals: true,
  });
}

interface DreamCompletion {
  success: boolean;
  error?: string;
  message: string;
}

function emitJson(payload: Record<string, unknown>): void {
  console.log(JSON.stringify(payload));
}

export async function runDreamSubcommand(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseDreamArgs>;
  try {
    parsed = parseDreamArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    printUsage();
    return 1;
  }

  const [action] = parsed.positionals;
  if (parsed.values.help || action === "help") {
    printUsage();
    return 0;
  }
  if (action) {
    console.error(`Unknown argument: ${action}`);
    printUsage();
    return 1;
  }

  const asJson = Boolean(parsed.values.json);

  let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
  if (parsed.values.timeout) {
    timeoutSeconds = Number.parseInt(parsed.values.timeout, 10);
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
      console.error(`Error: Invalid --timeout "${parsed.values.timeout}"`);
      return 1;
    }
  }

  await settingsManager.initialize();

  const agentId =
    parsed.values.agent ||
    process.env.LETTA_AGENT_ID ||
    settingsManager.getGlobalLastAgentId() ||
    "";
  if (!agentId) {
    console.error(
      "Missing agent id. Pass --agent, set LETTA_AGENT_ID, or run a session first.",
    );
    return 1;
  }

  if (!settingsManager.isMemfsEnabled(agentId)) {
    if (asJson) {
      emitJson({ launched: false, reason: "memfs_disabled", agentId });
    } else {
      console.error(
        `Memory filesystem is not enabled for ${agentId}. Nothing to do.`,
      );
    }
    return 1;
  }

  const conversationId = parsed.values.conv || "default";

  const { launchReflectionSubagent } = await import(
    "@/cli/helpers/reflection-launcher"
  );

  let resolveCompletion!: (completion: DreamCompletion) => void;
  const completion = new Promise<DreamCompletion>((resolve) => {
    resolveCompletion = resolve;
  });

  const result = await launchReflectionSubagent({
    agentId,
    conversationId,
    memfsEnabled: true,
    triggerSource: "manual",
    description: "Reflect on recent conversations",
    instruction: parsed.values.instruction,
    recompileByConversation: new Map(),
    recompileQueuedByConversation: new Set(),
    onCompletionMessage: (message, completionResult) => {
      resolveCompletion({
        success: completionResult.success,
        error: completionResult.error,
        message,
      });
    },
    feedbackContext: {
      surface: "letta_code_cli",
    },
  });

  if (!result.launched) {
    if (asJson) {
      emitJson({ launched: false, reason: result.reason, agentId });
      return result.reason === "no_payload" ? 0 : 1;
    }
    switch (result.reason) {
      case "no_payload":
        console.log("No new transcript content to process.");
        return 0;
      case "already_active":
        console.error("A reflection pass is already running for this agent.");
        return 1;
      case "memfs_disabled":
        console.error(`Memory filesystem is not enabled for ${agentId}.`);
        return 1;
      default: {
        const message =
          result.error instanceof Error
            ? result.error.message
            : String(result.error ?? "Unknown error");
        console.error(`Failed to start reflection pass: ${message}`);
        return 1;
      }
    }
  }

  if (!asJson) {
    console.log(`Processing transcript: ${result.payloadPath}`);
  }

  // The completion promise resolves via onCompletionMessage. If the launcher's
  // onComplete path throws before reaching that callback (e.g. finalize or
  // recompile fails), the subagent task swallows the error and the callback
  // never fires — so cap the wait: an unattended invocation must always exit.
  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<DreamCompletion>((resolve) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      resolve({
        success: false,
        error: "timeout",
        message: `Reflection pass did not complete within ${timeoutSeconds}s.`,
      });
    }, timeoutSeconds * 1000);
  });
  const outcome = await Promise.race([completion, timeout]);
  if (timeoutHandle !== undefined) {
    clearTimeout(timeoutHandle);
  }

  if (asJson) {
    emitJson({
      launched: true,
      success: outcome.success,
      message: outcome.message,
      ...(outcome.error ? { error: outcome.error } : {}),
      ...(timedOut ? { timedOut: true } : {}),
      agentId,
      conversationId,
      transcriptPath: result.payloadPath,
    });
  } else if (outcome.success) {
    console.log(outcome.message);
  } else {
    console.error(outcome.message);
  }

  return outcome.success ? 0 : 1;
}
