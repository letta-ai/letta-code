import stripAnsi from "strip-ansi";
import { GITHUB_WRITE_CAPABILITY_ENV } from "@/github-write-authority";
import {
  extractSecretEnvFromCommand,
  scrubSecretsFromString,
} from "./secret-substitution";

/** Resolve and redact only secrets available to this shell invocation. */
export function prepareShellInvocationSecrets(
  args: Record<string, unknown>,
  agentId: string | undefined,
  capability: string | null | undefined,
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void,
): { args: Record<string, unknown>; secrets: Record<string, string> } {
  const command = args.command ?? args.cmd;
  const secrets =
    typeof command === "string" ||
    (Array.isArray(command) &&
      command.every((part) => typeof part === "string"))
      ? extractSecretEnvFromCommand(command, agentId)
      : {};
  // An empty override clears ambient/agent-secret copies for autonomous work.
  // Neither hidden tool arguments nor an agent secret may select the actor.
  secrets[GITHUB_WRITE_CAPABILITY_ENV] = capability ?? "";
  return {
    secrets,
    args: {
      ...args,
      secretEnv: secrets,
      ...(onOutput
        ? {
            onOutput: (chunk: string, stream: "stdout" | "stderr") =>
              onOutput(
                stripAnsi(scrubSecretsFromString(chunk, secrets)),
                stream,
              ),
          }
        : {}),
    },
  };
}
