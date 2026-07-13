import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testSetBackend } from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import { clearRegisteredPiProviders } from "@/backend/dev/pi-provider-mod-registry";
import { clearModTools, getModToolDefinition } from "@/mods/tool-registry";
import {
  clearCapturedToolExecutionContexts,
  executeTool,
} from "@/tools/manager";
import { prepareToolExecutionContextForScope } from "@/tools/toolset";
import {
  __listenerModAdapterTestUtils,
  createListenerModAdapter,
  disposeListenerModAdapter,
  ensureListenerAgentModAdapter,
} from "./mod-adapter";
import { listListenerModCommands } from "./mod-commands";
import type { ListenerRuntime } from "./types";

const tempRoots: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "letta-listener-agent-mod-"));
  tempRoots.push(dir);
  return dir;
}

function useFakeAgent(agentId: string): void {
  __testSetBackend(
    new FakeHeadlessBackend(
      agentId,
      undefined,
      {},
      {
        modelHandle: "anthropic/claude-sonnet-4-6",
      },
    ),
  );
}

afterEach(() => {
  __listenerModAdapterTestUtils.resetForTests();
  clearModTools();
  clearRegisteredPiProviders();
  clearCapturedToolExecutionContexts();
  __testSetBackend(null);
  for (const dir of tempRoots.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("listener agent-scoped mods", () => {
  test("isolates MemFS mods in turn snapshots and reloads them cleanly", async () => {
    const root = createTempDir();
    const globalModsDir = join(root, "global-mods");
    const agentARoot = join(root, "agent-a-memory");
    const agentBRoot = join(root, "agent-b-memory");
    const agentAModsDir = join(agentARoot, "mods");
    const agentBModsDir = join(agentBRoot, "mods");
    mkdirSync(globalModsDir, { recursive: true });
    mkdirSync(agentAModsDir, { recursive: true });
    mkdirSync(agentBModsDir, { recursive: true });

    writeFileSync(
      join(globalModsDir, "shared.ts"),
      `export default function activate(letta) {
        letta.tools.register({
          name: "shared_listener_tool",
          description: "Available to every listener agent",
          parameters: { type: "object", properties: {} },
          requiresApproval: false,
          run() { return "shared"; },
        });
      }`,
    );
    const writeAgentMod = (
      directory: string,
      toolName: string,
      result: string,
    ) => {
      writeFileSync(
        join(directory, "agent-tool.ts"),
        `export default function activate(letta) {
          letta.tools.register({
            name: "${toolName}",
            description: "Agent-scoped listener tool",
            parameters: { type: "object", properties: {} },
            requiresApproval: false,
            run() { return "${result}"; },
          });
        }`,
      );
    };
    writeAgentMod(agentAModsDir, "agent_a_only", "agent-a");
    writeAgentMod(agentBModsDir, "agent_b_only", "agent-b");

    execFileSync("git", ["init", "-q"], { cwd: agentARoot });
    execFileSync("git", ["add", "mods/agent-tool.ts"], { cwd: agentARoot });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Listener Test",
        "-c",
        "user.email=listener@example.com",
        "commit",
        "-qm",
        "initial mod",
      ],
      { cwd: agentARoot },
    );

    const globalAdapter = createListenerModAdapter({
      cacheDirectory: join(root, "global-cache"),
      globalModsDirectory: globalModsDir,
    });
    const agentAAdapter = createListenerModAdapter({
      agentModsDirectory: agentAModsDir,
      cacheDirectory: join(root, "agent-a-cache"),
      includeGlobalMods: false,
      registerCapabilitiesGlobally: false,
    });
    const agentBAdapter = createListenerModAdapter({
      agentModsDirectory: agentBModsDir,
      cacheDirectory: join(root, "agent-b-cache"),
      includeGlobalMods: false,
      registerCapabilitiesGlobally: false,
    });
    await Promise.all([
      globalAdapter.reload(),
      agentAAdapter.reload(),
      agentBAdapter.reload(),
    ]);

    expect(getModToolDefinition("agent_a_only")).toBeUndefined();
    expect(getModToolDefinition("agent_b_only")).toBeUndefined();
    expect(
      execFileSync("git", ["status", "--porcelain"], {
        cwd: agentARoot,
        encoding: "utf8",
      }),
    ).toBe("");

    useFakeAgent("agent-a");
    const preparedA = await prepareToolExecutionContextForScope({
      agentId: "agent-a",
      conversationId: "default",
      clientToolAllowlist: [
        "shared_listener_tool",
        "agent_a_only",
        "agent_b_only",
      ],
      modAdapters: [globalAdapter, agentAAdapter],
    });
    expect(preparedA.preparedToolContext.loadedToolNames).toEqual([
      "shared_listener_tool",
      "agent_a_only",
    ]);
    expect(
      await executeTool(
        "agent_a_only",
        {},
        {
          toolContextId: preparedA.preparedToolContext.contextId,
        },
      ),
    ).toMatchObject({ status: "success", toolReturn: "agent-a" });

    useFakeAgent("agent-b");
    const preparedB = await prepareToolExecutionContextForScope({
      agentId: "agent-b",
      conversationId: "default",
      clientToolAllowlist: [
        "shared_listener_tool",
        "agent_a_only",
        "agent_b_only",
      ],
      modAdapters: [globalAdapter, agentBAdapter],
    });
    expect(preparedB.preparedToolContext.loadedToolNames).toEqual([
      "shared_listener_tool",
      "agent_b_only",
    ]);

    writeAgentMod(agentAModsDir, "agent_a_reloaded", "agent-a-reloaded");
    execFileSync("git", ["add", "mods/agent-tool.ts"], { cwd: agentARoot });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Listener Test",
        "-c",
        "user.email=listener@example.com",
        "commit",
        "-qm",
        "reload mod",
      ],
      { cwd: agentARoot },
    );
    await agentAAdapter.reload();

    useFakeAgent("agent-a");
    const reloadedA = await prepareToolExecutionContextForScope({
      agentId: "agent-a",
      conversationId: "default",
      clientToolAllowlist: ["agent_a_only", "agent_a_reloaded"],
      modAdapters: [globalAdapter, agentAAdapter],
    });
    expect(reloadedA.preparedToolContext.loadedToolNames).toEqual([
      "agent_a_reloaded",
    ]);
    expect(
      execFileSync("git", ["status", "--porcelain"], {
        cwd: agentARoot,
        encoding: "utf8",
      }),
    ).toBe("");

    globalAdapter.dispose();
    agentAAdapter.dispose();
    agentBAdapter.dispose();
  });

  test("producer caches a separate adapter and command set per agent", async () => {
    const root = createTempDir();
    const agentADir = join(root, "agent-a", "mods");
    const agentBDir = join(root, "agent-b", "mods");
    mkdirSync(agentADir, { recursive: true });
    mkdirSync(agentBDir, { recursive: true });
    const writeIdentityMod = (directory: string, agent: "a" | "b"): void => {
      writeFileSync(
        join(directory, "identity.js"),
        `export default function activate(letta) {
          letta.tools.register({
            name: "agent_${agent}_identity",
            description: "Agent ${agent.toUpperCase()} identity",
            parameters: { type: "object", properties: {} },
            run() { return "${agent}"; },
          });
          letta.commands.register({
            id: "agent-${agent}-command",
            description: "Agent ${agent.toUpperCase()} command",
            run() { return "${agent}"; },
          });
        }`,
      );
    };
    writeIdentityMod(agentADir, "a");
    writeIdentityMod(agentBDir, "b");
    __listenerModAdapterTestUtils.setAgentModsDirectoryResolverForTests(
      (agentId) =>
        agentId === "agent-a"
          ? agentADir
          : agentId === "agent-b"
            ? agentBDir
            : null,
    );
    const listener = {
      agentModAdapters: new Map(),
      agentModAdapterLoads: new Map(),
      bootWorkingDirectory: root,
      sessionId: "listener-isolation-test",
    } as unknown as ListenerRuntime;

    const [agentAAdapter, duplicateAgentAAdapter, agentBAdapter] =
      await Promise.all([
        ensureListenerAgentModAdapter(listener, "agent-a"),
        ensureListenerAgentModAdapter(listener, "agent-a"),
        ensureListenerAgentModAdapter(listener, "agent-b"),
      ]);

    expect(agentAAdapter).not.toBeNull();
    expect(duplicateAgentAAdapter).toBe(agentAAdapter);
    expect(agentBAdapter).not.toBeNull();
    expect(agentBAdapter).not.toBe(agentAAdapter);
    expect(
      Object.keys(agentAAdapter?.getSnapshot().registry.tools ?? {}),
    ).toEqual(["agent_a_identity"]);
    expect(
      Object.keys(agentBAdapter?.getSnapshot().registry.tools ?? {}),
    ).toEqual(["agent_b_identity"]);
    expect(getModToolDefinition("agent_a_identity")).toBeUndefined();
    expect(getModToolDefinition("agent_b_identity")).toBeUndefined();
    expect(listListenerModCommands(listener, "agent-a")).toEqual([
      { id: "agent-a-command", description: "Agent A command" },
    ]);
    expect(listListenerModCommands(listener, "agent-b")).toEqual([
      { id: "agent-b-command", description: "Agent B command" },
    ]);

    disposeListenerModAdapter(listener);
    expect(listener.agentModAdapters?.size).toBe(0);
  });
});
