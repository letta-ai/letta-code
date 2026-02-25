export interface FlagConflictCheck {
  when: unknown;
  message: string;
}

export function validateConversationFlagConflicts(options: {
  specifiedConversationId: string | null | undefined;
  checks: FlagConflictCheck[];
}): void {
  const { specifiedConversationId, checks } = options;
  if (!specifiedConversationId || specifiedConversationId === "default") {
    return;
  }
  const firstConflict = checks.find((check) => Boolean(check.when));
  if (firstConflict) {
    throw new Error(firstConflict.message);
  }
}

export function validateNewConversationFlagConflicts(options: {
  forceNewConversation: boolean | null | undefined;
  checks: FlagConflictCheck[];
}): void {
  const { forceNewConversation, checks } = options;
  if (!forceNewConversation) {
    return;
  }
  const firstConflict = checks.find((check) => Boolean(check.when));
  if (firstConflict) {
    throw new Error(firstConflict.message);
  }
}

export function validateImportFlagConflicts(options: {
  importSource: string | null | undefined;
  checks: FlagConflictCheck[];
}): void {
  const { importSource, checks } = options;
  if (!importSource) {
    return;
  }
  const firstConflict = checks.find((check) => Boolean(check.when));
  if (firstConflict) {
    throw new Error(firstConflict.message);
  }
}

export function validateConversationDefaultRequiresAgent(options: {
  specifiedConversationId: string | null | undefined;
  specifiedAgentId: string | null | undefined;
  forceNew: boolean | null | undefined;
}): void {
  const { specifiedConversationId, specifiedAgentId, forceNew } = options;
  if (
    specifiedConversationId === "default" &&
    !specifiedAgentId &&
    !forceNew
  ) {
    throw new Error("--conv default requires --agent <agent-id>");
  }
}

export function validateRegistryHandleOrThrow(handle: string): void {
  const normalized = handle.startsWith("@") ? handle.slice(1) : handle;
  const parts = normalized.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid registry handle "${handle}"`);
  }
}
