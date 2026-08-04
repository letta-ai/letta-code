export interface FlagConflictCheck {
  when: unknown;
  message: string;
}

export function validateFlagConflicts(options: {
  guard: unknown;
  checks: FlagConflictCheck[];
}): void {
  const { guard, checks } = options;
  if (!guard) {
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
  if (specifiedConversationId === "default" && !specifiedAgentId && !forceNew) {
    throw new Error("--conv default requires --agent <agent-id>");
  }
}

interface StatelessStartupOptions {
  stateless: boolean | null | undefined;
  isHeadless: boolean;
  memfs: boolean | null | undefined;
  memfsStartup: string | null | undefined;
  forceNewAgent: boolean | null | undefined;
  hasExistingAgentSelector: boolean;
}

function validateStatelessStartupOptions(
  options: StatelessStartupOptions,
): void {
  if (!options.stateless) {
    return;
  }
  if (!options.isHeadless) {
    throw new Error("--stateless is only supported in headless mode");
  }
  if (options.memfs) {
    throw new Error("--stateless cannot be used with --memfs");
  }
  if (options.memfsStartup) {
    throw new Error("--stateless cannot be used with --memfs-startup");
  }
  if (options.forceNewAgent) {
    throw new Error(
      "--stateless is for existing agents and cannot be used with --new-agent",
    );
  }
  if (!options.hasExistingAgentSelector) {
    throw new Error("--stateless requires --agent, --name, or --conversation");
  }
}

interface PrimaryStartupFlagOptions {
  specifiedConversationId: string | null | undefined;
  specifiedAgentId: string | null | undefined;
  specifiedAgentName: string | null | undefined;
  forceNewAgent: boolean | null | undefined;
  forceNewConversation: boolean | null | undefined;
  importFile: string | null | undefined;
  shouldResume?: boolean | null;
  stateless: boolean | null | undefined;
  isHeadless: boolean;
  memfs: boolean | null | undefined;
  memfsStartup: string | null | undefined;
}

export function validatePrimaryStartupFlagConflicts(
  options: PrimaryStartupFlagOptions,
): void {
  validateStatelessStartupOptions({
    stateless: options.stateless,
    isHeadless: options.isHeadless,
    memfs: options.memfs,
    memfsStartup: options.memfsStartup,
    forceNewAgent: options.forceNewAgent,
    hasExistingAgentSelector: Boolean(
      options.specifiedAgentId ||
        options.specifiedAgentName ||
        options.specifiedConversationId,
    ),
  });

  validateFlagConflicts({
    guard:
      options.specifiedConversationId &&
      options.specifiedConversationId !== "default",
    checks: [
      {
        when: options.specifiedAgentId,
        message: "--conversation cannot be used with --agent",
      },
      {
        when: options.specifiedAgentName,
        message: "--conversation cannot be used with --name",
      },
      {
        when: options.forceNewAgent,
        message: "--conversation cannot be used with --new-agent",
      },
      {
        when: options.importFile,
        message: "--conversation cannot be used with --import",
      },
      {
        when: options.shouldResume,
        message: "--conversation cannot be used with --resume",
      },
    ],
  });

  validateFlagConflicts({
    guard: options.forceNewConversation,
    checks: [
      {
        when: options.specifiedConversationId,
        message: "--new cannot be used with --conversation",
      },
      {
        when: options.shouldResume,
        message: "--new cannot be used with --resume",
      },
    ],
  });
}

export function validateRegistryHandleOrThrow(handle: string): void {
  const normalized = handle.startsWith("@") ? handle.slice(1) : handle;
  const parts = normalized.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid registry handle "${handle}"`);
  }
}
