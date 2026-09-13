import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testSetBackend } from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import { createListenerModAdapter } from "@/websocket/listener/mod-adapter";
import {
  getListenerModCommand,
  listListenerModCommands,
  runListenerModCommand,
} from "@/websocket/listener/mod-commands";
import type {
  ConversationRuntime,
  ListenerRuntime,
} from "@/websocket/listener/types";

const tempRoots: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "letta-listener-modcmd-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  __testSetBackend(null);
  for (const dir of tempRoots.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function fakeConversationRuntime(
  listener: ListenerRuntime,
): ConversationRuntime {
  return {
    listener,
    agentId: "agent-1",
    conversationId: "conv-1",
    currentToolset: null,
  } as unknown as ConversationRuntime;
}

function fakeListener(
  modAdapter: ListenerRuntime["modAdapter"],
  bootWorkingDirectory: string,
): ListenerRuntime {
  return {
    modAdapter,
    workingDirectoryByConversation: new Map(),
    bootWorkingDirectory,
    permissionModeByConversation: new Map(),
  } as unknown as ListenerRuntime;
}

describe("listener mod commands", () => {
  test("advertises registered mod commands as descriptors", () => {
    const adapter = {
      getSnapshot: () => ({
        registry: {
          commands: {
            greet: { id: "greet", description: "Greets you", args: "<name>" },
            bye: { id: "bye", description: "Says bye" },
          },
        },
      }),
    } as unknown as ListenerRuntime["modAdapter"];
    const listener = fakeListener(adapter, "/tmp/project");

    expect(listListenerModCommands(listener)).toEqual([
      { id: "greet", description: "Greets you", args: "<name>" },
      { id: "bye", description: "Says bye" },
    ]);
    expect(getListenerModCommand(listener, "greet")).toMatchObject({
      id: "greet",
    });
    expect(getListenerModCommand(listener, "missing")).toBeUndefined();
  });

  test("returns no commands when no mod adapter is loaded", () => {
    const listener = fakeListener(undefined, "/tmp/project");
    expect(listListenerModCommands(listener)).toEqual([]);
    expect(getListenerModCommand(listener, "greet")).toBeUndefined();
  });

  test("runs a mod command and surfaces output and prompt results", async () => {
    __testSetBackend(
      new FakeHeadlessBackend(
        "agent-1",
        undefined,
        {},
        { modelHandle: "anthropic/claude-sonnet-4-6" },
      ),
    );
    const root = createTempDir();
    const modsDir = join(root, "mods");
    const cacheDir = join(root, "cache");
    mkdirSync(modsDir, { recursive: true });
    writeFileSync(
      join(modsDir, "greet.ts"),
      `export default function activate(letta) {
        letta.commands.register({
          id: "greet",
          description: "Greets with args and conversation id",
          args: "<name>",
          run(ctx) {
            return { type: "output", output: "hi " + ctx.args + " in " + ctx.conversation.id };
          },
        });
        letta.commands.register({
          id: "ask",
          description: "Returns a prompt",
          run(ctx) {
            return { type: "prompt", content: "do the thing: " + ctx.argv.join(",") };
          },
        });
      }`,
    );

    const adapter = createListenerModAdapter({
      cacheDirectory: cacheDir,
      globalModsDirectory: modsDir,
      sessionId: "conv-1",
      workingDirectory: root,
    });
    await adapter.reload();

    const runtime = fakeConversationRuntime(fakeListener(adapter, root));

    // The loaded command carries its args hint into the advertised descriptor.
    expect(listListenerModCommands(runtime.listener)).toContainEqual({
      id: "greet",
      description: "Greets with args and conversation id",
      args: "<name>",
    });

    const greet = getListenerModCommand(runtime.listener, "greet");
    if (!greet) throw new Error("greet command was not registered");
    const outputResult = await runListenerModCommand(runtime, greet, {
      commandId: "greet",
      args: "there",
      rawInput: "/greet there",
    });
    expect(outputResult).toEqual({
      type: "output",
      output: "hi there in conv-1",
    });

    const ask = getListenerModCommand(runtime.listener, "ask");
    if (!ask) throw new Error("ask command was not registered");
    const promptResult = await runListenerModCommand(runtime, ask, {
      commandId: "ask",
      args: "one two",
      rawInput: "/ask one two",
    });
    expect(promptResult).toEqual({
      type: "prompt",
      content: "do the thing: one,two",
    });

    adapter.dispose();
  });
});
