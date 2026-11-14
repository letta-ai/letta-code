/**
 * Startup failure reporting for the channel registry.
 *
 * Failures are split by scope: a channel-level failure (the channel is not
 * configured, has no enabled accounts, or has conflicting accounts) blocks the
 * whole channel, while an account-level failure only affects the account that
 * failed to start. Account failures can be isolated so the accounts that
 * started keep serving.
 */

export interface ChannelStartupFailure {
  channelId: string;
  accountId?: string;
  error: string;
  /**
   * Whether the failure blocks the whole channel (configuration problems) or
   * only the account that failed to start. Account failures can be isolated so
   * the accounts that started keep serving.
   */
  scope: "channel" | "account";
  /** True when the failure was caused by a channel runtime that is not installed. */
  missingRuntime?: boolean;
}

export class ChannelInitializationError extends Error {
  constructor(public readonly failures: ChannelStartupFailure[]) {
    super(formatChannelStartupFailures(failures));
    this.name = "ChannelInitializationError";
  }
}

function formatChannelStartupFailureLabel(
  failure: ChannelStartupFailure,
): string {
  return failure.accountId
    ? `${failure.channelId}/${failure.accountId}`
    : failure.channelId;
}

function formatMissingRuntimeHint(failures: ChannelStartupFailure[]): string[] {
  const missingRuntimeChannels = Array.from(
    new Set(
      failures
        .filter((failure) => failure.missingRuntime)
        .map((failure) => failure.channelId),
    ),
  );
  if (missingRuntimeChannels.length === 0) {
    return [];
  }
  return [
    `Install missing runtimes with: letta server --channels ${missingRuntimeChannels.join(",")} --install-channel-runtimes`,
    "Or install them once with:",
    ...missingRuntimeChannels.map(
      (channelId) => `  letta channels install ${channelId}`,
    ),
  ];
}

export function formatChannelStartupFailures(
  failures: ChannelStartupFailure[],
): string {
  const lines = failures.map(
    (failure) =>
      `- ${formatChannelStartupFailureLabel(failure)}: ${failure.error}`,
  );

  const otherFailures = failures.filter((failure) => !failure.missingRuntime);

  const sections: string[] = [
    "Failed to start requested channel listeners.",
    ...lines,
    "",
    "The listener is not running for these channels.",
  ];

  const missingRuntimeHint = formatMissingRuntimeHint(failures);
  if (missingRuntimeHint.length > 0) {
    sections.push(...missingRuntimeHint);
  }

  if (otherFailures.length > 0) {
    sections.push(
      ...(missingRuntimeHint.length > 0 ? [""] : []),
      "These failures were not caused by a missing channel runtime:",
      ...otherFailures.map(
        (failure) => `  ${formatChannelStartupFailureLabel(failure)}`,
      ),
    );
  }

  return sections.join("\n");
}

/**
 * Message for startup failures that stay isolated to single accounts: the
 * listeners that started keep running, only the failed accounts are deaf.
 */
export function formatIsolatedChannelStartupFailures(
  failures: ChannelStartupFailure[],
): string {
  const lines = failures.map(
    (failure) =>
      `- ${formatChannelStartupFailureLabel(failure)}: ${failure.error}`,
  );

  const sections: string[] = [
    "Some channel accounts failed to start; their listeners are not running.",
    ...lines,
    "",
    "The listeners that started keep running. Fix the failed accounts and restart to retry them.",
  ];

  const missingRuntimeHint = formatMissingRuntimeHint(failures);
  if (missingRuntimeHint.length > 0) {
    sections.push("", ...missingRuntimeHint);
  }

  return sections.join("\n");
}
