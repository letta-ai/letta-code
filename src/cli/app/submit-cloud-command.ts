import { randomUUID } from "node:crypto";
import type { MutableRefObject } from "react";
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
import { getGithubRepositoryHandoffForDirectory } from "@/cli/helpers/git-context";
import { uid } from "./ids";

type SubmissionResult = { submitted: boolean };

function cloudKey(agentId: string, conversationId: string): string {
  return `${agentId}:${conversationId}`;
}

function githubRepositories(projectDirectory: string) {
  const handoff = getGithubRepositoryHandoffForDirectory(projectDirectory);
  if (handoff.error) throw new Error(handoff.error);
  return handoff.repository ? [handoff.repository] : undefined;
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

export async function handleCloudCommand(params: {
  input: string;
  agentId: string;
  conversationId: string;
  projectDirectory: string;
  commandRunner: AppCommandRunner;
  cloudConversationKeysRef: MutableRefObject<Set<string>>;
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
    const repositories = githubRepositories(params.projectDirectory);
    const cloud = await prepareCloudConversation({
      agentId: params.agentId,
      conversationId: params.conversationId,
      githubRepositories: repositories,
      forceNew: Boolean(repositories),
    });
    cloudPrepared = true;
    params.cloudConversationKeysRef.current.add(key);
    if (!parsed.instruction) {
      cmd.finish(
        `Moved to Cloud (${cloud.name}). Subsequent messages in this session will run there.`,
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
      messages: [
        {
          role: "user",
          content: parsed.instruction,
          otid: randomUUID(),
          client_message_id: randomUUID(),
        },
      ],
    });
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
  cloudConversationKeysRef: MutableRefObject<Set<string>>;
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
    const result = await sendCloudConversationTurn({
      backend: params.backend ?? getBackend(),
      agentId: params.agentId,
      conversationId: params.conversationId,
      messages: params.input,
    });
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
