import type { ReflectionLaunchSkippedReason } from "@/cli/helpers/reflection-launcher";

/** Exhaustive over the skipped reasons; only `error` has no fixed message. */
export function getReflectionLaunchSkippedMessage(
  reason: ReflectionLaunchSkippedReason,
  surface: "cli" | "listener" = "cli",
): string | undefined {
  switch (reason) {
    case "cutover":
      return "Reflection is managed by Letta Cloud for this agent.";
    case "already_active":
      return surface === "listener"
        ? "A reflection agent is already running for this conversation."
        : "A reflection agent is already running in the background.";
    case "configuration_error":
      return "Automatic reflection is paused because its model configuration is invalid. Fix the reflection model or provider, run /reload, then use /reflect to retry.";
    case "memfs_disabled":
      return surface === "listener"
        ? "Reflection needs the memory filesystem to be enabled for this agent."
        : "Memory filesystem is not enabled.";
    case "no_payload":
      return surface === "listener"
        ? "No new transcript content to reflect on for this conversation."
        : "No new transcript content to reflect on.";
    case "parent_dirty":
      return "The memory repository has uncommitted or untracked changes. Commit or remove them before reflection can run.";
    case "windows_disabled":
      return "Automatic reflection is not enabled on this platform. Use /reflect to run it manually.";
    case "retry_backoff":
      return "A recent reflection attempt could not be merged into memory, so automatic reflection is waiting before retrying. Try /reflect again later.";
    case "error":
      return undefined;
    default:
      return reason satisfies never;
  }
}
