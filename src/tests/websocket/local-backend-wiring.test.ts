import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function source(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)),
    "utf-8",
  );
}

describe("websocket listener local backend wiring", () => {
  test("turn and recovery paths use the active backend abstraction", () => {
    const turn = source("websocket/listener/turn.ts");
    const send = source("websocket/listener/send.ts");
    const recovery = source("websocket/listener/recovery.ts");
    const warmup = source("websocket/listener/warmup.ts");
    const memfsSync = source("websocket/listener/memfs-sync.ts");

    for (const file of [turn, send, recovery, warmup, memfsSync]) {
      expect(file).not.toContain("../../backend/api/client");
      expect(file).not.toContain("client.agents.retrieve");
    }

    expect(turn).toContain("getBackend().retrieveAgent");
    expect(turn).toContain("getResumeDataFromBackend");
    expect(send).toContain("getResumeDataFromBackend");
    expect(recovery).toContain("getResumeDataFromBackend");
    expect(warmup).toContain("getBackend().retrieveAgent");
    expect(memfsSync).toContain("getBackend().retrieveAgent");
  });

  test("remote clear command creates conversations through the active backend", () => {
    const commands = source("websocket/listener/commands.ts");
    const start = commands.indexOf("async function handleClearCommand");
    expect(start).toBeGreaterThanOrEqual(0);
    const end = commands.indexOf("async function handleDoctorCommand", start);
    expect(end).toBeGreaterThan(start);
    const clearCommand = commands.slice(start, end);

    expect(clearCommand).toContain("const backend = getBackend();");
    expect(clearCommand).toContain("await backend.createConversation({");
    expect(clearCommand).toContain("!backend.capabilities.localModelCatalog");
    expect(clearCommand).not.toContain("client.conversations.create");
  });

  test("memory write commands use local-only git sync for local memfs backends", () => {
    const memoryCommands = source("websocket/listener/commands/memory.ts");

    expect(memoryCommands).toContain("backend.capabilities.localMemfs");
    expect(memoryCommands).toContain("!backend.capabilities.remoteMemfs");
    expect(memoryCommands).toContain("syncMode: memorySyncMode");
    expect(memoryCommands).not.toContain("backend/api/client");
  });
});
