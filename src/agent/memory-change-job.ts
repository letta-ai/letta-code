import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type MemoryChangeJobStatus =
  | "queued"
  | "drafting"
  | "proposed"
  | "integrating"
  | "syncing"
  | "applied"
  | "noop"
  | "needs_clarification"
  | "needs_review"
  | "failed_retryable"
  | "failed_terminal";

export type MemoryChangeJobSource =
  | "remember"
  | "slash-remember"
  | "task-memory";

export interface MemoryChangeJob {
  jobId: string;
  agentId: string;
  conversationId: string;
  instruction: string;
  source: MemoryChangeJobSource;
  sourceId?: string;
  status: MemoryChangeJobStatus;
  createdAt: string;
  updatedAt: string;
  baseHead?: string;
  proposalHead?: string;
  worktreeDir?: string;
  branchName?: string;
  affectedPaths?: string[];
  childAgentId?: string;
  childConversationId?: string;
  error?: string;
  summary?: string;
  patchPath?: string;
  retryCount: number;
}

export function memoryJobsDir(memoryDir: string): string {
  return join(dirname(memoryDir), "memory-jobs");
}

export function memoryJobPath(memoryDir: string, jobId: string): string {
  return join(memoryJobsDir(memoryDir), `${jobId}.json`);
}

export async function saveMemoryChangeJob(
  memoryDir: string,
  job: MemoryChangeJob,
): Promise<void> {
  const directory = memoryJobsDir(memoryDir);
  await mkdir(directory, { recursive: true });
  const payload: MemoryChangeJob = {
    ...job,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(
    memoryJobPath(memoryDir, job.jobId),
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );
}

export async function loadMemoryChangeJob(
  memoryDir: string,
  jobId: string,
): Promise<MemoryChangeJob | null> {
  try {
    const raw = await readFile(memoryJobPath(memoryDir, jobId), "utf8");
    return JSON.parse(raw) as MemoryChangeJob;
  } catch {
    return null;
  }
}

export async function listMemoryChangeJobs(
  memoryDir: string,
): Promise<MemoryChangeJob[]> {
  try {
    const entries = await readdir(memoryJobsDir(memoryDir));
    const jobs: MemoryChangeJob[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const job = await loadMemoryChangeJob(memoryDir, entry.slice(0, -5));
      if (job) jobs.push(job);
    }
    return jobs.sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
  } catch {
    return [];
  }
}

export async function deleteMemoryChangeJob(
  memoryDir: string,
  jobId: string,
): Promise<void> {
  await unlink(memoryJobPath(memoryDir, jobId)).catch(() => {});
}

export function createMemoryChangeJob(params: {
  jobId: string;
  agentId: string;
  conversationId: string;
  instruction: string;
  source: MemoryChangeJobSource;
  sourceId?: string;
}): MemoryChangeJob {
  const now = new Date().toISOString();
  return {
    jobId: params.jobId,
    agentId: params.agentId,
    conversationId: params.conversationId,
    instruction: params.instruction,
    source: params.source,
    sourceId: params.sourceId,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    retryCount: 0,
  };
}

export function isTerminalMemoryChangeJobStatus(
  status: MemoryChangeJobStatus,
): boolean {
  return (
    status === "applied" ||
    status === "noop" ||
    status === "needs_clarification" ||
    status === "needs_review" ||
    status === "failed_terminal"
  );
}
