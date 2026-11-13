import { expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import * as memoryFilesystem from "@/agent/memory-filesystem";
import * as memoryGit from "@/agent/memory-git";
import * as modify from "@/agent/modify";
import { __testSetBackend, type Backend, getBackend } from "@/backend";
import * as memfsProxy from "@/backend/api/memfs-git-proxy";
import { settingsManager } from "@/settings-manager";
import { ensureMemfsSyncedForAgent } from "./memfs-sync";
import type { ListenerRuntime } from "./types";

test("skips subagent repair while repairing an ordinary agent on Letta Cloud", async () => {
  const retrieve = spyOn(getBackend(), "retrieveAgent").mockResolvedValue({
    id: "subagent",
    tags: ["role:subagent"],
  } as AgentState);
  const disabled = spyOn(
    settingsManager,
    "isMemfsExplicitlyDisabled",
  ).mockReturnValue(false);
  const cloud = spyOn(memoryFilesystem, "isLettaCloud").mockResolvedValue(true);
  const apply = spyOn(memoryFilesystem, "applyMemfsFlags").mockResolvedValue({
    action: "unchanged",
  });
  const checkout = spyOn(
    memoryFilesystem,
    "ensureLocalMemfsCheckout",
  ).mockResolvedValue();
  const listener = { memfsSyncedAgents: new Map() } as ListenerRuntime;
  try {
    expect(await ensureMemfsSyncedForAgent(listener, "subagent")).toBe(true);
    expect(apply).not.toHaveBeenCalled();
    retrieve.mockResolvedValue({
      id: "ordinary",
      tags: [],
    } as unknown as AgentState);
    expect(await ensureMemfsSyncedForAgent(listener, "ordinary")).toBe(true);
    expect(apply).toHaveBeenCalledWith("ordinary", true, {
      pullOnExistingRepo: true,
      throwOnPullFailure: true,
      agentTags: [],
    });
  } finally {
    retrieve.mockRestore();
    disabled.mockRestore();
    cloud.mockRestore();
    apply.mockRestore();
    checkout.mockRestore();
  }
});

test("a refused memory sync stays unavailable and is not retried", async () => {
  const retrieve = spyOn(getBackend(), "retrieveAgent").mockResolvedValue({
    id: "refused-clone",
    tags: [],
  } as unknown as AgentState);
  const disabled = spyOn(
    settingsManager,
    "isMemfsExplicitlyDisabled",
  ).mockReturnValue(false);
  const cloud = spyOn(memoryFilesystem, "isLettaCloud").mockResolvedValue(true);
  const apply = spyOn(memoryFilesystem, "applyMemfsFlags").mockRejectedValue(
    new Error("fatal: The requested URL returned error: 403"),
  );
  const listener = { memfsSyncedAgents: new Map() } as ListenerRuntime;
  try {
    expect(await ensureMemfsSyncedForAgent(listener, "refused-clone")).toBe(
      false,
    );
    expect(await ensureMemfsSyncedForAgent(listener, "refused-clone")).toBe(
      false,
    );
    expect(apply).toHaveBeenCalledTimes(1);
    const { isActiveMemfsEnabled, getActiveMemoryDirectory } = await import(
      "@/agent/memory-runtime"
    );
    expect(isActiveMemfsEnabled("refused-clone")).toBe(false);
    expect(getActiveMemoryDirectory("refused-clone")).toBeUndefined();
  } finally {
    retrieve.mockRestore();
    disabled.mockRestore();
    cloud.mockRestore();
    apply.mockRestore();
  }
});

test("listener sync preserves MemFS guards and detects refusals at the guarded Git operation", async () => {
  const backend = getBackend();
  const capabilities = {
    ...backend.capabilities,
    localMemfs: false,
    remoteMemfs: false,
  };
  let tags: string[] = ["git-memory-enabled"];
  __testSetBackend({
    capabilities,
    retrieveAgent: async (id: string) => ({ id, tags }),
  } as unknown as Backend);
  const disabled = spyOn(
    settingsManager,
    "isMemfsExplicitlyDisabled",
  ).mockReturnValue(false);
  const enabled = spyOn(settingsManager, "isMemfsEnabled").mockReturnValue(
    true,
  );
  const cloud = spyOn(memoryFilesystem, "isLettaCloud").mockResolvedValue(true);
  const server = spyOn(memfsProxy, "getMemfsServerUrl").mockReturnValue(
    "https://example.test",
  );
  const prompt = spyOn(
    modify,
    "updateAgentSystemPromptMemfs",
  ).mockResolvedValue({ success: false, message: "prompt repair failed" });
  const tag = spyOn(memoryGit, "addGitMemoryTag").mockResolvedValue();
  const repo = spyOn(memoryGit, "isGitRepo").mockReturnValue(false);
  const clone = spyOn(memoryGit, "cloneMemoryRepo").mockRejectedValue(
    new Error("HTTP 403"),
  );
  const pull = spyOn(memoryGit, "pullMemory").mockRejectedValue(
    new Error("HTTP 401"),
  );
  const listener = { memfsSyncedAgents: new Map() } as ListenerRuntime;
  try {
    // Tagged agents still respect the backend capability guard.
    expect(await ensureMemfsSyncedForAgent(listener, "guard-no-remote")).toBe(
      true,
    );
    expect(clone).not.toHaveBeenCalled();
    capabilities.remoteMemfs = true;
    tags = [];
    // Repair validates the endpoint, then reconciles the prompt, before Git.
    expect(await ensureMemfsSyncedForAgent(listener, "guard-endpoint")).toBe(
      false,
    );
    expect(prompt).not.toHaveBeenCalled();
    expect(clone).not.toHaveBeenCalled();
    server.mockReturnValue("https://api.letta.com");
    expect(await ensureMemfsSyncedForAgent(listener, "guard-prompt")).toBe(
      false,
    );
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(clone).not.toHaveBeenCalled();
    tags = ["git-memory-enabled"];
    clone.mockImplementation(async () => {
      expect(tag).toHaveBeenCalledWith("guard-clone", { tags });
      throw new Error("HTTP 403");
    });
    expect(await ensureMemfsSyncedForAgent(listener, "guard-clone")).toBe(
      false,
    );
    expect(await ensureMemfsSyncedForAgent(listener, "guard-clone")).toBe(
      false,
    );
    expect(clone).toHaveBeenCalledTimes(1);
    repo.mockReturnValue(true);
    expect(await ensureMemfsSyncedForAgent(listener, "guard-pull")).toBe(false);
    expect(await ensureMemfsSyncedForAgent(listener, "guard-pull")).toBe(false);
    expect(pull).toHaveBeenCalledTimes(1);
    expect(pull).toHaveBeenCalledWith("guard-pull", {
      throwOnFailure: true,
    });
  } finally {
    for (const stub of [
      disabled,
      enabled,
      cloud,
      server,
      prompt,
      tag,
      repo,
      clone,
      pull,
    ])
      stub.mockRestore();
    __testSetBackend(backend);
  }
});

test("only HTTP 403 removes a verified local memory checkout", async () => {
  const configDir = mkdtempSync(join(tmpdir(), "memfs-refusal-"));
  const previous = process.env.LETTA_CONFIG_DIR;
  process.env.LETTA_CONFIG_DIR = configDir;
  const retrieve = spyOn(getBackend(), "retrieveAgent").mockImplementation(
    async (id) =>
      ({
        id,
        tags: ["git-memory-enabled"],
      }) as AgentState,
  );
  const disabled = spyOn(
    settingsManager,
    "isMemfsExplicitlyDisabled",
  ).mockReturnValue(false);
  const apply = spyOn(memoryFilesystem, "applyMemfsFlags");
  try {
    for (const [suffix, error, remoteMatches, removed] of [
      ["403", "The requested URL returned error: 403", true, true],
      ["401", "HTTP 401", true, false],
      ["500", "HTTP 500", true, false],
      ["auth", "Authentication failed", true, false],
      ["other-origin", "HTTP 403", false, false],
    ] as const) {
      const id = `checkout-${suffix}`;
      const checkout = join(configDir, "agents", id, "memory");
      mkdirSync(checkout, { recursive: true });
      execFileSync("git", ["init", "--quiet", checkout]);
      execFileSync("git", [
        "-C",
        checkout,
        "remote",
        "add",
        "origin",
        `https://api.letta.com/v1/git/${remoteMatches ? id : "another-agent"}/state.git`,
      ]);
      writeFileSync(join(checkout, "stale.txt"), "stale");
      apply.mockRejectedValue(new Error(error));
      const listener = { memfsSyncedAgents: new Map() } as ListenerRuntime;
      expect(await ensureMemfsSyncedForAgent(listener, id)).toBe(false);
      expect(existsSync(checkout)).toBe(!removed);
    }
  } finally {
    retrieve.mockRestore();
    disabled.mockRestore();
    apply.mockRestore();
    if (previous === undefined) delete process.env.LETTA_CONFIG_DIR;
    else process.env.LETTA_CONFIG_DIR = previous;
    rmSync(configDir, { recursive: true, force: true });
  }
});
