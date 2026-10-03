import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __agentModOverridesTestUtils,
  readAgentModOverrides,
} from "@/mods/agent-mod-overrides";
import { clearModTools } from "@/mods/tool-registry";
import { handleModsCommand } from "./commands-mods";
import {
  __listenerModAdapterTestUtils,
  disposeListenerModAdapter,
} from "./mod-adapter";
import { emitListenerTurnStart } from "./turn-events";
import type { ConversationRuntime, ListenerRuntime } from "./types";

// LET-12868: a custom turn_start guard that explicitly cancels when its
// bootstrap dependency is missing locks the agent out of every turn.

const tempRoots: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "letta-turn-start-lockout-"));
  tempRoots.push(dir);
  return dir;
}

const GUARD_REASON =
  "sandbox bootstrap failed, so GitHub identity routing is not guaranteed; turn cancelled";

function writeAgentMods(modsDirectory: string): void {
  mkdirSync(modsDirectory, { recursive: true });
  // An identity guard whose bootstrap dependency is missing, so it cancels.
  writeFileSync(
    join(modsDirectory, "bootstrap-guard.ts"),
    `import { existsSync } from "node:fs";
    export default function activate(letta) {
      letta.events.on("turn_start", () => {
        if (!existsSync("/definitely/missing/bootstrap.sh")) {
          return { cancel: { reason: ${JSON.stringify(GUARD_REASON)} } };
        }
      });
    }`,
  );
  // A mod that throws must keep being treated as a diagnostic, not a cancel.
  writeFileSync(
    join(modsDirectory, "throwing.ts"),
    `export default function activate(letta) {
      letta.events.on("turn_start", () => {
        throw new Error("throwing mod");
      });
    }`,
  );
}

function createListener(root: string): ListenerRuntime {
  return {
    agentModAdapters: new Map(),
    agentModAdapterLoads: new Map(),
    bootWorkingDirectory: root,
    sessionId: "turn-start-lockout-test",
  } as unknown as ListenerRuntime;
}

function userInput(text: string) {
  return [
    {
      role: "user" as const,
      content: [{ type: "text" as const, text }],
    },
  ];
}

let root: string;
let modsDirectory: string;

beforeEach(() => {
  root = createTempDir();
  modsDirectory = join(root, "agent-memory", "mods");
  writeAgentMods(modsDirectory);
  __listenerModAdapterTestUtils.setEnsureMemfsSyncedForAgentForTests(
    async () => true,
  );
  __listenerModAdapterTestUtils.setAgentModsDirectoryResolverForTests(
    () => modsDirectory,
  );
  __listenerModAdapterTestUtils.setAgentModCacheDirectoryResolverForTests(() =>
    join(root, "agent-cache"),
  );
  __agentModOverridesTestUtils.setRootForTests(join(root, "overrides"));
});

afterEach(() => {
  __listenerModAdapterTestUtils.resetForTests();
  __agentModOverridesTestUtils.setRootForTests(null);
  clearModTools();
  for (const dir of tempRoots.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("turn_start lockout recovery (LET-12868)", () => {
  test("an explicit cancel blocks every turn and names the offending mod", async () => {
    const listener = createListener(root);
    for (const text of ["Ping", "Ping again"]) {
      const emission = await emitListenerTurnStart({
        agentId: "agent-locked",
        conversationId: "conv-locked",
        input: userInput(text),
        runtime: listener,
        workingDirectory: root,
      });
      expect(emission.cancelled).toBe(true);
      if (!emission.cancelled) throw new Error("expected cancellation");
      expect(emission.reason).toContain(GUARD_REASON);
      // The user has to be able to tell which mod did it and where it lives.
      expect(emission.cancelledBy?.path).toBe(
        join(modsDirectory, "bootstrap-guard.ts"),
      );
      expect(emission.cancelledBy?.scope).toBe("agent");
    }
    disposeListenerModAdapter(listener);
  });

  test("/mods disable recovers the agent without a turn and leaves the mod file alone", async () => {
    const listener = createListener(root);
    const conversation = {
      agentId: "agent-locked",
      conversationId: "conv-locked",
      listener,
    } as unknown as ConversationRuntime;
    const guardPath = join(modsDirectory, "bootstrap-guard.ts");
    const guardSource = readFileSync(guardPath, "utf8");

    const before = await emitListenerTurnStart({
      agentId: "agent-locked",
      conversationId: "conv-locked",
      input: userInput("Ping"),
      runtime: listener,
      workingDirectory: root,
    });
    expect(before.cancelled).toBe(true);

    // Out-of-turn recovery: no turn has to succeed for this to run.
    const disabled = await handleModsCommand(
      conversation,
      "disable bootstrap-guard missing bootstrap script",
      "user-ethan",
    );
    expect(disabled.success).toBe(true);
    expect(readAgentModOverrides("agent-locked")).toEqual([
      expect.objectContaining({
        file: "bootstrap-guard.ts",
        disabledBy: "user-ethan",
        reason: "missing bootstrap script",
      }),
    ]);

    for (const text of ["Ping", "Ping again"]) {
      const after = await emitListenerTurnStart({
        agentId: "agent-locked",
        conversationId: "conv-locked",
        input: userInput(text),
        runtime: listener,
        workingDirectory: root,
      });
      expect(after.cancelled).toBe(false);
    }
    // Source and history are untouched.
    expect(readFileSync(guardPath, "utf8")).toBe(guardSource);

    const listed = await handleModsCommand(conversation, "list", null);
    expect(listed.output).toContain("disabled  bootstrap-guard.ts");
    expect(listed.output).toContain("user-ethan");
    expect(listed.output).toContain("enabled   throwing.ts");

    // Re-enabling restores the guard's cancellation.
    const enabled = await handleModsCommand(
      conversation,
      "enable bootstrap-guard.ts",
      "user-ethan",
    );
    expect(enabled.success).toBe(true);
    const reenabled = await emitListenerTurnStart({
      agentId: "agent-locked",
      conversationId: "conv-locked",
      input: userInput("Ping"),
      runtime: listener,
      workingDirectory: root,
    });
    expect(reenabled.cancelled).toBe(true);
    disposeListenerModAdapter(listener);
  });

  test("/mods disable recovers even when the listener's global mods fail to reload", async () => {
    const listener = createListener(root);
    let globalReloads = 0;
    listener.modAdapter = {
      dispose: () => {},
      events: {
        hasHandlers: () => false,
        emit: async (name: string) => ({
          diagnostics: [],
          handlerCount: 0,
          name,
          results: [],
        }),
      },
      reload: async () => {
        globalReloads += 1;
        throw new Error("broken global mod");
      },
    } as unknown as ListenerRuntime["modAdapter"];
    const conversation = {
      agentId: "agent-locked",
      conversationId: "conv-locked",
      listener,
    } as unknown as ConversationRuntime;
    const turn = () =>
      emitListenerTurnStart({
        agentId: "agent-locked",
        conversationId: "conv-locked",
        input: userInput("Ping"),
        runtime: listener,
        workingDirectory: root,
      });

    expect((await turn()).cancelled).toBe(true);
    const disabled = await handleModsCommand(
      conversation,
      "disable bootstrap-guard.ts",
      null,
    );
    expect(disabled.success).toBe(true);
    expect(globalReloads).toBe(0);
    expect((await turn()).cancelled).toBe(false);
    disposeListenerModAdapter(listener);
  });

  test("disabling is scoped to one agent", async () => {
    const listener = createListener(root);
    const conversation = {
      agentId: "agent-locked",
      conversationId: "conv-locked",
      listener,
    } as unknown as ConversationRuntime;
    await handleModsCommand(conversation, "disable bootstrap-guard.ts", null);

    const other = await emitListenerTurnStart({
      agentId: "agent-other",
      conversationId: "conv-other",
      input: userInput("Ping"),
      runtime: listener,
      workingDirectory: root,
    });
    expect(other.cancelled).toBe(true);
    disposeListenerModAdapter(listener);
  });

  test("a thrown handler error stays a diagnostic and never cancels", async () => {
    rmSync(join(modsDirectory, "bootstrap-guard.ts"));
    const listener = createListener(root);
    const emission = await emitListenerTurnStart({
      agentId: "agent-throwing",
      conversationId: "conv-throwing",
      input: userInput("Ping"),
      runtime: listener,
      workingDirectory: root,
    });
    expect(emission.cancelled).toBe(false);
    disposeListenerModAdapter(listener);
  });

  test("an unknown mod name is rejected without writing an override", async () => {
    const listener = createListener(root);
    const conversation = {
      agentId: "agent-locked",
      conversationId: "conv-locked",
      listener,
    } as unknown as ConversationRuntime;
    const result = await handleModsCommand(
      conversation,
      "disable ../../etc/passwd",
      null,
    );
    expect(result.success).toBe(false);
    expect(readAgentModOverrides("agent-locked")).toEqual([]);
    disposeListenerModAdapter(listener);
  });
});
