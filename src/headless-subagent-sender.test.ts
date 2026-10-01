import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { composeSubagentChildEnv } from "@/agent/subagents/subagent-launcher";
import { buildAgentSendReminder } from "@/backend/api/agent-message";
import { LocalStore } from "@/backend/local/local-store";
import { createIsolatedCliTestEnv } from "@/test-utils/test-process-env";

test("new, existing and forked child CLI launches persist the sender as a separate user content part", async () => {
  const home = await mkdtemp(join(tmpdir(), "letta-subagent-sender-"));
  const storageDir = join(home, "store");
  const reminder = buildAgentSendReminder(
    { agentId: "agent-parent", conversationId: "conv-parent" },
    false,
  );
  const env = composeSubagentChildEnv({
    parentProcessEnv: createIsolatedCliTestEnv({
      HOME: home,
      USER_CWD: home,
      LETTA_LOCAL_BACKEND_DIR: storageDir,
      LETTA_LOCAL_BACKEND_EXECUTOR: "deterministic",
      LETTA_SKIP_KEYCHAIN_CHECK: "1",
      LETTA_DISABLE_MODS: "1",
      LETTA_RUNTIME_LISTENER_CONNECTION_ID: undefined,
    }),
    parentAgentId: "agent-parent",
    parentConversationId: "conv-parent",
    launchProfile: "default",
    inheritedPrimaryRoot: null,
  });
  let agentId = "";
  let conversationId = "";
  try {
    for (const kind of ["new", "existing", "fork"] as const) {
      const target =
        kind === "new" ? ["--new-agent"] : ["--agent", agentId, "--new"];
      if (kind === "fork") {
        const store = new LocalStore(agentId, {
          storageDir,
          seedDefaultAgent: false,
        });
        const fork = store.forkConversation(conversationId, { agentId });
        target.splice(0, target.length, "--conversation", fork.id);
      }
      const prompt = `Sender test ${kind}`;
      const child = Bun.spawn(
        [
          process.execPath,
          `--config=${resolve(import.meta.dir, "..", "bunfig.toml")}`,
          resolve(import.meta.dir, "index.ts"),
          "--backend",
          "local",
          ...target,
          "-p",
          prompt,
          "--tools=",
          "--no-skills",
          "--no-system-info-reminder",
          "--output-format",
          "json",
        ],
        { cwd: home, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      );
      const deadline = setTimeout(() => child.kill(), 20_000);
      let stdout: string;
      try {
        const [code, out, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(code, stderr + out).toBe(0);
        stdout = out;
      } finally {
        clearTimeout(deadline);
      }
      const result = JSON.parse(stdout);
      agentId = result.agent_id;
      conversationId = result.conversation_id;
      const store = new LocalStore(agentId, {
        storageDir,
        seedDefaultAgent: false,
      });
      const message = store
        .listConversationMessages(conversationId)
        .find(
          (row) =>
            row.message_type === "user_message" &&
            JSON.stringify(row.content).includes(prompt),
        );
      expect(message, `${kind}: ${stdout}`).toMatchObject({
        message_type: "user_message",
        content: expect.arrayContaining([
          { type: "text", text: reminder },
          { type: "text", text: prompt },
        ]),
      });
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 65_000);
