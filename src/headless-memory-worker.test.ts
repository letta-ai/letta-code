import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { composeSubagentChildEnv } from "@/agent/subagents/subagent-launcher";
import { LocalStore } from "@/backend/local/local-store";
import { getLocalBackendMemoryFilesystemRoot } from "@/backend/local/paths";
import { createIsolatedCliTestEnv } from "@/test-utils/test-process-env";

for (const mode of ["one-shot", "bidirectional", "primary"] as const) {
  test(`headless ${mode} repair runs without startup Git changes, reflection, or recursive repair`, async () => {
    const isRepair = mode !== "primary";
    const home = mkdtempSync(join(tmpdir(), "headless-memory-repair-"));
    try {
      const storageDir = join(home, "store");
      const agentId = "local-agent-memory-repair";
      const store = new LocalStore(agentId, { storageDir });
      const original = store.createConversation({ agent_id: agentId });
      const repair = isRepair
        ? store.forkConversation(original.id, { hidden: true })
        : undefined;
      const memoryDir = getLocalBackendMemoryFilesystemRoot(
        agentId,
        storageDir,
      );
      mkdirSync(memoryDir, { recursive: true });
      const git = (...args: string[]) =>
        execFileSync("git", ["-C", memoryDir, ...args], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      git("init", "-b", "main");
      git("config", "user.name", "Memory Test");
      git("config", "user.email", "memory@example.test");
      git("config", "commit.gpgsign", "false");
      writeFileSync(join(memoryDir, "note.md"), "initial\n");
      git("add", "note.md");
      git("commit", "-m", "initial");
      git("checkout", "-b", "other");
      writeFileSync(join(memoryDir, "note.md"), "other\n");
      git("commit", "-am", "other");
      git("checkout", "main");
      writeFileSync(join(memoryDir, "note.md"), "main\n");
      git("commit", "-am", "main");
      expect(() => git("merge", "other")).toThrow();
      const before = git("status", "--porcelain");
      mkdirSync(join(home, ".letta"), { recursive: true });
      const settingsPath = join(home, ".letta", "settings.json");
      writeFileSync(
        settingsPath,
        JSON.stringify({
          reflectionTrigger: isRepair ? "step-count" : "off",
          reflectionStepCount: 1,
        }),
      );
      const env = composeSubagentChildEnv({
        parentProcessEnv: createIsolatedCliTestEnv({
          HOME: home,
          USER_CWD: home,
          LETTA_LOCAL_BACKEND_EXECUTOR: "deterministic",
          LETTA_SKIP_KEYCHAIN_CHECK: "1",
          LETTA_DISABLE_MODS: "1",
          LETTA_FS_SANDBOX: "0",
        }),
        parentAgentId: agentId,
        parentConversationId: original.id,
        backendMode: "local",
        localBackendStorageDir: storageDir,
        subagentType: isRepair ? "memory" : "general-purpose",
        launchProfile: "memory-subagent",
        inheritedPrimaryRoot: memoryDir,
        memoryScope: { primaryRoot: memoryDir, writableRoots: [memoryDir] },
      });
      const invocation = process.env.LETTA_TEST_BUILT_CLI
        ? ["node", process.env.LETTA_TEST_BUILT_CLI]
        : [
            process.execPath,
            `--config=${resolve(import.meta.dir, "..", "bunfig.toml")}`,
            resolve(import.meta.dir, "index.ts"),
          ];
      const prompt = isRepair
        ? "Inspect the reported memory conflict."
        : "Continue the user task.";
      const child = Bun.spawn(
        [
          ...invocation,
          "--backend",
          "local",
          "--conversation",
          repair?.id ?? original.id,
          ...(mode !== "bidirectional"
            ? ["-p", prompt]
            : ["--input-format", "stream-json"]),
          "--tools=",
          "--no-skills",
          "--no-system-info-reminder",
          "--output-format",
          "stream-json",
        ],
        {
          cwd: home,
          env,
          stdin: mode !== "bidirectional" ? "ignore" : "pipe",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      if (
        mode === "bidirectional" &&
        child.stdin &&
        typeof child.stdin !== "number"
      ) {
        child.stdin.write(
          `${JSON.stringify({ type: "user", message: { role: "user", content: prompt } })}\n`,
        );
        child.stdin.end();
      }
      const deadline = setTimeout(() => child.kill(), 30_000);
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(code, stdout + stderr).toBe(0);
        const events = stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(
          events.some(
            (event) => event.type === "result" && event.subtype === "success",
          ),
          stdout,
        ).toBe(true);
        expect(
          events.find(
            (event) => event.type === "system" && event.subtype === "init",
          )?.memfs_enabled,
        ).toBe(true);
      } finally {
        clearTimeout(deadline);
      }
      // The deterministic executor leaves the conflict unresolved. A normal post-turn
      // sync would launch another repair, so exactly two conversations proves suppression.
      const after = new LocalStore(agentId, {
        storageDir,
        seedDefaultAgent: false,
      });
      const listParams = { agent_id: agentId, include_hidden: true };
      expect(after.listConversations(listParams).length).toBe(2);
      if (repair) {
        expect(after.listConversationMessages(original.id)).toEqual([]);
        // Memory subagents use the one-shot launcher; bidirectional clients
        // supply their own message content and do not get sender attribution.
        if (mode === "one-shot") {
          const workerMessages = JSON.stringify(
            after.listConversationMessages(repair.id),
          );
          expect(workerMessages).toContain(
            "Your final report stays in the background task log",
          );
          expect(workerMessages).not.toContain(
            "The sender will only see the final message",
          );
        }
        expect(
          after
            .listConversationMessages(repair.id)
            .some((message) =>
              JSON.stringify(message.content).includes(prompt),
            ),
        ).toBe(true);
      } else {
        const conversations = after.listConversations(listParams);
        const launched = conversations.find(
          (conversation) => conversation.id !== original.id,
        );
        if (!launched) throw new Error("No repair conversation was launched");
        expect(
          after
            .listConversations({ agent_id: agentId })
            .map((conversation) => conversation.id),
        ).toEqual([original.id]);
        expect(
          JSON.stringify(after.listConversationMessages(launched.id)),
        ).toContain("Repair only the existing Git conflict");
        expect(
          JSON.stringify(after.listConversationMessages(launched.id)),
        ).toContain(prompt);
        const originalMessages = JSON.stringify(
          after.listConversationMessages(original.id),
        );
        expect(originalMessages).toContain(prompt);
        expect(originalMessages).not.toContain(
          "Repair only the existing Git conflict",
        );
        expect(originalMessages).not.toContain("MEMORY GIT CONFLICT");
      }
      expect(git("status", "--porcelain")).toBe(before);
      expect(
        JSON.parse(readFileSync(settingsPath, "utf8")).reflectionTrigger,
      ).toBe(isRepair ? "step-count" : "off");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 40_000);
}
