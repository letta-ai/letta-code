// Session-owned conversation rotation for mods.
//
// `ctx.conversation.new()` needs to rebind the live session (UI state,
// routing, hooks) to a fresh conversation — something only the process that
// owns the session can do. The TUI registers a handler here at startup; mod
// conversation handles call through the registry. Contexts without a live
// session (headless, listener) register nothing, and new() throws there
// instead of half-rotating: creating a conversation the session never moves
// to.

export interface ConversationRotationRequest {
  /** Agent the rotation targets. A session handler must reject other agents. */
  agentId?: string | null;
  /** Title/summary for the new conversation, like `/new <name>`. */
  name?: string;
}

export interface ConversationRotationResult {
  conversationId: string;
  /** True when the session rebind is deferred until the in-flight turn ends. */
  queued: boolean;
}

export type ConversationRotationHandler = (
  request: ConversationRotationRequest,
) => Promise<ConversationRotationResult>;

let activeHandler: ConversationRotationHandler | null = null;

/** Register the session's rotation handler. Returns a disposer. */
export function registerConversationRotationHandler(
  handler: ConversationRotationHandler,
): () => void {
  activeHandler = handler;
  return () => {
    if (activeHandler === handler) {
      activeHandler = null;
    }
  };
}

export function hasConversationRotationHandler(): boolean {
  return activeHandler !== null;
}

export function requestConversationRotation(
  request: ConversationRotationRequest,
): Promise<ConversationRotationResult> {
  if (!activeHandler) {
    throw new Error(
      "Mod conversation new(): no live session in this context can be rotated " +
        "(starting a new conversation is only available in an interactive session)",
    );
  }
  return activeHandler(request);
}
