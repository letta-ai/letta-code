import { backgroundTasks } from "./process_manager";

/** Keep one-shot hosts alive after writing the primary's result. */
export async function finishBackgroundMemoryTasks(
  agentId: string,
  conversationId: string,
): Promise<void> {
  const finished = new Set<Promise<void>>();
  for (;;) {
    const pending = [...backgroundTasks.values()]
      .filter(
        (task) =>
          task.subagentType === "memory" &&
          task.runtimeScope?.agentId === agentId &&
          task.runtimeScope?.conversationId === conversationId,
      )
      .map((task) => task.completion)
      .filter((completion): completion is Promise<void> =>
        Boolean(completion && !finished.has(completion)),
      );
    if (pending.length === 0) return;
    await Promise.all(pending);
    for (const completion of pending) finished.add(completion);
  }
}
