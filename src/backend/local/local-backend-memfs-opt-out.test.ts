import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GIT_MEMORY_ENABLED_TAG,
  LETTA_CODE_ORIGIN_TAG,
} from "@/agent/agent-tags";
import type { AgentCreateBody } from "@/backend";
import { settingsManager } from "@/settings-manager";
import { LocalBackend } from "./local-backend";
import type { LocalCompiledSystemPrompt } from "./system-prompt-compilation";

const originalHome = process.env.HOME;
let testHome: string;
let storageDir: string;

beforeEach(async () => {
  await settingsManager.reset();
  testHome = await mkdtemp(join(tmpdir(), "local-memfs-settings-"));
  storageDir = await mkdtemp(join(tmpdir(), "local-memfs-backend-"));
  process.env.HOME = testHome;
  await settingsManager.initialize();
});

afterEach(async () => {
  await settingsManager.reset();
  process.env.HOME = originalHome;
  await Promise.all([
    rm(testHome, { recursive: true, force: true }),
    rm(storageDir, { recursive: true, force: true }),
  ]);
});

function compiledPrompt(
  backend: LocalBackend,
  agentId: string,
): LocalCompiledSystemPrompt {
  const store = (
    backend as unknown as {
      store: {
        getCompiledSystemPrompt(
          conversationId: string,
          id: string,
        ): LocalCompiledSystemPrompt | undefined;
      };
    }
  ).store;
  const compiled = store.getCompiledSystemPrompt("default", agentId);
  if (!compiled) throw new Error("Expected a compiled system prompt");
  return compiled;
}

function createBody(tags?: string[]): AgentCreateBody {
  return {
    name: "Local memfs test",
    model: "anthropic/claude-sonnet-4-6",
    system: "System instructions\n\n{CORE_MEMORY}",
    ...(tags ? { tags } : {}),
  } as AgentCreateBody;
}

describe("LocalBackend per-agent memfs opt-out", () => {
  test("does not initialize or compile memfs for an explicit opt-out", async () => {
    const backend = new LocalBackend({ storageDir });
    const agent = await backend.createAgent(
      createBody([LETTA_CODE_ORIGIN_TAG]),
    );

    expect(agent.tags).not.toContain(GIT_MEMORY_ENABLED_TAG);
    expect(existsSync(join(storageDir, "memfs", agent.id, "memory"))).toBe(
      false,
    );
    expect(settingsManager.isMemfsExplicitlyDisabled(agent.id)).toBe(true);
    expect(compiledPrompt(backend, agent.id)).toMatchObject({
      memfsRevision: undefined,
    });
    expect(compiledPrompt(backend, agent.id).content).not.toContain("# Memory");
  });

  test("keeps local memfs enabled by default", async () => {
    const backend = new LocalBackend({ storageDir });
    const agent = await backend.createAgent(createBody());

    expect(agent.tags).toContain(GIT_MEMORY_ENABLED_TAG);
    expect(
      existsSync(join(storageDir, "memfs", agent.id, "memory", ".git")),
    ).toBe(true);
    expect(compiledPrompt(backend, agent.id).memfsRevision).toBeDefined();
    expect(compiledPrompt(backend, agent.id).content).toContain("# Memory");
  });
});
