import {
  TaskNotFoundError,
  type TaskRecord,
  type TaskStatus,
  updateTask,
} from "./tasks/store.js";
import { validateRequiredParams } from "./validation.js";

interface TaskUpdateArgs {
  taskId?: string;
  status?: string;
  subject?: string;
  description?: string;
  activeForm?: string;
  owner?: string;
  addBlocks?: string[];
  addBlockedBy?: string[];
  metadata?: Record<string, string>;
}

const VALID_STATUSES: readonly TaskStatus[] = [
  "pending",
  "in_progress",
  "completed",
  "deleted",
];

function validateStringArray(
  value: unknown,
  paramName: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`TaskUpdate: '${paramName}' must be an array of strings`);
  }
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== "string") {
      throw new Error(
        `TaskUpdate: '${paramName}[${i}]' must be a string, received ${typeof value[i]}`,
      );
    }
  }
  return value as string[];
}

export async function task_update(args: TaskUpdateArgs): Promise<TaskRecord> {
  validateRequiredParams(args, ["taskId"], "TaskUpdate");
  if (typeof args.taskId !== "string" || args.taskId.length === 0) {
    throw new Error("TaskUpdate: 'taskId' must be a non-empty string");
  }

  if (args.status !== undefined) {
    if (!VALID_STATUSES.includes(args.status as TaskStatus)) {
      throw new Error(
        `TaskUpdate: 'status' must be one of ${VALID_STATUSES.join(", ")}; received ${args.status}`,
      );
    }
  }

  if (args.metadata !== undefined) {
    if (
      typeof args.metadata !== "object" ||
      args.metadata === null ||
      Array.isArray(args.metadata)
    ) {
      throw new Error("TaskUpdate: 'metadata' must be an object");
    }
    for (const [k, v] of Object.entries(args.metadata)) {
      if (typeof v !== "string") {
        throw new Error(
          `TaskUpdate: metadata['${k}'] must be a string, received ${typeof v}`,
        );
      }
    }
  }

  const addBlocks = validateStringArray(args.addBlocks, "addBlocks");
  const addBlockedBy = validateStringArray(args.addBlockedBy, "addBlockedBy");

  try {
    return updateTask({
      taskId: args.taskId,
      status: args.status as TaskStatus | undefined,
      subject: args.subject,
      description: args.description,
      activeForm: args.activeForm,
      owner: args.owner,
      addBlocks,
      addBlockedBy,
      metadata: args.metadata,
    });
  } catch (err) {
    if (err instanceof TaskNotFoundError) {
      throw new Error(`TaskUpdate: ${err.message}`);
    }
    throw err;
  }
}
