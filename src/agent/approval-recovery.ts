import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import { getClient } from "./client";
import { APPROVAL_RECOVERY_PROMPT } from "./promptAssets";

const APPROVAL_RECOVERY_DETAIL_FRAGMENT =
  "no tool call is currently awaiting approval";

type RunErrorMetadata =
  | {
      error_type?: string;
      message?: string;
      detail?: string;
      error?: { error_type?: string; message?: string; detail?: string };
    }
  | undefined
  | null;

export function isApprovalStateDesyncError(detail: unknown): boolean {
  if (typeof detail !== "string") return false;
  return detail.toLowerCase().includes(APPROVAL_RECOVERY_DETAIL_FRAGMENT);
}

export async function fetchRunErrorDetail(
  runId: string | null | undefined,
): Promise<string | null> {
  if (!runId) return null;
  try {
    const client = await getClient();
    const run = await client.runs.retrieve(runId);
    const metaError = run.metadata?.error as RunErrorMetadata;

    return (
      metaError?.detail ??
      metaError?.message ??
      metaError?.error?.detail ??
      metaError?.error?.message ??
      null
    );
  } catch {
    return null;
  }
}

export function buildApprovalRecoveryMessage(): MessageCreate {
  return {
    type: "message",
    role: "user",
    content: [{ type: "text", text: APPROVAL_RECOVERY_PROMPT }],
  };
}
