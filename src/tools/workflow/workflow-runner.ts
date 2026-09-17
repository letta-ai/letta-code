/**
 * Run script code in a worker thread. SDK queries stay in the invoking runtime
 * so they retain its credentials and scope; TaskStop can terminate a script
 * even when it blocks its own event loop after an await.
 */
import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { getCurrentWorkingDirectory } from "@/runtime-context";
import {
  defaultExecutionsDir,
  ExecutionJournal,
  newExecutionId,
} from "./journal.ts";
import type {
  RunWorkflowOptions,
  SubagentSpawner,
  WorkflowExecutionResult,
} from "./types.ts";
import type {
  WorkflowWorkerMessage,
  WorkflowWorkerOptions,
  WorkflowWorkerReply,
} from "./worker-protocol.ts";

function workerUrl(): URL {
  const source = new URL("./workflow-worker.ts", import.meta.url);
  return existsSync(source)
    ? source
    : new URL("./workflow-worker.js", import.meta.url);
}

export async function runWorkflow(
  spawner: SubagentSpawner,
  options: RunWorkflowOptions,
): Promise<WorkflowExecutionResult> {
  const { signal, onProgress, ...input } = options;
  if (signal?.aborted) throw new Error("Workflow aborted.");
  const executionId = input.executionId ?? newExecutionId();
  const executionsDir = input.executionsDir ?? defaultExecutionsDir();
  const workerData: WorkflowWorkerOptions = {
    ...input,
    executionId,
    executionsDir,
    workingDirectory: input.workingDirectory ?? getCurrentWorkingDirectory(),
  };
  // The launch response exposes scriptPath immediately, so persist it before
  // starting the asynchronous worker rather than racing the next file tool.
  new ExecutionJournal(executionsDir, executionId).persistScript(
    input.script,
    input.args,
  );
  const worker = new Worker(workerUrl(), { workerData, execArgv: [] });
  const controller = new AbortController();
  let finished = false;
  let abort: () => void = () => {};
  try {
    return await new Promise<WorkflowExecutionResult>((resolve, reject) => {
      const finish = (error?: Error, result?: WorkflowExecutionResult) => {
        if (finished) return;
        finished = true;
        controller.abort();
        if (error) reject(error);
        else if (result) resolve(result);
      };
      abort = () => finish(new Error("Workflow aborted."));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();

      const reply = (message: WorkflowWorkerReply) => {
        if (finished) return;
        try {
          worker.postMessage(message);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      };
      worker.on("message", (message: WorkflowWorkerMessage) => {
        if (finished) return;
        switch (message.kind) {
          case "spawn":
            void Promise.resolve()
              .then(() => {
                if (controller.signal.aborted)
                  throw new Error("Workflow aborted.");
                return spawner(message.request, controller.signal);
              })
              .then(
                (outcome) => reply({ id: message.id, outcome }),
                (error: unknown) =>
                  reply({ id: message.id, error: String(error) }),
              );
            break;
          case "progress":
            try {
              onProgress?.(message.event);
            } catch (error) {
              finish(error instanceof Error ? error : new Error(String(error)));
            }
            break;
          case "result":
            finish(undefined, message.result);
            break;
          case "error":
            finish(new Error(message.error));
            break;
        }
      });
      worker.on("error", (error) => finish(error));
      worker.on("exit", (code) => {
        if (!finished)
          finish(
            new Error(
              `Workflow worker exited before returning a result (code ${code}).`,
            ),
          );
      });
    });
  } finally {
    finished = true;
    signal?.removeEventListener("abort", abort);
    controller.abort();
    await worker.terminate();
  }
}
