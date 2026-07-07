import { execFile as execFileCb } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  buildReflectionMemoryScope,
  finalizeReflectionMemoryWorktree,
  type ReflectionMemoryWorktree,
  type ReflectionMemoryWorktreeFinalizeResult,
  reflectionIntegrationConsumesTranscript,
} from "@/agent/memory-worktree";
import { getBackend } from "@/backend";
import { buildAgentReference } from "@/cli/helpers/app-urls";
import {
  buildReflectionArenaHfChoiceRow,
  maybeUploadReflectionArenaChoiceToHf,
} from "@/cli/helpers/reflection-arena-hf-upload";
import {
  emitReflectionRunEnd,
  emitReflectionRunStart,
  finalizeReflectionMemoryWorktreeLaunch,
  prepareReflectionMemoryWorktreeLaunch,
  REFLECTION_AGENT_ID_WAIT_MS,
  type ReflectionFeedbackContext,
  type ReflectionLaunchTriggerSource,
  releaseReflectionLaunch,
  tryReserveReflectionLaunch,
} from "@/cli/helpers/reflection-launcher";
import {
  type AutoReflectionPayload,
  buildAutoReflectionPayload,
  finalizeAutoReflectionPayload,
} from "@/cli/helpers/reflection-transcript";
import { debugWarn } from "@/utils/debug";

const execFile = promisify(execFileCb);

export const REFLECTION_ARENA_MODEL_A_DEFAULT = "letta/auto-memory";

const ANSI_BOLD = "\u001b[1m";
const ANSI_CYAN = "\u001b[36m";
const ANSI_MAGENTA = "\u001b[35m";
const ANSI_RESET_BOLD = "\u001b[22m";
const ANSI_RESET_FOREGROUND = "\u001b[39m";
const REFLECTION_ARENA_CANDIDATE_COUNT = 2;

export type ReflectionArenaCandidateLabel = "1" | "2";
export type ReflectionArenaChoice = ReflectionArenaCandidateLabel | "tie";
export interface ReflectionArenaChoiceAnswer {
  choice: ReflectionArenaChoice;
  notes?: string;
}

export const REFLECTION_ARENA_CHOICE_QUESTION =
  "Which reflection should be merged?";
export const REFLECTION_ARENA_NOTES_QUESTION =
  "Optional feedback for this choice?";
export type ReflectionArenaRunStatus =
  | "running"
  | "awaiting_choice"
  | "completed"
  | "failed";

interface ReflectionArenaCandidateResult {
  agentId?: string;
  conversationId?: string;
  durationMs?: number;
  error?: string;
  report?: string;
  stepCount?: number;
  success: boolean;
}

interface ReflectionArenaCandidate {
  label: ReflectionArenaCandidateLabel;
  model: string;
  result?: ReflectionArenaCandidateResult;
  subagentId: string;
  worktree: ReflectionMemoryWorktree;
}

export interface ReflectionArenaRun {
  agentId: string;
  candidates: ReflectionArenaCandidate[];
  choice?: {
    chosen: ReflectionArenaChoice;
    discarded: ReflectionArenaCandidateLabel[];
    integration?: ReflectionMemoryWorktreeFinalizeResult;
    notes?: string;
    recordedAt: string;
  };
  completedAt?: string;
  conversationId: string;
  createdAt: string;
  endMessageId?: string;
  endSnapshotLine: number;
  payloadPath: string;
  runId: string;
  startMessageId?: string;
  status: ReflectionArenaRunStatus;
}

export interface StartReflectionArenaRunOptions {
  agentId: string;
  conversationId: string;
  feedbackContext?: ReflectionFeedbackContext;
  instruction?: string;
  models: [string, string];
  onReady: (message: string, run: ReflectionArenaRun) => void | Promise<void>;
  payload: AutoReflectionPayload;
  triggerSource: ReflectionLaunchTriggerSource;
}

export interface LaunchReflectionArenaOptions {
  agentId: string;
  conversationId: string;
  feedbackContext?: ReflectionFeedbackContext;
  instruction?: string;
  models: [string, string];
  onReady: (message: string, run: ReflectionArenaRun) => void | Promise<void>;
  triggerSource: ReflectionLaunchTriggerSource;
}

export type LaunchReflectionArenaResult =
  | { launched: true; payloadPath: string; run: ReflectionArenaRun }
  | { launched: false; reason: "no_payload" };

export interface FinalizeReflectionArenaChoiceOptions {
  choice: ReflectionArenaChoice;
  notes?: string;
  onHfUploadComplete?: (message: string) => void;
  recompileByConversation: Map<string, Promise<void>>;
  recompileQueuedByConversation: Set<string>;
  runId: string;
}

export interface ReflectionArenaChoiceQuestion {
  allowOther?: boolean;
  header: string;
  multiSelect: boolean;
  options: Array<{
    description: string;
    label: string;
  }>;
  question: string;
}

const updateLocks = new Map<string, Promise<void>>();

async function getGitHead(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFile("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf-8",
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function getReflectionArenaRoot(): string {
  return join(homedir(), ".letta", "reflection-arena");
}

function getReflectionArenaRunsDir(): string {
  return join(getReflectionArenaRoot(), "runs");
}

export function getReflectionArenaChoiceLogPath(): string {
  return join(getReflectionArenaRoot(), "choices.jsonl");
}

function getReflectionArenaRunPath(runId: string): string {
  return join(getReflectionArenaRunsDir(), `${runId}.json`);
}

async function saveReflectionArenaRun(run: ReflectionArenaRun): Promise<void> {
  await mkdir(getReflectionArenaRunsDir(), { recursive: true });
  await writeFile(
    getReflectionArenaRunPath(run.runId),
    `${JSON.stringify(run, null, 2)}\n`,
    "utf-8",
  );
}

export async function loadReflectionArenaRun(
  runId: string,
): Promise<ReflectionArenaRun> {
  const raw = await readFile(getReflectionArenaRunPath(runId), "utf-8");
  return JSON.parse(raw) as ReflectionArenaRun;
}

async function updateReflectionArenaRun(
  runId: string,
  update: (
    run: ReflectionArenaRun,
  ) => ReflectionArenaRun | Promise<ReflectionArenaRun>,
): Promise<ReflectionArenaRun> {
  let updated: ReflectionArenaRun | undefined;
  const previous = updateLocks.get(runId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const current = await loadReflectionArenaRun(runId);
      updated = await update(current);
      await saveReflectionArenaRun(updated);
    });
  const guarded = next.finally(() => {
    if (updateLocks.get(runId) === guarded) {
      updateLocks.delete(runId);
    }
  });
  updateLocks.set(runId, guarded);
  await next;
  if (!updated) {
    throw new Error(`Reflection arena run ${runId} was not updated`);
  }
  return updated;
}

function shuffledLabels(): [
  ReflectionArenaCandidateLabel,
  ReflectionArenaCandidateLabel,
] {
  return randomInt(2) === 0 ? ["1", "2"] : ["2", "1"];
}

function truncateReport(report: string | undefined): string {
  if (!report?.trim()) return "(no final report returned)";
  const maxChars = 12_000;
  if (report.length <= maxChars) return report.trim();
  return `${report.slice(0, maxChars).trimEnd()}\n\n[Report truncated; full report is stored in the arena run JSON.]`;
}

export function buildReflectionArenaChoiceQuestions(
  runId: string,
): ReflectionArenaChoiceQuestion[] {
  return [
    {
      header: "Reflection arena",
      question: `${REFLECTION_ARENA_CHOICE_QUESTION}\n\nRun: ${runId}`,
      multiSelect: false,
      allowOther: false,
      options: [
        {
          label: "Reflection 1",
          description:
            "Merge Reflection 1 into memory and discard Reflection 2.",
        },
        {
          label: "Reflection 2",
          description:
            "Merge Reflection 2 into memory and discard Reflection 1.",
        },
        {
          label: "Tie / no merge",
          description: "Do not merge either candidate; discard both worktrees.",
        },
      ],
    },
    {
      header: "Reflection arena feedback",
      question: REFLECTION_ARENA_NOTES_QUESTION,
      multiSelect: false,
      options: [
        {
          label: "No feedback",
          description: "Record the choice without extra grading notes.",
        },
      ],
    },
  ];
}

export function parseReflectionArenaChoiceAnswers(
  answers: Record<string, string>,
): ReflectionArenaChoiceAnswer {
  const choiceAnswer =
    answers[REFLECTION_ARENA_CHOICE_QUESTION] ??
    Object.entries(answers).find(([question]) =>
      question.startsWith(REFLECTION_ARENA_CHOICE_QUESTION),
    )?.[1] ??
    "";
  const normalizedChoice = choiceAnswer.trim().toLowerCase();
  const choice = normalizedChoice.includes("reflection 1")
    ? "1"
    : normalizedChoice.includes("reflection 2")
      ? "2"
      : normalizedChoice.includes("tie")
        ? "tie"
        : undefined;
  if (!choice) {
    throw new Error("Choose Reflection 1, Reflection 2, or Tie / no merge.");
  }

  const rawNotes =
    answers[REFLECTION_ARENA_NOTES_QUESTION] ??
    Object.entries(answers).find(([question]) =>
      question.startsWith(REFLECTION_ARENA_NOTES_QUESTION),
    )?.[1] ??
    "";
  const notes = rawNotes.trim();
  return {
    choice,
    notes:
      notes && notes !== "No notes" && notes !== "No feedback"
        ? notes
        : undefined,
  };
}

export function formatReflectionArenaDeferredMessage(runId: string): string {
  return [
    `Reflection arena run ${runId} is still awaiting a choice.`,
    "Inspect Memory Palace, then resume the choice prompt when ready:",
    `  /reflect-arena resume ${runId}`,
  ].join("\n");
}

function colorForCandidate(label: ReflectionArenaCandidateLabel): string {
  return label === "1" ? ANSI_CYAN : ANSI_MAGENTA;
}

function colorizeCandidateReport(
  label: ReflectionArenaCandidateLabel,
  report: string,
): string {
  return `${colorForCandidate(label)}${report}${ANSI_RESET_FOREGROUND}`;
}

function formatCandidateReport(candidate: ReflectionArenaCandidate): string {
  const result = candidate.result;
  const status = result?.success
    ? "completed"
    : `errored: ${result?.error ?? "unknown error"}`;
  const subagentReference = result?.agentId
    ? buildAgentReference(result.agentId, {
        conversationId: result.conversationId,
      })
    : candidate.subagentId;
  return colorizeCandidateReport(
    candidate.label,
    [
      `Reflection ${candidate.label}`,
      `Status: ${status}`,
      `Subagent: ${result?.agentId ?? candidate.subagentId}`,
      `Subagent link: ${subagentReference}`,
      "",
      truncateReport(result?.report),
    ].join("\n"),
  );
}

export function formatReflectionArenaAwaitingChoice(
  run: ReflectionArenaRun,
): string {
  const ordered = [...run.candidates].sort((a, b) =>
    a.label.localeCompare(b.label),
  );
  const reports = ordered.map(formatCandidateReport).join("\n\n---\n\n");
  return [
    `Reflection arena run ${run.runId} is ready for blind grading.`,
    "",
    `Transcript payload: ${run.payloadPath}`,
    `Run file: ${getReflectionArenaRunPath(run.runId)}`,
    "Models are hidden until you choose.",
    "",
    reports,
    "",
    "Use the reflection arena choice prompt below to select a winner and optionally add notes.",
    `Choice log: ${getReflectionArenaChoiceLogPath()}`,
  ].join("\n");
}

function formatCandidateModelLink(candidate: ReflectionArenaCandidate): string {
  if (!candidate.result?.agentId) {
    return candidate.model;
  }
  const reference = buildAgentReference(candidate.result.agentId, {
    conversationId: candidate.result.conversationId,
  });
  return `${candidate.model} (${reference})`;
}

function formatReflectionArenaChoiceResult(params: {
  discarded: ReflectionArenaCandidateLabel[];
  hfUploadMessage?: string;
  integration?: ReflectionMemoryWorktreeFinalizeResult;
  run: ReflectionArenaRun;
}): string {
  const { run, integration, discarded, hfUploadMessage } = params;
  const chosen = run.choice?.chosen ?? "tie";
  const winner =
    chosen === "tie"
      ? null
      : run.candidates.find((candidate) => candidate.label === chosen);
  const losers = discarded
    .map((label) =>
      run.candidates.find((candidate) => candidate.label === label),
    )
    .filter((candidate): candidate is ReflectionArenaCandidate =>
      Boolean(candidate),
    );
  const selectionLine = winner
    ? `${ANSI_BOLD}Recorded selection ${formatCandidateModelLink(winner)} over ${losers.map(formatCandidateModelLink).join(" and ") || "the other candidate"}.${ANSI_RESET_BOLD}`
    : `${ANSI_BOLD}Recorded selection tie / no merge.${ANSI_RESET_BOLD}`;

  return [
    selectionLine,
    "",
    integration
      ? `Memory result: ${integration.summary}`
      : "Memory result: no candidate merged.",
    ...(hfUploadMessage ? [hfUploadMessage] : []),
    `Run file: ${getReflectionArenaRunPath(run.runId)}`,
    `Choice log: ${getReflectionArenaChoiceLogPath()}`,
  ].join("\n");
}

async function appendChoiceRecord(run: ReflectionArenaRun): Promise<void> {
  await mkdir(getReflectionArenaRoot(), { recursive: true });
  await appendFile(
    getReflectionArenaChoiceLogPath(),
    `${JSON.stringify({
      run_id: run.runId,
      agent_id: run.agentId,
      conversation_id: run.conversationId,
      payload_path: run.payloadPath,
      created_at: run.createdAt,
      recorded_at: run.choice?.recordedAt,
      chosen: run.choice?.chosen,
      notes: run.choice?.notes,
      choice_note:
        run.choice?.notes && run.choice.chosen
          ? { [run.choice.chosen]: run.choice.notes }
          : undefined,
      candidates: run.candidates.map((candidate) => ({
        label: candidate.label,
        model: candidate.model,
        success: candidate.result?.success ?? null,
        error: candidate.result?.error,
        subagent_agent_id: candidate.result?.agentId,
        step_count: candidate.result?.stepCount,
        duration_ms: candidate.result?.durationMs,
      })),
      integration: run.choice?.integration,
    })}\n`,
    "utf-8",
  );
}

async function uploadChoiceRecordToHf(params: {
  run: ReflectionArenaRun;
  memoryBaseCommit: string | null;
  memoryCandidateCommit: string | null;
}): Promise<string | undefined> {
  const { run, memoryBaseCommit, memoryCandidateCommit } = params;
  const choice = run.choice;
  if (!choice) return undefined;

  const winner =
    choice.chosen === "tie"
      ? null
      : (run.candidates.find(
          (candidate) => candidate.label === choice.chosen,
        ) ?? null);
  const loser =
    choice.chosen === "tie"
      ? null
      : choice.discarded
          .map((label) =>
            run.candidates.find((candidate) => candidate.label === label),
          )
          .find((candidate): candidate is ReflectionArenaCandidate =>
            Boolean(candidate),
          );

  const row = buildReflectionArenaHfChoiceRow({
    runId: run.runId,
    choice: choice.chosen === "tie" ? "tie" : "win_loss",
    winner: winner?.model ?? null,
    loser: loser?.model ?? null,
    winnerAgentId: winner?.result?.agentId ?? null,
    loserAgentId: loser?.result?.agentId ?? null,
    parentAgentId: run.agentId,
    timestamp: choice.recordedAt,
    feedback: choice.notes,
    parentConversationId: run.conversationId,
    memoryBaseCommit,
    memoryCandidateCommit,
  });

  const result = await maybeUploadReflectionArenaChoiceToHf(row);
  if (result.uploaded) {
    return `Uploaded reflection arena vote to HF ${result.repoId} dataset`;
  }
  if (result.reason === "missing_token") {
    return "HF upload: no HF_TOKEN found; local log only. Run /secrets set HF_TOKEN to enable uploads.";
  }
  debugWarn(
    "memory",
    `Failed to upload reflection arena choice to Hugging Face: ${result.error ?? "unknown error"}`,
  );
  return `HF upload: failed via git-cache-v3; local log only. ${result.error ?? ""}`.trim();
}

function candidateIsFinished(candidate: ReflectionArenaCandidate): boolean {
  return Boolean(candidate.result);
}

function runIsReady(run: ReflectionArenaRun): boolean {
  return (
    run.candidates.length === REFLECTION_ARENA_CANDIDATE_COUNT &&
    run.candidates.every(candidateIsFinished)
  );
}

async function markCandidateComplete(params: {
  candidateLabel: ReflectionArenaCandidateLabel;
  result: ReflectionArenaCandidateResult;
  runId: string;
}): Promise<ReflectionArenaRun> {
  return updateReflectionArenaRun(params.runId, (run) => {
    const candidates = run.candidates.map((candidate) =>
      candidate.label === params.candidateLabel
        ? { ...candidate, result: params.result }
        : candidate,
    );
    const next: ReflectionArenaRun = { ...run, candidates };
    if (runIsReady(next)) {
      next.status = "awaiting_choice";
      next.completedAt = new Date().toISOString();
    }
    return next;
  });
}

export async function launchReflectionArena(
  options: LaunchReflectionArenaOptions,
): Promise<LaunchReflectionArenaResult> {
  let systemPrompt: string | undefined;
  try {
    const agent = await getBackend().retrieveAgent(options.agentId);
    systemPrompt = agent.system ?? undefined;
  } catch {
    // Non-fatal — the arena payload will just omit the system prompt.
  }

  const payload = await buildAutoReflectionPayload(
    options.agentId,
    options.conversationId,
    systemPrompt,
  );
  if (!payload) {
    return { launched: false, reason: "no_payload" };
  }

  const run = await startReflectionArenaRun({
    ...options,
    payload,
  });
  return { launched: true, payloadPath: payload.payloadPath, run };
}

export async function startReflectionArenaRun(
  options: StartReflectionArenaRunOptions,
): Promise<ReflectionArenaRun> {
  if (!tryReserveReflectionLaunch(options.agentId)) {
    throw new Error("A reflection agent is already running in the background.");
  }

  let releaseReservation = true;
  try {
    const runId = randomUUID().slice(0, 8);
    const labels = shuffledLabels();
    const prepared = await Promise.all([
      prepareReflectionMemoryWorktreeLaunch({
        agentId: options.agentId,
        instruction: options.instruction,
      }).then((prep) => ({
        label: labels[0],
        model: options.models[0],
        ...prep,
      })),
      prepareReflectionMemoryWorktreeLaunch({
        agentId: options.agentId,
        instruction: options.instruction,
      }).then((prep) => ({
        label: labels[1],
        model: options.models[1],
        ...prep,
      })),
    ]);

    const run: ReflectionArenaRun = {
      agentId: options.agentId,
      candidates: [],
      conversationId: options.conversationId,
      createdAt: new Date().toISOString(),
      endMessageId: options.payload.endMessageId,
      endSnapshotLine: options.payload.endSnapshotLine,
      payloadPath: options.payload.payloadPath,
      runId,
      startMessageId: options.payload.startMessageId,
      status: "running",
    };
    await saveReflectionArenaRun(run);

    const { spawnBackgroundSubagentTask, waitForBackgroundSubagentAgentId } =
      await import("@/tools/impl/task");
    const candidates: ReflectionArenaCandidate[] = prepared.map((candidate) => {
      const { subagentId } = spawnBackgroundSubagentTask({
        subagentType: "reflection",
        prompt: candidate.reflectionPrompt,
        description: "Reflection arena candidate",
        model: candidate.model,
        silentCompletion: true,
        transcriptPath: options.payload.payloadPath,
        memoryScope: buildReflectionMemoryScope(candidate.worktree),
        parentScope: {
          agentId: options.agentId,
          conversationId: options.conversationId,
        },
        onComplete: async ({
          success,
          error,
          agentId,
          conversationId,
          stepCount,
          durationMs,
          report,
        }) => {
          try {
            emitReflectionRunEnd({
              parentAgentId: options.agentId,
              triggerSource: options.triggerSource,
              success,
              subagentId: agentId ?? undefined,
              conversationId: options.conversationId,
              error,
              stepCount,
              durationMs,
              feedbackContext: {
                ...options.feedbackContext,
                model: candidate.model,
              },
            });
            const updated = await markCandidateComplete({
              candidateLabel: candidate.label,
              runId,
              result: {
                success,
                error,
                agentId,
                conversationId,
                stepCount,
                durationMs,
                report,
              },
            });
            if (updated.status === "awaiting_choice") {
              releaseReflectionLaunch(options.agentId);
              releaseReservation = false;
              await options.onReady(
                formatReflectionArenaAwaitingChoice(updated),
                updated,
              );
            }
          } catch (completionError) {
            debugWarn(
              "memory",
              `Failed to finish reflection arena candidate ${candidate.label}: ${completionError instanceof Error ? completionError.message : String(completionError)}`,
            );
          }
        },
      });
      void waitForBackgroundSubagentAgentId(
        subagentId,
        REFLECTION_AGENT_ID_WAIT_MS,
      ).then((resolvedAgentId) => {
        emitReflectionRunStart({
          triggerSource: options.triggerSource,
          subagentId: resolvedAgentId ?? undefined,
          conversationId: options.conversationId,
          startMessageId: options.payload.startMessageId,
          endMessageId: options.payload.endMessageId,
          model: candidate.model,
        });
      });
      return {
        label: candidate.label,
        model: candidate.model,
        subagentId,
        worktree: candidate.worktree,
      };
    });

    const updatedRun: ReflectionArenaRun = { ...run, candidates };
    await saveReflectionArenaRun(updatedRun);
    return updatedRun;
  } catch (error) {
    if (releaseReservation) {
      releaseReflectionLaunch(options.agentId);
    }
    throw error;
  }
}

export async function finalizeReflectionArenaChoice(
  options: FinalizeReflectionArenaChoiceOptions,
): Promise<{ message: string; run: ReflectionArenaRun }> {
  const run = await loadReflectionArenaRun(options.runId);
  if (run.status !== "awaiting_choice") {
    throw new Error(
      `Reflection arena run ${options.runId} is ${run.status}; expected awaiting_choice.`,
    );
  }

  const discarded: ReflectionArenaCandidateLabel[] = [];
  let integration: ReflectionMemoryWorktreeFinalizeResult | undefined;
  let memoryBaseCommit: string | null = null;
  let memoryCandidateCommit: string | null = null;

  if (options.choice !== "tie") {
    const chosen = run.candidates.find(
      (candidate) => candidate.label === options.choice,
    );
    if (!chosen) {
      throw new Error(`Unknown reflection arena label: ${options.choice}`);
    }
    memoryBaseCommit = chosen.worktree.baseHead;
    memoryCandidateCommit = await getGitHead(chosen.worktree.worktreeDir);
    const finalized = await finalizeReflectionMemoryWorktreeLaunch({
      worktree: chosen.worktree,
      subagentSuccess: chosen.result?.success ?? false,
      subagentError: chosen.result?.error,
      agentId: run.agentId,
      conversationId: run.conversationId,
      subagentAgentId: chosen.result?.agentId,
      recompileByConversation: options.recompileByConversation,
      recompileQueuedByConversation: options.recompileQueuedByConversation,
      logRecompileFailure: (message) => debugWarn("memory", message),
    });
    integration = finalized.integration;
  }

  for (const candidate of run.candidates) {
    if (options.choice !== "tie" && candidate.label === options.choice) {
      continue;
    }
    discarded.push(candidate.label);
    await finalizeReflectionMemoryWorktree(candidate.worktree, {
      shouldMerge: false,
    });
  }

  await finalizeAutoReflectionPayload(
    run.agentId,
    run.conversationId,
    run.payloadPath,
    run.endSnapshotLine,
    integration ? reflectionIntegrationConsumesTranscript(integration) : false,
  );

  const completedRun: ReflectionArenaRun = {
    ...run,
    choice: {
      chosen: options.choice,
      discarded,
      ...(integration ? { integration } : {}),
      ...(options.notes ? { notes: options.notes } : {}),
      recordedAt: new Date().toISOString(),
    },
    status: "completed",
  };
  await saveReflectionArenaRun(completedRun);
  await appendChoiceRecord(completedRun);
  void uploadChoiceRecordToHf({
    run: completedRun,
    memoryBaseCommit,
    memoryCandidateCommit,
  })
    .then((message) => {
      if (message) {
        options.onHfUploadComplete?.(message);
      }
    })
    .catch((error) => {
      debugWarn(
        "memory",
        `Failed to upload reflection arena choice to Hugging Face: ${error instanceof Error ? error.message : String(error)}`,
      );
      options.onHfUploadComplete?.("HF upload: failed; local log only.");
    });

  return {
    message: formatReflectionArenaChoiceResult({
      discarded,
      integration,
      run: completedRun,
    }),
    run: completedRun,
  };
}
