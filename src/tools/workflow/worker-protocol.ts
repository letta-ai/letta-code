import type {
  RunWorkflowOptions,
  SubagentOutcome,
  SubagentRequest,
  WorkflowExecutionResult,
  WorkflowProgressEvent,
} from "./types.ts";

export type WorkflowWorkerOptions = Omit<
  RunWorkflowOptions,
  "signal" | "onProgress"
>;

export type WorkflowWorkerMessage =
  | { kind: "spawn"; id: number; request: SubagentRequest }
  | { kind: "progress"; event: WorkflowProgressEvent }
  | { kind: "result"; result: WorkflowExecutionResult }
  | { kind: "error"; error: string };

export type WorkflowWorkerReply =
  | { id: number; outcome: SubagentOutcome; error?: never }
  | { id: number; error: string; outcome?: never };
