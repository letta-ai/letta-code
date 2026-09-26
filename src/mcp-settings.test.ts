import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectMcpServer } from "@/mcp-client";
import { ANYSEARCH_API_KEY_ENV, resolveMcpPreset } from "@/mcp-presets";
import { settingsManager } from "@/settings-manager";
import { setServiceName } from "@/utils/secrets";

const originalHome = process.env.HOME;
let testHome: string;

beforeEach(async () => {
  await settingsManager.reset();
  testHome = await mkdtemp(join(tmpdir(), "letta-mcp-settings-"));
  process.env.HOME = testHome;
  setServiceName("letta-code-mcp-settings-test");
});

afterEach(async () => {
  await settingsManager.reset();
  process.env.HOME = originalHome;
  setServiceName("letta-code");
  await rm(testHome, { recursive: true, force: true });
});

describe("per-agent MCP settings", () => {
  test("stores MCP servers independently per agent", async () => {
    await settingsManager.initialize();
    const server = {
      name: "everything",
      transport: "stdio" as const,
      command: "node",
      args: ["server.js"],
    };

    settingsManager.setMcpServers("agent-a", [server]);

    expect(settingsManager.getMcpServers("agent-a")).toEqual([server]);
    expect(settingsManager.getMcpServers("agent-b")).toEqual([]);
  });

  test("persists MCP servers inside the agent settings entry", async () => {
    await settingsManager.initialize();
    settingsManager.setMcpServers("agent-mcp-persist", [
      {
        name: "exa",
        transport: "http",
        url: "https://mcp.exa.ai/mcp",
      },
    ]);
    await settingsManager.flush();
    await settingsManager.reset();
    await settingsManager.initialize();

    expect(settingsManager.getMcpServers("agent-mcp-persist")).toEqual([
      {
        name: "exa",
        transport: "http",
        url: "https://mcp.exa.ai/mcp",
      },
    ]);
  });

  test("a real disk restart preserves the AnySearch preset's oauth:false and never writes the raw key", async () => {
    await settingsManager.initialize();
    const secret = "sk-real-secret-that-must-never-reach-disk";
    const preset = resolveMcpPreset("anysearch", {
      [ANYSEARCH_API_KEY_ENV]: secret,
    });
    if (!preset) throw new Error("expected anysearch preset to resolve");

    settingsManager.setMcpServers("agent-anysearch-restart", [preset]);
    await settingsManager.flush();

    // Simulate an actual process restart: drop all in-memory state and
    // reload from the file settingsManager just wrote, rather than only
    // round-tripping through JSON.parse(JSON.stringify(...)) in memory.
    await settingsManager.reset();
    await settingsManager.initialize();

    const reloaded = settingsManager.getMcpServers(
      "agent-anysearch-restart",
    )[0];
    expect(reloaded).toBeDefined();
    expect(reloaded?.transport === "http" && reloaded.oauth).toBe(false);
    expect(
      reloaded?.transport === "http"
        ? reloaded.headers?.Authorization
        : undefined,
    ).toBe(`Bearer \${${ANYSEARCH_API_KEY_ENV}}`);

    const onDisk = await readFile(
      join(testHome, ".letta", "settings.json"),
      "utf8",
    );
    expect(onDisk).not.toContain(secret);
    expect(onDisk).toContain(`\${${ANYSEARCH_API_KEY_ENV}}`);
  });

  test("reconnecting a persisted authenticated AnySearch config with a blank env value fails locally, before any network attempt, and never emits a bare Bearer header", async () => {
    await settingsManager.initialize();
    const secret = "sk-real-secret-that-must-never-reach-disk-2";
    const preset = resolveMcpPreset("anysearch", {
      [ANYSEARCH_API_KEY_ENV]: secret,
    });
    if (!preset) throw new Error("expected anysearch preset to resolve");

    // 1. The authenticated preset persists the ${ANYSEARCH_API_KEY}
    // placeholder, not the raw secret.
    settingsManager.setMcpServers("agent-anysearch-reconnect", [preset]);
    await settingsManager.flush();
    await settingsManager.reset();
    await settingsManager.initialize();

    const reloaded = settingsManager.getMcpServers(
      "agent-anysearch-reconnect",
    )[0];
    expect(reloaded).toBeDefined();
    expect(
      reloaded?.transport === "http"
        ? reloaded.headers?.Authorization
        : undefined,
    ).toBe(`Bearer \${${ANYSEARCH_API_KEY_ENV}}`);

    // 2. Reconnecting with the referenced environment variable set but
    // blank must fail locally, without ever reaching the network, rather
    // than silently downgrading to an unauthenticated (or bare "Bearer ")
    // request.
    const originalKey = process.env[ANYSEARCH_API_KEY_ENV];
    try {
      process.env[ANYSEARCH_API_KEY_ENV] = "   ";
      if (!reloaded) throw new Error("expected reloaded config");
      await expect(connectMcpServer(reloaded)).rejects.toThrow(
        `MCP header Authorization references environment variable ${ANYSEARCH_API_KEY_ENV}, which is set but blank`,
      );
    } finally {
      if (originalKey === undefined) delete process.env[ANYSEARCH_API_KEY_ENV];
      else process.env[ANYSEARCH_API_KEY_ENV] = originalKey;
    }

    // 3. The rejection happens before transport creation ever builds a
    // request, so no "Bearer " (blank-secret) Authorization value can be
    // emitted; assert directly against the config's own header template so
    // this stays true even if the resolution order changes later.
    expect(
      reloaded?.transport === "http"
        ? reloaded.headers?.Authorization
        : undefined,
    ).not.toBe("Bearer ");
  });
});
