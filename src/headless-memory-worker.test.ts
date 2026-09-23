import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { composeSubagentChildEnv } from "@/agent/subagents/subagent-launcher";
import { LocalStore } from "@/backend/local/local-store";
import { getLocalBackendMemoryFilesystemRoot } from "@/backend/local/paths";
import { initGitRepo } from "@/test-utils/temp-git-repo";
import { createIsolatedCliTestEnv } from "@/test-utils/test-process-env";

for (const mode of [
  "one-shot",
  "bidirectional",
  "primary",
  "primary-bidirectional",
] as const) {
  test(`headless ${mode} repair runs without startup Git changes, reflection, or recursive repair`, async () => {
    const isRepair = mode === "one-shot" || mode === "bidirectional";
    const bidirectional = mode.endsWith("bidirectional");
    const home = mkdtempSync(join(tmpdir(), "headless-memory-repair-"));
    try {
      const storageDir = join(home, "store");
      const agentId = "local-agent-memory-repair";
      const store = new LocalStore(agentId, {
        storageDir,
        defaultAgentModel: "anthropic/claude-sonnet-4-6",
      });
      const original = store.createConversation({ agent_id: agentId });
      const memoryDir = getLocalBackendMemoryFilesystemRoot(
        agentId,
        storageDir,
      );
      mkdirSync(memoryDir, { recursive: true });
      const { git } = initGitRepo(memoryDir);
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
          ...(isRepair
            ? [
                "--new-agent",
                "--system",
                "memory",
                "--model",
                "anthropic/claude-sonnet-4-6",
              ]
            : ["--conversation", original.id]),
          ...(!bidirectional
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
          stdin: !bidirectional ? "ignore" : "pipe",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      if (bidirectional && child.stdin && typeof child.stdin !== "number") {
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
        ).toBe(!isRepair);
      } finally {
        clearTimeout(deadline);
      }
      // The deterministic executor leaves the conflict unresolved. Each mode
      // creates exactly one fresh worker, with no recursive repair or reflection.
      const after = new LocalStore(agentId, {
        storageDir,
        seedDefaultAgent: false,
      });
      expect(after.listConversations({ agent_id: agentId })).toHaveLength(1);
      const workerIds = readdirSync(join(storageDir, "agents"))
        .filter((file) => file.endsWith(".json"))
        .map(
          (file) =>
            JSON.parse(readFileSync(join(storageDir, "agents", file), "utf8"))
              .id as string,
        )
        .filter((id) => id !== agentId);
      expect(workerIds).toHaveLength(1);
      const workerId = workerIds[0];
      if (!workerId) throw new Error("No memory worker created");
      const workerStore = new LocalStore(workerId, {
        storageDir,
        seedDefaultAgent: false,
      });
      const workerMessages = workerStore
        .listConversationMessages("default", { agent_id: workerId })
        .flatMap((message) =>
          typeof message.content === "string"
            ? [message.content]
            : Array.isArray(message.content)
              ? message.content.flatMap((part) =>
                  part.type === "text" ? [part.text] : [],
                )
              : [],
        )
        .join("\n");
      expect(
        JSON.parse(readFileSync(settingsPath, "utf8")).agents.find(
          (a: { agentId: string }) => a.agentId === workerId,
        )?.memfs,
      ).toBe(false);
      if (isRepair) {
        expect(after.listConversationMessages(original.id)).toEqual([]);
        expect(workerMessages).toContain(prompt);
        // Bidirectional clients supply their own content without sender attribution.
        if (mode === "one-shot") {
          expect(workerMessages).toContain(
            "Your final report stays in the background task log",
          );
          expect(workerMessages).not.toContain(
            "The sender will only see the final message",
          );
        }
      } else {
        expect(workerMessages).toContain(
          "Repair only the existing Git conflict",
        );
        expect(workerMessages).not.toContain(prompt);
        expect(workerMessages).toContain(memoryDir);
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
