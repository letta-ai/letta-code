import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { __testSetBackend, type Backend } from "@/backend";
import { settingsManager } from "@/settings-manager";
import { setServiceName } from "@/utils/secrets";
import {
  __testSetCurrentUserMetadataFetcher,
  generateFavoriteTag,
  LOCAL_DESKTOP_FAVORITE_TAG,
  pinAgentForCurrentUser,
  unpinAgentForCurrentUser,
} from "./favorites";

const originalHome = process.env.HOME;

let testHomeDir: string;

function agentWithTags(id: string, tags: string[]): AgentState {
  return { id, name: id, tags } as AgentState;
}

function installBackend(agent: AgentState) {
  let currentAgent = agent;
  const retrieveAgent = mock(async () => currentAgent);
  const updateAgent = mock(
    async (_agentId: string, body: { tags?: string[] }) => {
      currentAgent = {
        ...currentAgent,
        ...(body.tags ? { tags: body.tags } : {}),
      };
      return currentAgent;
    },
  );

  __testSetBackend({
    retrieveAgent,
    updateAgent,
  } as unknown as Backend);

  return {
    retrieveAgent,
    updateAgent,
    getAgent: () => currentAgent,
  };
}

beforeEach(async () => {
  setServiceName("letta-code-test");
  await settingsManager.reset();
  testHomeDir = await mkdtemp(join(tmpdir(), "letta-favorites-test-home-"));
  process.env.HOME = testHomeDir;
  await settingsManager.initialize();
});

afterEach(async () => {
  __testSetBackend(null);
  __testSetCurrentUserMetadataFetcher(null);
  await settingsManager.reset();
  await rm(testHomeDir, { recursive: true, force: true });
  process.env.HOME = originalHome;
  setServiceName("letta-code");
});

describe("favorite-backed pinning", () => {
  test("pins local agents by adding the local favorite tag", async () => {
    const backend = installBackend(
      agentWithTags("agent-local-1", ["existing"]),
    );

    const status = await pinAgentForCurrentUser("agent-local-1");

    expect(status).toBe("pinned");
    expect(backend.getAgent().tags).toEqual([
      LOCAL_DESKTOP_FAVORITE_TAG,
      "existing",
    ]);
    expect(settingsManager.isAgentPinned("agent-local-1")).toBe(false);
  });

  test("pins cloud agents with the current user favorite tag", async () => {
    __testSetCurrentUserMetadataFetcher(async () => ({ id: "user-1" }));
    const backend = installBackend(agentWithTags("agent-cloud-1", []));

    const status = await pinAgentForCurrentUser("agent-cloud-1");

    expect(status).toBe("pinned");
    expect(backend.getAgent().tags).toEqual([generateFavoriteTag("user-1")]);
    expect(settingsManager.isAgentPinned("agent-cloud-1")).toBe(false);
  });

  test("falls back to settings pins when cloud user lookup is unavailable", async () => {
    __testSetCurrentUserMetadataFetcher(async () => ({}));
    const backend = installBackend(agentWithTags("agent-cloud-1", []));

    const status = await pinAgentForCurrentUser("agent-cloud-1");

    expect(status).toBe("pinned");
    expect(backend.updateAgent).not.toHaveBeenCalled();
    expect(settingsManager.isAgentPinned("agent-cloud-1")).toBe(true);
  });

  test("unpins both favorite tags and legacy settings pins", async () => {
    const agentId = "agent-local-1";
    settingsManager.pinAgent(agentId);
    const backend = installBackend(
      agentWithTags(agentId, [LOCAL_DESKTOP_FAVORITE_TAG, "existing"]),
    );

    const status = await unpinAgentForCurrentUser(agentId);

    expect(status).toBe("unpinned");
    expect(backend.getAgent().tags).toEqual(["existing"]);
    expect(settingsManager.isAgentPinned(agentId)).toBe(false);
  });
});
