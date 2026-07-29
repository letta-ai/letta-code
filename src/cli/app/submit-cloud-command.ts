import { randomUUID } from "node:crypto";
import type { MutableRefObject } from "react";
import { isActiveMemfsEnabled } from "@/agent/memory-runtime";
import type { Backend } from "@/backend";
import { getBackend } from "@/backend";
import { getServerUrl } from "@/backend/api/client";
import {
  prepareCloudConversation,
  sendCloudConversationTurn,
} from "@/backend/api/environment-turn";
import type { AppCommandRunner } from "@/cli/app/types";
import type { Buffers } from "@/cli/helpers/accumulator";
import {
  getCloudCommandEligibilityError,
  parseCloudCommand,
} from "@/cli/helpers/cloud-command";
import { formatErrorDetails } from "@/cli/helpers/error-formatter";
import {
  deletePrivateHandoffRef,
  prepareGithubHandoff,
} from "@/cli/helpers/git-handoff-snapshot";
import { runPostTurnMemorySync } from "@/reminders/memory-git-sync";
import type { SharedReminderState } from "@/reminders/state";
import { enqueueMemoryGitSyncReminder } from "@/reminders/state";
import { uid } from "./ids";
import type { ProcessConversation } from "./types";

type SubmissionResult = { submitted: boolean };

export interface CloudConversationState {
  handoffReminder?: string;
}

type CloudConversationMapRef = MutableRefObject<
  Map<string, CloudConversationState>
>;

function cloudKey(agentId: string, conversationId: string): string {
  return `${agentId}:${conversationId}`;
}

function appendCloudLine(
  buffers: Buffers,
  kind: "assistant" | "error",
  text: string,
): void {
  const id = uid(`cloud-${kind}`);
  buffers.byId.set(
    id,
    kind === "assistant"
      ? { kind, id, text, phase: "finished" }
      : { kind, id, text },
  );
  buffers.order.push(id);
}

function prependHandoffReminder(
  messages: Array<Record<string, unknown>>,
  reminder: string | undefined,
): Array<Record<string, unknown>> {
  if (!reminder) return messages;
  let added = false;
  return messages.map((message) => {
    if (added || message.role !== "user") return message;
    added = true;
    const content = message.content;
    const contentParts = Array.isArray(content)
      ? content
      : [{ type: "text", text: typeof content === "string" ? content : "" }];
    return {
      ...message,
      content: [{ type: "text", text: reminder }, ...contentParts],
    };
  });
}

function buildHandoffReminder(
  handoff: ReturnType<typeof prepareGithubHandoff>,
): string | undefined {
  if (!handoff?.privateRef) return undefined;
  return `<system-reminder>This conversation was moved to a Cloud computer. The workspace was restored from private handoff snapshot ${handoff.repository.ref}, based on ${handoff.baseCommit}, including ${handoff.changedFiles.length} local changed file(s). Continue from this exact workspace; do not assume those changes exist on the remote branch.</system-reminder>`;
}

export async function handleCloudCommand(params: {
  input: string;
  agentId: string;
  conversationId: string;
  projectDirectory: string;
  commandRunner: AppCommandRunner;
  cloudConversationKeysRef: CloudConversationMapRef;
  buffersRef: MutableRefObject<Buffers>;
  checkPendingApprovals: () => Promise<{ blocked: true } | { blocked: false }>;
  refreshDerived: () => void;
  setCommandRunning: (value: boolean) => void;
  setStreaming: (value: boolean) => void;
  setThinkingMessage: (value: string) => void;
}): Promise<SubmissionResult | null> {
  const parsed = parseCloudCommand(params.input);
  if (!parsed) return null;

  const cmd = params.commandRunner.start(
    params.input,
    "Starting this conversation in Cloud...",
  );
  const eligibilityError = getCloudCommandEligibilityError({
    agentId: params.agentId,
    serverUrl: getServerUrl(),
  });
  if (eligibilityError) {
    cmd.fail(eligibilityError);
    return { submitted: true };
  }
  if ((await params.checkPendingApprovals()).blocked) {
    cmd.fail(
      "Pending approval(s). Resolve approvals before moving this conversation to Cloud.",
    );
    return { submitted: false };
  }

  params.setCommandRunning(true);
  const key = cloudKey(params.agentId, params.conversationId);
  let cloudPrepared = false;
  try {
    const handoff = prepareGithubHandoff(
      params.projectDirectory,
      params.conversationId,
    );
    const repositories = handoff ? [handoff.repository] : undefined;
    const cloud = await (async () => {
      try {
        return await prepareCloudConversation({
          agentId: params.agentId,
          conversationId: params.conversationId,
          githubRepositories: repositories,
          forceNew: Boolean(repositories),
          setAsRuntimeTarget: true,
        });
      } finally {
        deletePrivateHandoffRef(
          params.projectDirectory,
          handoff?.privateRef ?? null,
        );
      }
    })();
    cloudPrepared = true;
    params.cloudConversationKeysRef.current.set(key, {
      handoffReminder: buildHandoffReminder(handoff),
    });
    if (!parsed.instruction) {
      cmd.finish(
        `Moved to Cloud (${cloud.name})${handoff?.changedFiles.length ? ` with ${handoff.changedFiles.length} local file change(s)` : ""}. Subsequent messages in this session will run there.`,
        true,
      );
      return { submitted: true };
    }

    cmd.finish(`Moved to Cloud (${cloud.name}). Continuing there...`, true);
    params.setThinkingMessage("Working in Cloud...");
    params.setStreaming(true);
    const result = await sendCloudConversationTurn({
      backend: getBackend(),
      agentId: params.agentId,
      conversationId: params.conversationId,
      githubRepositories: repositories,
      connectionId: cloud.connectionId,
      messages: prependHandoffReminder(
        [
          {
            role: "user",
            content: parsed.instruction,
            otid: randomUUID(),
            client_message_id: randomUUID(),
          },
        ],
        params.cloudConversationKeysRef.current.get(key)?.handoffReminder,
      ),
    });
    params.cloudConversationKeysRef.current.set(key, {});
    appendCloudLine(params.buffersRef.current, "assistant", result.text);
    params.refreshDerived();
  } catch (error) {
    if (cloudPrepared) {
      appendCloudLine(
        params.buffersRef.current,
        "error",
        `Cloud execution failed: ${formatErrorDetails(error, params.agentId)}`,
      );
      params.refreshDerived();
    } else {
      params.cloudConversationKeysRef.current.delete(key);
      cmd.fail(
        `Failed to move to Cloud: ${formatErrorDetails(error, params.agentId)}`,
      );
    }
  } finally {
    params.setStreaming(false);
    params.setCommandRunning(false);
  }
  return { submitted: true };
}

export async function processCloudSubmission(params: {
  agentId: string;
  conversationId: string;
  input: Array<Record<string, unknown>>;
  backend?: Backend;
  cloudConversationKeysRef: CloudConversationMapRef;
  buffersRef: MutableRefObject<Buffers>;
  refreshDerived: () => void;
  setStreaming: (value: boolean) => void;
  setThinkingMessage: (value: string) => void;
}): Promise<boolean> {
  if (
    !params.cloudConversationKeysRef.current.has(
      cloudKey(params.agentId, params.conversationId),
    )
  ) {
    return false;
  }
  try {
    params.setThinkingMessage("Working in Cloud...");
    const key = cloudKey(params.agentId, params.conversationId);
    const state = params.cloudConversationKeysRef.current.get(key);
    const result = await sendCloudConversationTurn({
      backend: params.backend ?? getBackend(),
      agentId: params.agentId,
      conversationId: params.conversationId,
      messages: prependHandoffReminder(params.input, state?.handoffReminder),
    });
    params.cloudConversationKeysRef.current.set(key, {});
    appendCloudLine(params.buffersRef.current, "assistant", result.text);
  } catch (error) {
    appendCloudLine(
      params.buffersRef.current,
      "error",
      `Cloud execution failed: ${formatErrorDetails(error, params.agentId)}`,
    );
  } finally {
    params.setStreaming(false);
    params.refreshDerived();
  }
  return true;
}

export interface CloudSubmissionContext {
  agentId: string;
  buffersRef: MutableRefObject<Buffers>;
  checkPendingApprovalsForSlashCommand: () => Promise<
    { blocked: true } | { blocked: false }
  >;
  cloudConversationKeysRef: CloudConversationMapRef;
  commandRunner: AppCommandRunner;
  conversationIdRef: MutableRefObject<string>;
  processConversation: ProcessConversation;
  projectDirectory: string;
  refreshDerived: () => void;
  setCommandRunning: (value: boolean) => void;
  setStreaming: (value: boolean) => void;
  setThinkingMessage: (value: string) => void;
  sharedReminderStateRef: MutableRefObject<SharedReminderState>;
}

export function createCloudSubmissionHandlers(params: CloudSubmissionContext) {
  return {
    handleCommand: (input: string) =>
      handleCloudCommand({
        input,
        agentId: params.agentId,
        conversationId: params.conversationIdRef.current,
        projectDirectory: params.projectDirectory,
        commandRunner: params.commandRunner,
        cloudConversationKeysRef: params.cloudConversationKeysRef,
        buffersRef: params.buffersRef,
        checkPendingApprovals: params.checkPendingApprovalsForSlashCommand,
        refreshDerived: params.refreshDerived,
        setCommandRunning: params.setCommandRunning,
        setStreaming: params.setStreaming,
        setThinkingMessage: params.setThinkingMessage,
      }),
    process: async (
      input: Parameters<ProcessConversation>[0],
      options: NonNullable<Parameters<ProcessConversation>[1]>,
    ) => {
      const handledInCloud = await processCloudSubmission({
        agentId: params.agentId,
        conversationId: params.conversationIdRef.current,
        input: input as unknown as Array<Record<string, unknown>>,
        cloudConversationKeysRef: params.cloudConversationKeysRef,
        buffersRef: params.buffersRef,
        refreshDerived: params.refreshDerived,
        setStreaming: params.setStreaming,
        setThinkingMessage: params.setThinkingMessage,
      });
      if (handledInCloud) return;
      await params.processConversation(input, options);
      await runPostTurnMemorySync({
        agentId: params.agentId,
        isEnabled: isActiveMemfsEnabled,
        debugLabel: "Post-turn memory sync",
        enqueueReminder: (text) => {
          enqueueMemoryGitSyncReminder(params.sharedReminderStateRef.current, {
            text,
          });
        },
      });
    },
  };
}
