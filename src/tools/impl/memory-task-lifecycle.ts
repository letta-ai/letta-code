import { backgroundTasks } from "./process_manager";

/** Await child teardown before the process owning its checkout lock exits. */
export async function finishBackgroundMemoryTasks(
  agentId?: string,
  conversationId?: string,
  options: { cancel?: boolean } = {},
): Promise<void> {
  const finished = new Set<Promise<void>>();
  for (;;) {
    const pending = [...backgroundTasks.values()]
      .filter(
        (task) =>
          task.subagentType === "memory" &&
          (!agentId || task.runtimeScope?.agentId === agentId) &&
          (!conversationId ||
            task.runtimeScope?.conversationId === conversationId),
      )
      .map((task) => {
        if (options.cancel) task.abortController?.abort();
        return task.completion;
      })
      .filter((completion): completion is Promise<void> =>
        Boolean(completion && !finished.has(completion)),
      );
    if (pending.length === 0) return;
    await Promise.all(pending);
    for (const completion of pending) finished.add(completion);
  }
}

/** Controlled process exits must account for tasks from previously active conversations too. */
export async function shutdownBackgroundMemoryTasks(
  exitCode: number,
): Promise<void> {
  await finishBackgroundMemoryTasks(undefined, undefined, {
    cancel: exitCode !== 0,
  });
}
