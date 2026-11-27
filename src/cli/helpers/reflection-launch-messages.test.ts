import { describe, expect, test } from "bun:test";
import { getReflectionLaunchSkippedMessage } from "@/cli/helpers/reflection-launch-messages";
import type { ReflectionLaunchSkippedReason } from "@/cli/helpers/reflection-launcher";

const REASONS: Record<ReflectionLaunchSkippedReason, true> = {
  memfs_disabled: true,
  windows_disabled: true,
  cutover: true,
  already_active: true,
  configuration_error: true,
  retry_backoff: true,
  parent_dirty: true,
  no_payload: true,
  error: true,
};

describe("getReflectionLaunchSkippedMessage", () => {
  test("formats parent-dirty and listener-specific skipped reasons", () => {
    expect(getReflectionLaunchSkippedMessage("cutover")).toContain(
      "managed by Letta Cloud",
    );
    expect(getReflectionLaunchSkippedMessage("parent_dirty")).toBe(
      "The memory repository has uncommitted or untracked changes. Commit or remove them before reflection can run.",
    );
    expect(
      getReflectionLaunchSkippedMessage("parent_dirty", "listener"),
    ).toContain("Commit or remove them");
    expect(getReflectionLaunchSkippedMessage("configuration_error")).toContain(
      "Automatic reflection is paused",
    );
    expect(getReflectionLaunchSkippedMessage("no_payload", "listener")).toBe(
      "No new transcript content to reflect on for this conversation.",
    );
  });

  test("maps previously unmapped reasons to actionable messages", () => {
    expect(getReflectionLaunchSkippedMessage("retry_backoff")).toContain(
      "/reflect again later",
    );
    expect(getReflectionLaunchSkippedMessage("windows_disabled")).toContain(
      "Use /reflect",
    );
  });

  test("every reason except error has a message on both surfaces", () => {
    for (const reason of Object.keys(
      REASONS,
    ) as ReflectionLaunchSkippedReason[]) {
      for (const surface of ["cli", "listener"] as const) {
        const message = getReflectionLaunchSkippedMessage(reason, surface);
        if (reason === "error") expect(message).toBeUndefined();
        else expect(message).toBeTruthy();
      }
    }
  });
});
