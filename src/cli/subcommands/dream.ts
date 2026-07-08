import { parseArgs } from "node:util";
import {
  type ParsedSource,
  parseFromSource,
  stageFromSource,
} from "@/cli/subcommands/dream-sources";
import {
  buildTargetInstruction,
  type DreamTarget,
  readExistingTarget,
  readTargetFromMemory,
  resolveDreamTarget,
  syncTargetIntoMemory,
  writeTarget,
} from "@/cli/subcommands/dream-targets";
import { settingsManager } from "@/settings-manager";

function printUsage(): void {
  console.log(
    `
Usage:
  letta dream [options]

Run a memory reflection pass for an agent and wait for it to finish.

Options:
  --memory <agent-id>         Agent whose memory to refine (default:
                              $LETTA_AGENT_ID, then the last-used agent)
  --from <conv-id|type:path>  What to reflect on: a conversation id (default:
                              the agent's primary "default" history), or an
                              external source, e.g. claude:<session|dir>,
                              codex:<session|dir>, openhands:<conversation-dir>,
                              or transcript:./rows.jsonl
  --to <path>                 Maintain a doc (e.g. ./AGENTS.md) from memory;
                              the agent edits it in place, using judgment
  --effort <level>            Reflection effort (reserved; not yet implemented)
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
  memory: { type: "string" },
  from: { type: "string" },
  to: { type: "string" },
  effort: { type: "string" },
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

  let target: DreamTarget | undefined;
  if (parsed.values.to) {
    try {
      target = resolveDreamTarget(parsed.values.to);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      return 1;
    }
  }

  // A typed --from (e.g. openhands:./events.json) is an external source; a bare
  // value is one of the agent's own conversations. Resolve the source now so an
  // unknown type errors early.
  let source: ParsedSource | null = null;
  if (parsed.values.from) {
    try {
      source = parseFromSource(parsed.values.from);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      return 1;
    }
  }

  // --effort is part of the interface but not yet wired up.
  if (!asJson && parsed.values.effort) {
    console.error(
      "Note: --effort is accepted but not yet implemented; ignoring.",
    );
  }

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
    parsed.values.memory ||
    process.env.LETTA_AGENT_ID ||
    settingsManager.getGlobalLastAgentId() ||
    "";
  if (!agentId) {
    console.error(
      "Missing agent id. Pass --memory <agent-id>, set LETTA_AGENT_ID, or run a session first.",
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

  // For an external source, stage its converted entries into a synthetic
  // conversation transcript and reflect on that; the post-reflection recompile
  // targets the agent's real "default" history (the synthetic conversation is
  // not a backend conversation). A bare --from reflects on that conversation.
  let conversationId: string;
  let stagedEntries: number | undefined;
  if (source) {
    try {
      const staged = await stageFromSource(agentId, source);
      conversationId = staged.conversationId;
      stagedEntries = staged.appended;
      if (!asJson) {
        console.log(
          `Staged ${staged.appended} transcript entries (${staged.skipped} already ingested).`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (asJson) {
        emitJson({ launched: false, reason: "source_error", error: message });
      } else {
        console.error(`Failed to stage --from source: ${message}`);
      }
      return 1;
    }
  } else {
    conversationId = parsed.values.from || "default";
  }

  // Approach A: fold the target-doc maintenance directive into the reflection
  // instruction so the single reflection pass also maintains the doc (in the
  // agent's system/ memory). Sync the doc into the memfs from the on-disk
  // target first (when the memfs has no copy or the target changed) so the
  // agent starts from the current shared state. We read the result back out of
  // the memfs afterwards.
  let instruction = parsed.values.instruction;
  if (target) {
    const existing = await readExistingTarget(target);
    try {
      await syncTargetIntoMemory(agentId, target, existing);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!asJson) {
        console.error(
          `Note: could not sync ${target.fileName} into memory (${message}); the reflection will create it.`,
        );
      }
    }
    const targetInstruction = buildTargetInstruction(target);
    instruction = instruction
      ? `${instruction}\n\n${targetInstruction}`
      : targetInstruction;
  }

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
    // External sources stage into a synthetic conversation that doesn't exist
    // in the backend; recompile the agent's real primary history instead.
    ...(source ? { completionConversationId: "default" } : {}),
    memfsEnabled: true,
    triggerSource: "manual",
    description: "Reflect on recent conversations",
    instruction,
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
      emitJson({
        launched: false,
        reason: result.reason,
        agentId,
        ...(stagedEntries !== undefined ? { stagedEntries } : {}),
      });
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

  // On success, copy the doc the reflection agent committed into memory out to
  // the target path. If the agent chose not to write it, leave the target
  // untouched.
  let targetWritten = false;
  let targetError: string | undefined;
  if (target && outcome.success) {
    try {
      const rendered = readTargetFromMemory(agentId, target);
      if (rendered !== null) {
        await writeTarget(target, rendered);
        targetWritten = true;
      }
    } catch (error) {
      targetError = error instanceof Error ? error.message : String(error);
    }
  }

  if (asJson) {
    emitJson({
      launched: true,
      success: outcome.success && !targetError,
      message: outcome.message,
      ...(outcome.error ? { error: outcome.error } : {}),
      ...(timedOut ? { timedOut: true } : {}),
      agentId,
      conversationId,
      transcriptPath: result.payloadPath,
      ...(stagedEntries !== undefined ? { stagedEntries } : {}),
      ...(target ? { targetPath: target.path, targetWritten } : {}),
      ...(targetError ? { targetError } : {}),
    });
  } else if (outcome.success) {
    console.log(outcome.message);
    if (targetWritten) {
      console.log(`Wrote ${target?.path}`);
    }
    if (targetError) {
      console.error(`Failed to write --to target: ${targetError}`);
    }
  } else {
    console.error(outcome.message);
  }

  return outcome.success && !targetError ? 0 : 1;
}
