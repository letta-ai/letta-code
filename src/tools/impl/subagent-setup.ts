export interface PreparedSubagent {
  agentId: string;
  conversationId: string;
}

export interface SubagentSetup {
  /** Trusted caller replacement for Agent's generic one-task fork reminder. */
  firstTurnReminder?: string;
  /** Runs after the child exists and before its first task is started. */
  beforeStart(
    child: PreparedSubagent,
  ): Promise<
    | { start: true }
    | { start: false; result: string; discardUnstartedFork: boolean }
  >;
}

/** Unknown setup outcomes retain the child: it may already be durably bound.
 * Only an explicit losing-fork receipt authorizes deleting this new child.
 */
export async function runSubagentSetup(params: {
  child: PreparedSubagent;
  setup: SubagentSetup;
  signal?: AbortSignal;
  deleteUnstartedFork: (conversationId: string) => Promise<unknown>;
}): Promise<string | undefined> {
  params.signal?.throwIfAborted();
  const result = await params.setup.beforeStart(params.child);
  if (!result.start) {
    if (result.discardUnstartedFork)
      await params.deleteUnstartedFork(params.child.conversationId);
    return result.result;
  }
  params.signal?.throwIfAborted();
  return undefined;
}
