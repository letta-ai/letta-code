import { LETTA_USAGE_URL } from "@/cli/helpers/app-urls";

export interface StartupCreateFailureFallback {
  failedAgentMessage: string;
  headlessMessage: string;
  disableCreateAgent: boolean;
}

function getErrorDetails(error: unknown): string {
  if (error instanceof Error) {
    const cause = "cause" in error ? error.cause : undefined;
    return cause
      ? `${error.message}: ${getErrorDetails(cause)}`
      : error.message;
  }

  return String(error);
}

function isAgentLimitError(error: unknown): boolean {
  const details = getErrorDetails(error).toLowerCase();
  return (
    details.includes("agents-limit-exceeded") ||
    details.includes("limit for agents")
  );
}

export function resolveStartupCreateFailure(
  error: unknown,
): StartupCreateFailureFallback {
  const details = getErrorDetails(error);

  if (isAgentLimitError(error)) {
    return {
      disableCreateAgent: true,
      failedAgentMessage: `Could not create a default agent because your Constellation agent limit is reached. Select an existing agent below, delete an agent, or upgrade at ${LETTA_USAGE_URL}.`,
      headlessMessage: `Could not create a default agent because your Constellation agent limit is reached. Run with --agent <id> to use an existing agent, delete an agent, or upgrade at ${LETTA_USAGE_URL}.`,
    };
  }

  return {
    disableCreateAgent: false,
    failedAgentMessage: `Could not create a default agent. Select an existing agent below, or try Create a new agent again. (${details})`,
    headlessMessage: `Could not create a default agent. Run with --agent <id> to use an existing agent, or fix the error and try again. (${details})`,
  };
}
