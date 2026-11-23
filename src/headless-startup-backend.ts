import {
  actingUserRequestOptions,
  resolveActingUserId,
} from "@/agent/acting-user";
import type { Backend } from "@/backend";

type HeadlessStartupBackend = Pick<
  Backend,
  "retrieveAgent" | "retrieveConversation" | "createConversation"
>;

function mergeRequestOptions<T>(
  options: T | undefined,
  actingUserOptions: ReturnType<typeof actingUserRequestOptions>,
): T | undefined {
  if (!actingUserOptions) return options;
  return { ...options, ...actingUserOptions } as T;
}

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
  };
}
