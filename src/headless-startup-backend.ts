import {
  actingUserRequestOptions,
  resolveActingUserId,
} from "@/agent/acting-user";
import type { Backend } from "@/backend";

type HeadlessStartupBackend = Pick<
  Backend,
  | "retrieveAgent"
  | "retrieveConversation"
  | "createConversation"
  | "updateAgent"
  | "updateConversation"
>;

function mergeRequestOptions<T>(
  options: T | undefined,
  actingUserOptions: ReturnType<typeof actingUserRequestOptions>,
): T | undefined {
  if (!actingUserOptions) return options;
  return { ...options, ...actingUserOptions } as T;
}

/**
 * Remote launches resolve Cloud resources before handing execution to a
 * computer. Attribute only those startup requests to the initiating user;
 * nonempty options also keep attributed agent reads out of the ID-only cache.
 */
export function createStartupBackend(
  backend: HeadlessStartupBackend,
  usesRemoteComputer: boolean,
  actingUserId = resolveActingUserId(),
): HeadlessStartupBackend {
  const requestOptions = usesRemoteComputer
    ? actingUserRequestOptions(actingUserId)
    : undefined;

  return {
    retrieveAgent: (agentId, options) =>
      backend.retrieveAgent(
        agentId,
        mergeRequestOptions(options, requestOptions),
      ),
    retrieveConversation: (conversationId, options) =>
      backend.retrieveConversation(
        conversationId,
        mergeRequestOptions(options, requestOptions),
      ),
    createConversation: (body, options) =>
      backend.createConversation(
        body,
        mergeRequestOptions(options, requestOptions),
      ),
    updateAgent: (agentId, body, options) =>
      backend.updateAgent(
        agentId,
        body,
        mergeRequestOptions(options, requestOptions),
      ),
    updateConversation: (conversationId, body, options) =>
      backend.updateConversation(
        conversationId,
        body,
        mergeRequestOptions(options, requestOptions),
      ),
  };
}
