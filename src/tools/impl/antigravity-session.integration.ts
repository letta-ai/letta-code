import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendAntigravityMessage } from "./antigravity-session";
import { runExternalCodingAgent } from "./external-coding-agent";

test("Antigravity writes a file and resumes native conversation history", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "letta-antigravity-"));
  const parentAgentId = `local-${randomUUID()}`;
  const token = randomUUID();
  const tools: string[] = [];
  try {
    const first = await runExternalCodingAgent({
      type: "antigravity",
      cwd,
      parentAgentId,
      prompt: `Remember ${token}. Write the single word ready to proof.txt. Reply DONE.`,
      onToolCall: (tool) => tools.push(tool.name),
    });
    expect(first.success, first.error).toBe(true);
    expect(tools.length).toBeGreaterThan(0);
    expect((await readFile(join(cwd, "proof.txt"), "utf8")).trim()).toBe(
      "ready",
    );
    if (!first.runtimeSessionId)
      throw new Error("Missing Antigravity session ID");
    const receipt = sendAntigravityMessage(
      {
        cwd,
        parentAgentId,
        resumeSessionId: first.runtimeSessionId,
        prompt: "What value did I ask you to remember?",
      },
      process.env,
      {},
    );
    expect(receipt.mode).toBe("resumed");
    const next = await receipt.completion;
    expect(next?.success, next?.error).toBe(true);
    expect(next?.report).toContain(token);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 300_000);
