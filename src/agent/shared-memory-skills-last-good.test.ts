import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateAmbientLettaTestEnv } from "@/test-utils/test-process-env";
import * as attachedRepositories from "./attached-repositories";
import * as memoryFilesystem from "./memory-filesystem";
import { getRepositoryMountDir } from "./memory-git";
import {
  invalidateAttachedRepositoriesCache,
  resolveSharedMemorySkillsContext,
} from "./shared-memory-skills";

let agentCounter = 0;
let agentId = "";
let tempHome = "";
let originalHome: string | undefined;
let restoreAmbientEnv: (() => void) | undefined;
let listSpy: ReturnType<
  typeof spyOn<typeof attachedRepositories, "listAttachedAgentRepositories">
>;
let cloudSpy: ReturnType<typeof spyOn<typeof memoryFilesystem, "isLettaCloud">>;

beforeEach(async () => {
  restoreAmbientEnv = isolateAmbientLettaTestEnv();
  originalHome = process.env.HOME;
  tempHome = await mkdtemp(join(tmpdir(), "letta-last-good-repos-"));
  process.env.HOME = tempHome;
  // Treat the backend as cloud so attached repositories are fetched.
  cloudSpy = spyOn(memoryFilesystem, "isLettaCloud").mockResolvedValue(true);
  // A fresh agent id per test keeps the process-global last-good map isolated.
  agentId = `agent-last-good-${Date.now()}-${agentCounter++}`;
  listSpy = spyOn(attachedRepositories, "listAttachedAgentRepositories");
});

afterEach(async () => {
  listSpy.mockRestore();
  cloudSpy.mockRestore();
  invalidateAttachedRepositoriesCache();
  restoreAmbientEnv?.();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await rm(tempHome, { recursive: true, force: true });
});

function resolve() {
  return resolveSharedMemorySkillsContext({
    agentId,
    skillSources: ["project"],
  });
}

function skillsDir(repositoryName: string): string {
  return join(getRepositoryMountDir(agentId, repositoryName), "skills");
}

test("keeps the last successful repository list when a refetch fails", async () => {
  listSpy.mockResolvedValueOnce([{ id: "repo-a", name: "team-a" }]);
  const first = await resolve();
  expect(first).toEqual({ skillsDirs: [skillsDir("team-a")], errors: [] });

  invalidateAttachedRepositoriesCache(agentId);
  listSpy.mockRejectedValueOnce(new Error("503 Service Unavailable"));
  const failed = await resolve();

  expect(failed.skillsDirs).toEqual([skillsDir("team-a")]);
  expect(failed.errors).toEqual([
    {
      path: `shared-memory:${agentId}`,
      message: "Failed to list attached repositories: 503 Service Unavailable",
    },
  ]);
});

test("returns no dirs and an error when the first fetch fails", async () => {
  listSpy.mockRejectedValueOnce(new Error("network down"));
  const result = await resolve();

  expect(result).toEqual({
    skillsDirs: [],
    errors: [
      {
        path: `shared-memory:${agentId}`,
        message: "Failed to list attached repositories: network down",
      },
    ],
  });
});

test("a later successful response still removes a detached repository", async () => {
  listSpy.mockResolvedValueOnce([
    { id: "repo-a", name: "team-a" },
    { id: "repo-b", name: "team-b" },
  ]);
  await resolve();

  invalidateAttachedRepositoriesCache(agentId);
  listSpy.mockResolvedValueOnce([{ id: "repo-b", name: "team-b" }]);
  const detached = await resolve();
  expect(detached).toEqual({ skillsDirs: [skillsDir("team-b")], errors: [] });

  // A failure after the detach falls back to the shrunken list, not the old one.
  invalidateAttachedRepositoriesCache(agentId);
  listSpy.mockRejectedValueOnce(new Error("timeout"));
  const failed = await resolve();
  expect(failed.skillsDirs).toEqual([skillsDir("team-b")]);
  expect(failed.errors).toHaveLength(1);
});
