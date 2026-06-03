/**
 * In-memory task store backing the Task* CRUD family.
 *
 * This powers TaskCreate / TaskGet / TaskList / TaskUpdate — the replacement
 * for the older stateless `TodoWrite` tool. Tasks have stable IDs, dependency
 * edges (blocks/blockedBy), optional owner, and a free-form metadata bag.
 *
 * Scope: process-lifetime. Same model as `process_manager.ts`'s background
 * task registry. A future follow-up may scope per-conversation.
 */

export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export interface TaskRecord {
  taskId: string;
  subject: string;
  description: string;
  activeForm?: string;
  status: TaskStatus;
  owner?: string;
  /** IDs of tasks this task blocks (i.e. those tasks can't start until this one finishes) */
  blocks: string[];
  /** IDs of tasks that block this task */
  blockedBy: string[];
  metadata: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

const tasks = new Map<string, TaskRecord>();
/** Stable insertion order for TaskList */
const insertionOrder: string[] = [];
let taskIdCounter = 1;

function nextTaskId(): string {
  return `task_${taskIdCounter++}`;
}

function cloneMetadata(
  meta: Record<string, string> | undefined,
): Record<string, string> {
  if (!meta) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (typeof k === "string" && typeof v === "string") {
      out[k] = v;
    }
  }
  return out;
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}

export interface CreateTaskInput {
  subject: string;
  description: string;
  activeForm?: string;
  metadata?: Record<string, string>;
}

export function createTask(input: CreateTaskInput): TaskRecord {
  const now = Date.now();
  const record: TaskRecord = {
    taskId: nextTaskId(),
    subject: input.subject,
    description: input.description,
    activeForm: input.activeForm,
    status: "pending",
    blocks: [],
    blockedBy: [],
    metadata: cloneMetadata(input.metadata),
    createdAt: now,
    updatedAt: now,
  };
  tasks.set(record.taskId, record);
  insertionOrder.push(record.taskId);
  return { ...record };
}

export function getTask(taskId: string): TaskRecord | undefined {
  const t = tasks.get(taskId);
  return t ? { ...t } : undefined;
}

export interface ListTasksOptions {
  includeDeleted?: boolean;
}

export function listTasks(options: ListTasksOptions = {}): TaskRecord[] {
  const out: TaskRecord[] = [];
  for (const id of insertionOrder) {
    const t = tasks.get(id);
    if (!t) continue;
    if (!options.includeDeleted && t.status === "deleted") continue;
    out.push({ ...t });
  }
  return out;
}

export interface UpdateTaskInput {
  taskId: string;
  status?: TaskStatus;
  subject?: string;
  description?: string;
  activeForm?: string;
  owner?: string;
  addBlocks?: string[];
  addBlockedBy?: string[];
  metadata?: Record<string, string>;
}

export class TaskNotFoundError extends Error {
  constructor(taskId: string) {
    super(`Task not found: ${taskId}`);
    this.name = "TaskNotFoundError";
  }
}

export function updateTask(input: UpdateTaskInput): TaskRecord {
  const existing = tasks.get(input.taskId);
  if (!existing) {
    throw new TaskNotFoundError(input.taskId);
  }

  if (input.status !== undefined) existing.status = input.status;
  if (input.subject !== undefined) existing.subject = input.subject;
  if (input.description !== undefined) existing.description = input.description;
  if (input.activeForm !== undefined) existing.activeForm = input.activeForm;
  if (input.owner !== undefined) existing.owner = input.owner;
  if (input.addBlocks && input.addBlocks.length > 0) {
    existing.blocks = dedupe([...existing.blocks, ...input.addBlocks]);
  }
  if (input.addBlockedBy && input.addBlockedBy.length > 0) {
    existing.blockedBy = dedupe([...existing.blockedBy, ...input.addBlockedBy]);
  }
  if (input.metadata) {
    // Merge (not replace) so partial updates don't clobber existing keys.
    existing.metadata = {
      ...existing.metadata,
      ...cloneMetadata(input.metadata),
    };
  }
  existing.updatedAt = Date.now();

  return { ...existing };
}

/** Test-only hook to reset state between unit tests. */
export function _resetTaskStoreForTests(): void {
  tasks.clear();
  insertionOrder.length = 0;
  taskIdCounter = 1;
}
