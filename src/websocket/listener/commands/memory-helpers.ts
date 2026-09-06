import type { EnsureLocalMemfsCheckoutOptions } from "@/agent/memory-filesystem";
import { debugWarn } from "@/utils/debug";
import type { ListMemoryCommandTestOverrides } from "./memory-command-types";

const warnMemoryCommand = debugWarn.bind(null, "memory-commands");

const MEMORY_PUSH_AWAIT_CAP_MS = 8_000;

export async function awaitMemoryPushBounded(
  commandName: string,
  agentId: string,
  memoryRoot: string,
): Promise<void> {
  const { syncPendingMemoryCommitsAfterTurn } = await import(
    "@/agent/memory-git"
  );
  const syncPromise = syncPendingMemoryCommitsAfterTurn(agentId, {
    memoryDir: memoryRoot,
  });

  const warnOnFailure = (result: { status: string; summary: string }): void => {
    if (result.status === "push_failed" || result.status === "conflict") {
      warnMemoryCommand(
        `[${commandName}] push failed for ${agentId}: ${result.summary}`,
      );
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const capPromise = new Promise<"timed_out">((resolve) => {
    timer = setTimeout(() => resolve("timed_out"), MEMORY_PUSH_AWAIT_CAP_MS);
  });

  try {
    const result = await Promise.race([syncPromise, capPromise]);
    if (result === "timed_out") {
      warnMemoryCommand(
        `[${commandName}] push still in flight after ${MEMORY_PUSH_AWAIT_CAP_MS}ms for ${agentId}; responding now, push continues in background`,
      );
      syncPromise.then(warnOnFailure).catch((err) => {
        warnMemoryCommand(
          `[${commandName}] background push failed for ${agentId}:`,
          err instanceof Error ? err.message : err,
        );
      });
      return;
    }
    warnOnFailure(result);
  } catch (err) {
    warnMemoryCommand(
      `[${commandName}] push failed for ${agentId}:`,
      err instanceof Error ? err.message : err,
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function resolveMemoryFilesystemHelpers(
  overrides: ListMemoryCommandTestOverrides = {},
): Promise<{
  ensureLocalMemfsCheckout: (
    agentId: string,
    options?: EnsureLocalMemfsCheckoutOptions,
  ) => Promise<void>;
  getMemoryFilesystemRoot: (agentId: string) => string;
  isMemfsEnabledOnServer: (agentId: string) => Promise<boolean>;
}> {
  const {
    ensureLocalMemfsCheckout: actualEnsureLocalMemfsCheckout,
    getScopedMemoryFilesystemRoot: actualGetMemoryFilesystemRoot,
    isMemfsEnabledOnServer: actualIsMemfsEnabledOnServer,
  } = await import("@/agent/memory-filesystem");

  return {
    ensureLocalMemfsCheckout:
      overrides.ensureLocalMemfsCheckout ?? actualEnsureLocalMemfsCheckout,
    getMemoryFilesystemRoot:
      overrides.getMemoryFilesystemRoot ?? actualGetMemoryFilesystemRoot,
    isMemfsEnabledOnServer:
      overrides.isMemfsEnabledOnServer ?? actualIsMemfsEnabledOnServer,
  };
}
