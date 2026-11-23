import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalAgentRecord } from "@/backend/local/local-store";
import { compileLocalSystemPrompt } from "@/backend/local/system-prompt-compilation";

function agent(system = "base {CORE_MEMORY}"): LocalAgentRecord {
  return {
    id: "agent-local-test",
    name: "Local Test",
    description: null,
    system,
    tags: [],
    model: "openai/gpt-test",
    model_settings: { provider_type: "openai" },
  };
}

function git(memoryDir: string, args: string[]) {
  execFileSync("git", args, {
    cwd: memoryDir,
    stdio: "ignore",
  });
}

function initAndCommitMemory(memoryDir: string, message = "initial memory") {
  git(memoryDir, ["init"]);
  git(memoryDir, ["config", "user.email", "agent-local-test@letta.com"]);
  git(memoryDir, ["config", "user.name", "Local Test"]);
  git(memoryDir, ["add", "."]);
  git(memoryDir, ["commit", "-m", message]);
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: memoryDir,
    encoding: "utf8",
  }).trim();
}

describe("local system prompt compilation", () => {
  for (const memory of [
    "$`",
    "$'",
    "$$",
    "$&",
    "$` | $' | $$ | $& | {CORE_MEMORY}  \n",
  ]) {
    test(`inserts literal core memory ${JSON.stringify(memory)}`, async () => {
      const memoryDir = await mkdtemp(join(tmpdir(), "local-prompt-literal-"));
      try {
        await writeFile(join(memoryDir, "MEMORY.md"), memory, "utf8");
        initAndCommitMemory(memoryDir);
        const expectedMemory = `<memory>\n${memory.trimEnd()}\n</memory>`;
        for (const [raw, expected] of [
          [
            "before {CORE_MEMORY} after  \n",
            `before ${expectedMemory} after  \n`,
          ],
          ["plain base  \n", `plain base\n\n${expectedMemory}`],
          [
            "A{CORE_MEMORY}B{CORE_MEMORY}C",
            `A${expectedMemory}B${expectedMemory}C`,
          ],
        ] as const) {
          const compiled = compileLocalSystemPrompt({
            agent: agent(raw),
            conversationId: "local-conv-test",
            memoryDir,
          });
          expect(compiled.coreMemory).toBe(expectedMemory);
          expect(compiled.content).toBe(expected);
        }
      } finally {
        await rm(memoryDir, { recursive: true, force: true });
      }
    });
  }
});
