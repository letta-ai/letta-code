import { parentPort, workerData } from "node:worker_threads";
import type { SubagentOutcome } from "./types.ts";
import type {
  WorkflowWorkerMessage,
  WorkflowWorkerOptions,
  WorkflowWorkerReply,
} from "./worker-protocol.ts";
import { executeWorkflow } from "./workflow-engine.ts";

const port = parentPort;
if (!port) throw new Error("Workflow worker requires a parent port.");

const pending = new Map<
  number,
  {
    resolve: (outcome: SubagentOutcome) => void;
    reject: (error: Error) => void;
  }
>();
let nextId = 0;
function send(message: WorkflowWorkerMessage): void {
  port?.postMessage(message);
}

port.on("message", (reply: WorkflowWorkerReply) => {
  const call = pending.get(reply.id);
  if (!call) return;
  pending.delete(reply.id);
  if (reply.error !== undefined) call.reject(new Error(reply.error));
  else call.resolve(reply.outcome);
});

async function main(): Promise<void> {
  try {
    const result = await executeWorkflow(
      (request) =>
        new Promise((resolve, reject) => {
          const id = nextId++;
          pending.set(id, { resolve, reject });
          send({ kind: "spawn", id, request });
        }),
      {
        ...(workerData as WorkflowWorkerOptions),
        onProgress: (event) => send({ kind: "progress", event }),
      },
    );
    // Preserve cloneable results (including BigInt and cycles). Scripts may also
    // return functions; retain the old printable fallback for those values.
    try {
      send({ kind: "result", result });
    } catch {
      send({
        kind: "result",
        result: { ...result, result: String(result.result) },
      });
    }
  } catch (error) {
    send({
      kind: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    port?.close();
  }
}

// Bun delivers parent-port messages after module evaluation finishes. A
// top-level await here would deadlock the first agent request waiting on a reply.
void main();
