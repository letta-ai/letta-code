import { type Backend, getBackend } from "@/backend";
import {
  formatReflectionReceipt,
  REFLECTION_UNSUPPORTED,
} from "@/backend/api/reflection-runs";
import { actingUserRequestOptions } from "./acting-user";

export interface DreamCommandScope {
  agentId: string;
  conversationId?: string | null;
  actingUserId?: string;
}

/** One explicit command invocation, with immutable scope and no model turn. */
export async function requestReflectionRun(
  scope: DreamCommandScope,
  args = "",
  backend: Backend = getBackend(),
): Promise<string> {
  if (args.trim()) throw new Error("/dream does not accept arguments.");
  const { agentId, conversationId, actingUserId } = scope;
  if (!agentId) throw new Error("/dream requires an active agent.");
  if (!backend.enqueueReflectionRun) throw new Error(REFLECTION_UNSUPPORTED);
  const receipt = await backend.enqueueReflectionRun(
    agentId,
    {
      conversation_id: conversationId ?? "default",
    },
    actingUserRequestOptions(actingUserId),
  );
  return formatReflectionReceipt(receipt);
}
