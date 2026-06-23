import { debugLog, debugWarn } from "@/utils/debug";
import { buildReflectionAutoPayload } from "./reflection-transcript";

export const MEMORY_RECAP_DESCRIPTION =
  "Investigate memory failures and personalization opportunities";

/** Model route for the memory recap investigator subagent. */
export const MEMORY_RECAP_MODEL = "letta/auto";

export interface MemoryRecapPromptInput {
  instruction?: string;
}

export function buildMemoryRecapInvestigatorPrompt(
  input: MemoryRecapPromptInput = {},
): string {
  const lines: string[] = [
    "Investigate recent conversation candidates for memory failures, repeated user corrections, and personalization opportunities. This is an analysis-only pass: do not edit memory files and do not commit anything.",
    "",
    "Analyze conversation transcripts ONLY. Do not read, enumerate, or audit the memory filesystem (`$MEMORY_DIR`, `system/`, `reference/`, skills), and do not try to identify structural gaps in current memory — the primary agent owns the memory audit and already has the full memory in its context. Your job is to surface behavioral evidence from the transcripts: scan for user frustration, repetition, and corrections, then extract the underlying patterns of what the agent keeps forgetting or failing to apply.",
    "",
    'The candidate payload path is available as `$TRANSCRIPT_PATH`. Read it with Bash, e.g. `cat "$TRANSCRIPT_PATH"`. The payload contains summaries, descriptions, recency/reflection state, heuristic/search scores, and transcript paths when available.',
    "",
    "Use candidate metadata to triage. Read full transcript files only for high-signal candidates where summaries are insufficient or where you need evidence for a memory failure. Prefer durable behavior patterns over one-off task details.",
    "",
  ];

  if (input.instruction?.trim()) {
    lines.push(
      "Additional user-provided investigation focus:",
      input.instruction.trim(),
      "",
      "Use this to prioritize what you inspect, but still report any strong memory failure or personalization signal you find.",
      "",
    );
  }

  lines.push(
    "Return a report with: executive summary; memory failures (forgetting patterns, with frustration/correction evidence); repeated user preferences or corrections; agent end-goal hypotheses; recommended user questions; memory signals (durable patterns grounded in transcript evidence, no target tiers); uncertainties/skipped.",
  );

  return lines.join("\n");
}

export type MemoryRecapLaunchSkippedReason = "no_candidates" | "error";

export type MemoryRecapLaunchResult =
  | {
      launched: true;
      subagentId: string;
      candidatesPath: string;
      candidateCount: number;
    }
  | {
      launched: false;
      reason: MemoryRecapLaunchSkippedReason;
      error?: unknown;
    };

export interface MemoryRecapLaunchOptions {
  agentId: string;
  conversationId: string;
  description?: string;
  instruction?: string;
  maxCatalogCandidates?: number;
  onComplete?: (result: {
    success: boolean;
    error?: string;
    report?: string;
    recapAgentId?: string;
    candidatesPath?: string;
    candidateCount?: number;
  }) => void | Promise<void>;
}

/**
 * Launch an analysis-only recap investigator. It reuses the `/reflect --auto`
 * candidate builder so recap and reflection triage rank the same recent,
 * unreflected, and search-relevant conversations.
 */
export async function launchMemoryRecapInvestigatorSubagent(
  options: MemoryRecapLaunchOptions,
): Promise<MemoryRecapLaunchResult> {
  try {
    const autoPayload = await buildReflectionAutoPayload({
      agentId: options.agentId,
      currentConversationId: options.conversationId,
      instruction: options.instruction,
      maxCatalogCandidates: options.maxCatalogCandidates,
    });

    if (!autoPayload) {
      return { launched: false, reason: "no_candidates" };
    }

    const { spawnBackgroundSubagentTask } = await import("@/tools/impl/task");
    const description = options.description ?? MEMORY_RECAP_DESCRIPTION;
    const candidateCount = autoPayload.candidates.candidates.length;
    const { subagentId } = spawnBackgroundSubagentTask({
      subagentType: "memory-recap",
      prompt: buildMemoryRecapInvestigatorPrompt({
        instruction: options.instruction,
      }),
      description,
      model: MEMORY_RECAP_MODEL,
      // Non-silent: the completion notification carries the full report back
      // into the parent conversation and auto-dispatches a turn, so the primary
      // agent is woken to ask the user questions once findings are in. (Unlike
      // reflection, which is silent because it edits memory autonomously.)
      silentCompletion: false,
      completionSummary: ({ success }) =>
        success
          ? "Memory recap investigator finished — read its findings, then ask the user your checkup questions."
          : "Memory recap investigator failed — proceed with your own audit and ask the user your checkup questions.",
      transcriptPath: autoPayload.candidatesPath,
      parentScope: {
        agentId: options.agentId,
        conversationId: options.conversationId,
      },
      onComplete: async ({ success, error, report, agentId: recapAgentId }) => {
        await options.onComplete?.({
          success,
          error,
          report,
          recapAgentId: recapAgentId ?? undefined,
          candidatesPath: autoPayload.candidatesPath,
          candidateCount,
        });
      },
    });

    debugLog("memory", "Launched memory recap investigator subagent");
    return {
      launched: true,
      subagentId,
      candidatesPath: autoPayload.candidatesPath,
      candidateCount,
    };
  } catch (error) {
    debugWarn(
      "memory",
      `Failed to launch memory recap investigator subagent: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { launched: false, reason: "error", error };
  }
}
