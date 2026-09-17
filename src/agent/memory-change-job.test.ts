import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMemoryChangeJob,
  isTerminalMemoryChangeJobStatus,
  listMemoryChangeJobs,
  loadMemoryChangeJob,
  saveMemoryChangeJob,
} from "@/agent/memory-change-job";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("memory change jobs", () => {
  test("persists and reloads a job next to the memory repo", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memory-change-job-"));
    const memoryDir = join(tempDir, "memory");
    const job = createMemoryChangeJob({
      jobId: "job-1",
      agentId: "agent-1",
      conversationId: "conv-1",
      instruction: "Remember that the user prefers bun",
      source: "remember",
    });

    await saveMemoryChangeJob(memoryDir, job);
    const loaded = await loadMemoryChangeJob(memoryDir, "job-1");

    expect(loaded?.jobId).toBe("job-1");
    expect(loaded?.instruction).toContain("bun");
    expect(loaded?.status).toBe("queued");
    expect(isTerminalMemoryChangeJobStatus("queued")).toBe(false);
    expect(isTerminalMemoryChangeJobStatus("applied")).toBe(true);

    const listed = await listMemoryChangeJobs(memoryDir);
    expect(listed).toHaveLength(1);
  });
});
