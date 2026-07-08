import { parseArgs } from "node:util";
import {
  DEFAULT_BATCH_TOKEN_BUDGET,
  DEFAULT_MAX_SESSIONS_PER_BATCH,
} from "@/cli/subcommands/dream-pipeline/batching";
import {
  type DreamPipelineResult,
  runDreamPipeline,
} from "@/cli/subcommands/dream-pipeline/run";
import {
  type DreamSourceSpec,
  parseDreamSourceSpec,
} from "@/cli/subcommands/dream-pipeline/select";
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
  --from <source>             What to reflect on. Repeatable. Each value is:
                                <conv-id>            one of the agent's own
                                                     conversations (default:
                                                     the primary "default"
                                                     history)
                                <harness>            every recorded session in
                                                     that harness's local store
                                                     (claude, codex)
                                <harness>:<session>  that session onwards
                                                     (claude, codex), or the
                                                     exact sessions the path
                                                     names (openhands:<dir>,
                                                     transcript:<file|dir>)
                                letta[:<locator>]    a letta conversation's
                                                     recorded transcript:
                                                     <conv-id>, <agent-id>
                                                     (its default history), or
                                                     <agent-id>/<conv-id>;
                                                     bare letta = this agent's
                                                     default history
                              Typed sources run the batch pipeline: sessions
                              are normalized, packed into time-ordered batches,
                              reflected on in parallel, and merged into memory
                              by an aggregation pass.
  --to <path>                 Maintain a doc (e.g. ./AGENTS.md) from memory;
                              the agent edits it in place, using judgment
  --plan                      With typed sources: show the selected sessions
                              and batch plan, then exit without reflecting
  --viz <run-id|latest|path>  Regenerate viz.html for a recorded dream run and
                              exit (each run also writes one automatically)
  --aggregate <run-id|latest> Re-run ONLY the aggregation pass of a recorded
                              dream run, using its existing batch outputs
  --budget <tokens>           Per-batch token budget (default ${DEFAULT_BATCH_TOKEN_BUDGET})
  --max-sessions <n>          Max sessions per batch (default ${DEFAULT_MAX_SESSIONS_PER_BATCH})
  --concurrency <n>           Cap concurrent batch reflections (default: every
                              batch runs its own reflection agent at once)
  --force                     Ignore the ingest ledger and re-reflect sessions
                              that were already dreamed on
  --effort <level>            Reflection effort (reserved; not yet implemented)
  --timeout <seconds>         Fail if the run has not completed in this many
                              seconds (default: 1500)
  -i, --instruction <text>    Additional instruction for the reflection pass
  --json                      Emit machine-readable JSON output
  -h, --help                  Show this help

Notes:
  - Requires the memory filesystem to be enabled for the agent.
  - Conversation reflection processes transcript content recorded since the
    last successful reflection; typed sources skip sessions already recorded
    in the ingest ledger (re-process with --force). Either way, exits 0 with
    no action when nothing is new.
`.trim(),
  );
}

const DREAM_OPTIONS = {
  help: { type: "boolean", short: "h" },
  memory: { type: "string" },
  from: { type: "string", multiple: true },
  to: { type: "string" },
  plan: { type: "boolean" },
  viz: { type: "string" },
  aggregate: { type: "string" },
  budget: { type: "string" },
  "max-sessions": { type: "string" },
  concurrency: { type: "string" },
  force: { type: "boolean" },
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

function parsePositiveInt(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid --${name} "${value}": must be a positive integer`);
  }
  return parsed;
}

async function runPipelineDream(params: {
  agentId: string;
  specs: DreamSourceSpec[];
  values: ReturnType<typeof parseDreamArgs>["values"];
  target?: DreamTarget;
  timeoutSeconds: number;
  asJson: boolean;
}): Promise<number> {
  const { agentId, specs, values, target, timeoutSeconds, asJson } = params;

  let budget: number;
  let maxSessions: number;
  let concurrency: number | undefined;
  try {
    budget = parsePositiveInt(
      values.budget,
      DEFAULT_BATCH_TOKEN_BUDGET,
      "budget",
    );
    maxSessions = parsePositiveInt(
      values["max-sessions"],
      DEFAULT_MAX_SESSIONS_PER_BATCH,
      "max-sessions",
    );
    // No --concurrency → every batch gets its own concurrent reflection agent.
    concurrency =
      values.concurrency !== undefined
        ? parsePositiveInt(values.concurrency, 1, "concurrency")
        : undefined;
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  // Sync the --to doc into the memfs first so the aggregator's worktree clone
  // starts from the current shared state; its upkeep directive rides on the
  // aggregation instruction since the aggregator owns the final memory state.
  let aggregationInstruction: string | undefined;
  if (target && !values.plan) {
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
    aggregationInstruction = buildTargetInstruction(target);
  }

  const log = asJson ? () => {} : (line: string) => console.log(line);
  const pipelinePromise = runDreamPipeline({
    agentId,
    conversationId: "default",
    specs,
    instruction: values.instruction,
    aggregationInstruction,
    planOnly: Boolean(values.plan),
    force: Boolean(values.force),
    batchTokenBudget: budget,
    maxSessionsPerBatch: maxSessions,
    concurrency,
    recompileByConversation: new Map(),
    recompileQueuedByConversation: new Set(),
    log,
  });

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
    timeoutHandle = setTimeout(
      () => resolve({ kind: "timeout" }),
      timeoutSeconds * 1000,
    );
  });
  const result: DreamPipelineResult | { kind: "timeout" } = await Promise.race([
    pipelinePromise,
    timeout,
  ]);
  if (timeoutHandle !== undefined) {
    clearTimeout(timeoutHandle);
  }

  switch (result.kind) {
    case "timeout": {
      const message = `Dream run did not complete within ${timeoutSeconds}s; batch agents may still be running.`;
      if (asJson) {
        emitJson({
          launched: true,
          success: false,
          timedOut: true,
          agentId,
          message,
        });
      } else {
        console.error(message);
      }
      return 1;
    }
    case "nothing_new": {
      if (asJson) {
        emitJson({
          launched: false,
          reason: "no_new_sessions",
          agentId,
          skippedByLedger: result.skippedByLedger,
        });
      } else {
        console.log(
          result.skippedByLedger > 0
            ? `No new sessions to dream on (${result.skippedByLedger} already reflected; use --force to re-process).`
            : "No sessions found for the given sources.",
        );
      }
      return 0;
    }
    case "already_active": {
      if (asJson) {
        emitJson({ launched: false, reason: "already_active", agentId });
      } else {
        console.error("A reflection pass is already running for this agent.");
      }
      return 1;
    }
    case "plan": {
      if (asJson) {
        emitJson({
          plan: true,
          agentId,
          sessionCount: result.sessions.length,
          skippedByLedger: result.skippedByLedger,
          batches: result.batches.map((batch) => ({
            index: batch.index,
            estTokens: batch.estTokens,
            startTime: batch.startTime,
            endTime: batch.endTime,
            sessions: batch.sessions.map((s) => ({
              harness: s.harness,
              sessionId: s.sessionId,
              estTokens: s.estTokens,
            })),
          })),
        });
        return 0;
      }
      console.log(
        `Would reflect on ${result.sessions.length} session(s) in ${result.batches.length} batch(es)` +
          (result.skippedByLedger > 0
            ? ` (${result.skippedByLedger} skipped: already reflected)`
            : "") +
          ":",
      );
      for (const batch of result.batches) {
        console.log(
          `  batch ${batch.index}: ${batch.sessions.length} session(s), ~${batch.estTokens} tokens, ${batch.startTime} → ${batch.endTime}`,
        );
        for (const session of batch.sessions) {
          console.log(
            `    - ${session.harness}:${session.sessionId} (~${session.estTokens} tokens)`,
          );
        }
      }
      return 0;
    }
    case "completed": {
      let targetWritten = false;
      let targetError: string | undefined;
      if (target && result.success) {
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
          success: result.success && !targetError,
          message: result.message,
          agentId,
          runId: result.runId,
          runRoot: result.runRoot,
          sessionCount: result.sessionCount,
          skippedByLedger: result.skippedByLedger,
          batches: result.batches.map((batch) => ({
            index: batch.batchIndex,
            success: batch.success,
            commitCount: batch.commitCount,
            ...(batch.error ? { error: batch.error } : {}),
          })),
          ...(result.vizPath ? { vizPath: result.vizPath } : {}),
          ...(target ? { targetPath: target.path, targetWritten } : {}),
          ...(targetError ? { targetError } : {}),
        });
      } else {
        if (result.success) {
          console.log(result.message);
        } else {
          console.error(result.message);
        }
        if (result.vizPath) {
          console.log(`Viz: ${result.vizPath}`);
        }
        if (targetWritten) {
          console.log(`Wrote ${target?.path}`);
        }
        if (targetError) {
          console.error(`Failed to write --to target: ${targetError}`);
        }
      }
      return result.success && !targetError ? 0 : 1;
    }
  }
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

  // Classify each --from value: a typed harness source (batch pipeline) or a
  // bare conversation id (the agent's own history — single reflection pass).
  const specs: DreamSourceSpec[] = [];
  const conversationIds: string[] = [];
  for (const value of parsed.values.from ?? []) {
    let spec: DreamSourceSpec | null;
    try {
      spec = parseDreamSourceSpec(value);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      return 1;
    }
    if (spec) {
      specs.push(spec);
    } else {
      conversationIds.push(value);
    }
  }
  if (specs.length > 0 && conversationIds.length > 0) {
    console.error(
      "Error: cannot mix harness sources and conversation ids in one dream run.",
    );
    return 1;
  }
  if (conversationIds.length > 1) {
    console.error(
      "Error: at most one conversation id can be reflected on per run.",
    );
    return 1;
  }
  if (specs.length === 0 && parsed.values.plan) {
    console.error("Error: --plan requires at least one typed --from source.");
    return 1;
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

  if (parsed.values.aggregate) {
    try {
      const { resolveDreamRunRoot } = await import(
        "@/cli/subcommands/dream-pipeline/viz"
      );
      const { rerunDreamAggregationForRun } = await import(
        "@/cli/subcommands/dream-pipeline/run"
      );
      const runRoot = resolveDreamRunRoot(agentId, parsed.values.aggregate);
      const log = asJson ? () => {} : (line: string) => console.log(line);
      const result = await rerunDreamAggregationForRun({
        agentId,
        conversationId: "default",
        runRoot,
        instruction: parsed.values.instruction,
        recompileByConversation: new Map(),
        recompileQueuedByConversation: new Set(),
        log,
      });
      if ("kind" in result) {
        console.error("A reflection pass is already running for this agent.");
        return 1;
      }
      if (asJson) {
        emitJson({
          aggregate: true,
          agentId,
          runRoot: result.runRoot,
          success: result.success,
          message: result.message,
          ...(result.vizPath ? { vizPath: result.vizPath } : {}),
        });
      } else {
        if (result.success) {
          console.log(result.message);
        } else {
          console.error(result.message);
        }
        if (result.vizPath) {
          console.log(`Viz: ${result.vizPath}`);
        }
      }
      return result.success ? 0 : 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      return 1;
    }
  }

  if (parsed.values.viz) {
    try {
      const { writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const { generateDreamViz, resolveDreamRunRoot } = await import(
        "@/cli/subcommands/dream-pipeline/viz"
      );
      const runRoot = resolveDreamRunRoot(agentId, parsed.values.viz);
      const { html, agentCount } = generateDreamViz(runRoot);
      const vizPath = join(runRoot, "viz.html");
      await writeFile(vizPath, html, "utf-8");
      if (asJson) {
        emitJson({ viz: true, agentId, runRoot, vizPath, agentCount });
      } else {
        console.log(`Wrote ${vizPath} (${agentCount} agent(s))`);
      }
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      return 1;
    }
  }

  if (specs.length > 0) {
    return runPipelineDream({
      agentId,
      specs,
      values: parsed.values,
      target,
      timeoutSeconds,
      asJson,
    });
  }

  const conversationId = conversationIds[0] || "default";

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
