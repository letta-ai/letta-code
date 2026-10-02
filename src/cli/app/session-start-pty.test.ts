import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LocalBackend } from "@/backend/local/local-backend";

const projectRoot = resolve(import.meta.dir, "../../..");
const ptyTest = process.platform === "win32" ? test.skip : test;

function builtCli(): string {
  const cliPath = join(projectRoot, "letta.js");
  if (!existsSync(cliPath)) {
    const build = spawnSync("bun", ["run", "build"], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    if (build.status !== 0) {
      throw new Error(`CLI build failed:\n${build.stdout}\n${build.stderr}`);
    }
  }
  return cliPath;
}

describe("SessionStart conversation transitions (#4701)", () => {
  for (const runtime of ["bun", "node"]) {
    ptyTest(
      `${runtime} reports direct and selector resumes exactly once`,
      async () => {
        const fixture = mkdtempSync(join(tmpdir(), "letta-resume-hooks-"));
        try {
          const storageDir = join(fixture, "backend");
          const backend = new LocalBackend({
            storageDir,
            executionMode: "deterministic",
            memfsEnabled: false,
          });
          const agent = await backend.createAgent({ name: "Resume audit" });
          const target = await backend.createConversation({
            agent_id: agent.id,
            summary: "Resume target",
          });
          const stream = await backend.createConversationMessageStream(
            target.id,
            {
              agent_id: agent.id,
              messages: [{ role: "user", content: "Seed the resume target" }],
            },
          );
          for await (const chunk of stream) void chunk;
          const current = await backend.createConversation({
            agent_id: agent.id,
            summary: "Current conversation",
          });
          const result = spawnSync(
            "node",
            [
              join(projectRoot, "src/test-utils/session-start-pty-runner.cjs"),
              builtCli(),
              projectRoot,
              runtime,
              fixture,
              agent.id,
              current.id,
              target.id,
            ],
            { cwd: projectRoot, encoding: "utf8", timeout: 45000 },
          );
          expect(result.stderr).toBe("");
          expect(result.signal).toBeNull();
          expect(result.status).toBe(0);
          expect(result.stdout).toContain("SessionStart transitions verified");
        } finally {
          rmSync(fixture, { recursive: true, force: true });
        }
      },
      { timeout: 120000 },
    );
  }
});
