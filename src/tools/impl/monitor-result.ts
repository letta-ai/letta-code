export function buildMonitorResult<P extends boolean>(
  taskId: string,
  timeoutMs: number,
  persistent: P,
  outputFile?: string,
) {
  const lifetime = persistent
    ? "persistent — runs until TaskStop or session end"
    : `timeout ${timeoutMs}ms`;
  return {
    content: [
      {
        type: "text" as const,
        text: `Monitor started (task ${taskId}, ${lifetime}). You will be notified on each event. Keep working — do not poll or sleep. Events may arrive while you are waiting for the user — an event is not their reply.${outputFile ? `\nOutput file: ${outputFile}` : ""}`,
      },
    ],
    taskId,
    timeoutMs,
    persistent,
  };
}
