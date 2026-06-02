import { createTask, type TaskRecord } from "./tasks/store.js";
import { validateRequiredParams } from "./validation.js";

interface TaskCreateArgs {
  subject?: string;
  description?: string;
  activeForm?: string;
  metadata?: Record<string, string>;
}

export async function task_create(args: TaskCreateArgs): Promise<TaskRecord> {
  validateRequiredParams(args, ["subject", "description"], "TaskCreate");
  if (typeof args.subject !== "string" || args.subject.length === 0) {
    throw new Error("TaskCreate: 'subject' must be a non-empty string");
  }
  if (typeof args.description !== "string" || args.description.length === 0) {
    throw new Error("TaskCreate: 'description' must be a non-empty string");
  }
  if (args.activeForm !== undefined && typeof args.activeForm !== "string") {
    throw new Error("TaskCreate: 'activeForm' must be a string");
  }
  if (args.metadata !== undefined) {
    if (
      typeof args.metadata !== "object" ||
      args.metadata === null ||
      Array.isArray(args.metadata)
    ) {
      throw new Error("TaskCreate: 'metadata' must be an object");
    }
    for (const [k, v] of Object.entries(args.metadata)) {
      if (typeof v !== "string") {
        throw new Error(
          `TaskCreate: metadata['${k}'] must be a string, received ${typeof v}`,
        );
      }
    }
  }

  return createTask({
    subject: args.subject,
    description: args.description,
    activeForm: args.activeForm,
    metadata: args.metadata,
  });
}
