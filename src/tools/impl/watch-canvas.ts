import { getRuntimeContext } from "@/runtime-context";
import { monitor } from "./monitor";
import { backgroundProcesses } from "./process_manager";

/** The harness persists snapshots, coalesces changes, and excludes own edits.
 * The existing Monitor owns cancellation, scoped notifications, and timeouts. */
export const canvasWatchScript = `
let lastError = '';
while (true) {
  let raw;
  try {
    raw = await tools.read_canvas({ canvas_id: args.canvas_id, watch: true });
    lastError = '';
  } catch (error) {
    const message = String(error).slice(0, 500);
    if (message !== lastError) emit('Canvas ' + args.canvas_id + ' refresh failed; retrying: ' + message);
    lastError = message;
    await sleep(10000);
    continue;
  }
  const result = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!result || !Array.isArray(result.watch_events)) {
    throw new Error('This Slack harness does not support canvas watches.');
  }
  for (const event of result.watch_events) {
    emit('Canvas ' + args.canvas_id + ': ' + event.kind + '\\n' + event.diff);
  }
  await sleep(10000);
}`;

export async function watch_canvas(args: {
  canvas_id: string;
  parentScope?: { agentId: string; conversationId: string };
  signal?: AbortSignal;
}) {
  args.signal?.throwIfAborted();
  if (
    typeof args.canvas_id !== "string" ||
    !/^F[A-Z0-9]+$/.test(args.canvas_id)
  ) {
    throw new Error("WatchCanvas canvas_id must be a Slack canvas file ID.");
  }
  const runtime = getRuntimeContext();
  const scope = args.parentScope ?? runtime;
  const description = `WatchCanvas ${args.canvas_id}`;
  for (const [taskId, state] of backgroundProcesses) {
    if (
      state.status === "running" &&
      state.description === description &&
      state.runtimeScope?.agentId === scope?.agentId &&
      state.runtimeScope?.conversationId === scope?.conversationId
    ) {
      throw new Error(`WatchCanvas is already running as task ${taskId}.`);
    }
  }
  return monitor({
    description,
    script: canvasWatchScript,
    args: { canvas_id: args.canvas_id },
    persistent: true,
    parentScope: args.parentScope,
    signal: args.signal,
  });
}
