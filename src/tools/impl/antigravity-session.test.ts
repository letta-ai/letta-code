import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runAntigravityTurn,
  sendAntigravityMessage,
} from "./antigravity-session";
import { persistNativeSessionOwner } from "./native-session-owner";

test("a different agent cannot resume or enqueue a turn on an owned Antigravity conversation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "letta-antigravity-owner-"));
  const configDir = process.env.LETTA_CONFIG_DIR;
  try {
    process.env.LETTA_CONFIG_DIR = dir;
    const id = randomUUID();
    persistNativeSessionOwner("antigravity", id, {
      agentId: "owner",
      conversationId: "conversation",
    });
    const options = {
      parentAgentId: "other",
      resumeSessionId: id,
      prompt: "continue",
      cwd: dir,
    };
    expect(() => sendAntigravityMessage(options, {}, {})).toThrow(
      "does not belong",
    );
    const result = await runAntigravityTurn(options, {}, {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("does not belong");
  } finally {
    if (configDir === undefined) delete process.env.LETTA_CONFIG_DIR;
    else process.env.LETTA_CONFIG_DIR = configDir;
    await rm(dir, { recursive: true, force: true });
  }
});
