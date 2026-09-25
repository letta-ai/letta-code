import { commitMemoryWrite } from "@/agent/memory-git";

export type LeftoverMemoryCommit =
  | { committed: true; sha?: string }
  /** Nothing was committed; `error` is Git's (usually the pre-commit hook's) reason. */
  | { committed: false; error: string };

/**
 * Commit whatever a turn left uncommitted in the memory checkout, as the
 * agent. The memory tools used to commit every edit themselves; direct edits
 * only reach a commit when the agent remembers to run Git, so post-turn sync
 * saves the rest so a turn never ends with unsaved memory.
 *
 * Runs only between the primary's turns, under the checkout lease, when its
 * edits are complete. Background workers never call this: they sync while
 * the primary may be mid-edit. The MemFS pre-commit hook still validates
 * every file; what it rejects stays uncommitted and is reported instead.
 */
export async function commitLeftoverMemoryChanges(params: {
  memoryDir: string;
  agentId: string;
  authorName?: string | null;
  localOnly: boolean;
}): Promise<LeftoverMemoryCommit> {
  try {
    const result = await commitMemoryWrite({
      memoryDir: params.memoryDir,
      pathspecs: ["."],
      reason: "chore(memory): save changes left after the turn",
      author: {
        agentId: params.agentId,
        authorName: params.authorName?.trim() || params.agentId,
        authorEmail: `${params.agentId}@letta.com`,
      },
      syncMode: params.localOnly ? "local" : "remote",
    });
    return result.committed
      ? { committed: true, sha: result.sha }
      : { committed: false, error: "No effective changes to commit." };
  } catch (error) {
    return {
      committed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
