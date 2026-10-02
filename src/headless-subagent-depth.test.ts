import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { composeSubagentChildEnv } from "@/agent/subagents/subagent-launcher";
import { createIsolatedCliTestEnv } from "@/test-utils/test-process-env";

async function childInitTools(
  home: string,
  parentProcessEnv: NodeJS.ProcessEnv,
): Promise<{ env: NodeJS.ProcessEnv; tools: string[]; send?: string }> {
  const env = composeSubagentChildEnv({
    parentProcessEnv,
    parentAgentId: "agent-parent",
    parentConversationId: "conv-parent",
    launchProfile: "default",
    inheritedPrimaryRoot: null,
  });
  // No --tools: the same launch shape as a `tools: all` fork.
  const child = Bun.spawn(
    [
      process.execPath,
      `--config=${resolve(import.meta.dir, "..", "bunfig.toml")}`,
      resolve(import.meta.dir, "index.ts"),
      "--backend",
      "local",
      "--new-agent",
      "-p",
      "depth probe",
      "--no-skills",
      "--no-system-info-reminder",
      "--output-format",
      "stream-json",
    ],
    { cwd: home, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const deadline = setTimeout(() => child.kill(), 30_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, stderr + stdout).toBe(0);
    const init = stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((event) => event.type === "system" && event.subtype === "init");
    return { env, tools: init?.tools ?? [] };
  } finally {
    clearTimeout(deadline);
  }
}

test("a forked child keeps Agent at depth 1, loses it at depth 2, and keeps SendAgentMessage at both", async () => {
  const home = await mkdtemp(join(tmpdir(), "letta-subagent-depth-"));
  try {
    const root = createIsolatedCliTestEnv({
      HOME: home,
      USER_CWD: home,
      LETTA_LOCAL_BACKEND_DIR: join(home, "store"),
      LETTA_LOCAL_BACKEND_EXECUTOR: "deterministic",
      LETTA_SKIP_KEYCHAIN_CHECK: "1",
      LETTA_DISABLE_MODS: "1",
      LETTA_RUNTIME_LISTENER_CONNECTION_ID: undefined,
    });
    const depth1 = await childInitTools(home, root);
    expect(depth1.tools).toEqual(
      expect.arrayContaining(["Agent", "SendAgentMessage"]),
    );
    const depth2 = await childInitTools(home, depth1.env);
    expect(depth2.tools).toContain("SendAgentMessage");
    expect(depth2.tools).not.toContain("Agent");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 90_000);
