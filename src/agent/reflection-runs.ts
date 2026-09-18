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

/** Null authorizes the existing Code-managed path, never an error fallback. */
export async function requestCloudReflectionRun(
  scope: DreamCommandScope,
  args = "",
  backend: Backend = getBackend(),
): Promise<string | null> {
  const capturedScope = { ...scope };
  if (!capturedScope.agentId)
    throw new Error("Reflection requires an active agent.");
  if (backend.capabilities.localMemfs) return null;
  if (!backend.retrieveReflectionConfig) {
    throw new Error(
      "Unable to determine reflection ownership on this backend.",
    );
  }
  const config = await backend.retrieveReflectionConfig(
    capturedScope.agentId,
    actingUserRequestOptions(capturedScope.actingUserId),
  );
  if (config === null || config.cutover === false) return null;
  if (config.cutover !== true) {
    throw new Error(
      "Unable to determine reflection ownership: missing cutover configuration.",
    );
  }
  if (args.trim()) {
    throw new Error(
      "Cloud reflection does not accept arguments; it reflects only the current conversation. Use /dream, /reflect, or /reflection without arguments.",
    );
  }
  return requestReflectionRun(capturedScope, "", backend);
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
