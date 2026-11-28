import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LettaAgentClient } from "@letta-ai/letta-agent-sdk";
import { __testSetBackend } from "@/backend";
import { LocalBackend } from "@/backend/local/local-backend";
import { TerminalSession } from "@/cli/app/terminal-session";
import { settingsManager } from "@/settings-manager";
import { removeTestDir } from "@/test-utils/test-fs";
import { startAppServer } from "@/websocket/app-server";

test("terminal session inspects context and toggles server skill links over WebSocket", async () => {
  const directory = await mkdtemp(join(tmpdir(), "terminal-inspection-"));
  const previous = process.env.LETTA_CONFIG_DIR;
  process.env.LETTA_CONFIG_DIR = directory;
  await settingsManager.reset();
  await settingsManager.initialize();
  const backend = new LocalBackend({
    storageDir: join(directory, "backend"),
    executionMode: "deterministic",
    memfsEnabled: false,
  });
  __testSetBackend(backend);
  const { id } = await backend.createAgent({ name: "Terminal test" });
  const skillDir = join(directory, "agents", id, "memory", "skills", "demo");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    "---\nname: demo\ndescription: Test skill\n---\nDemo",
  );
  const server = await startAppServer({ listen: "ws://127.0.0.1:0" });
  const client = new LettaAgentClient({
    backend: "remote",
    url: server.controlUrl,
  });
  const store = new TerminalSession(
    (canUseTool) => client.resumeSession(id, { canUseTool }),
    client,
  );
  const reading = store.connect();
  try {
    for (let i = 0; i < 100 && store.snapshot().status === "connecting"; i++)
      await Bun.sleep(25);
    expect(store.snapshot().status).toBe("online");
    await store.send("/context");
    expect(store.snapshot().commandOutput).toContain("System:");
    expect(store.snapshot().commandOutput).toContain("Messages:");
    await store.send("/skills");
    const entry = store
      .snapshot()
      .skills?.find((skill) => skill.name === "demo");
    expect(entry?.enabled).toBe(false);
    if (!entry) throw new Error("Missing test skill");
    await store.toggleSkill(entry.path);
    expect(
      store.snapshot().skills?.find((skill) => skill.name === "demo")?.enabled,
    ).toBe(true);
    await store.toggleSkill(entry.path);
    expect(
      store.snapshot().skills?.find((skill) => skill.name === "demo")?.enabled,
    ).toBe(false);
  } finally {
    store.close();
    await client.close();
    await server.close();
    await reading;
    __testSetBackend(null);
    if (previous === undefined) delete process.env.LETTA_CONFIG_DIR;
    else process.env.LETTA_CONFIG_DIR = previous;
    await settingsManager.reset();
    await removeTestDir(directory);
  }
}, 20000);
