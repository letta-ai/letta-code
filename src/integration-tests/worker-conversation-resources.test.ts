import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import Letta from "@letta-ai/letta-client";
import { createEphemeralConversation } from "@/agent/ephemeral-conversation";
import { getAllSubagentConfigs } from "@/agent/subagents";
import { buildSubagentArgs } from "@/agent/subagents/manager";
import { getBackend } from "@/backend";
import { runMcpSubcommand } from "@/cli/subcommands/mcp";
import { getMcpScopeAgentId } from "@/mcp-scope";
import { settingsManager } from "@/settings-manager";
import { createAuthenticatedCliTestEnv } from "@/test-utils/test-process-env";
import { executeTool } from "@/tools/manager";
import { prepareToolExecutionContextForScope } from "@/tools/toolset";

// Runs in the keyed API integration matrix; no provider or MCP responses mocked.
test("conversation workers inherit resources without owning agents or memory", async () => {
  if (!process.env.LETTA_API_KEY) throw new Error("LETTA_API_KEY is required");
  await settingsManager.initialize();
  const client = new Letta({
    apiKey: process.env.LETTA_API_KEY,
    baseURL: process.env.LETTA_BASE_URL || "https://api.letta.com",
  });
  const secret = randomUUID();
  const parent = await client.agents.create({
    name: "Worker resource test",
    model: "openai/gpt-5.6-luna",
    system: "parent snapshot",
    initial_message_sequence: [],
    include_base_tools: false,
    include_base_tool_rules: false,
    secrets: { WORKER_TEST_SECRET: secret },
  });
  const backend = getBackend();
  const children: string[] = [];
  try {
    const config = (await getAllSubagentConfigs(process.cwd()))[
      "general-purpose"
    ];
    if (!config)
      throw new Error("Missing general-purpose worker configuration");
    const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("../index.ts", import.meta.url)),
        ...buildSubagentArgs(
          "general-purpose",
          config,
          "openai/gpt-5.6-luna",
          "Reply with OK without calling tools.",
          undefined,
          undefined,
          undefined,
          { backendMode: "api", parentAgentId: parent.id },
        ),
      ],
      {
        env: createAuthenticatedCliTestEnv({
          AGENT_ID: parent.id,
          LETTA_PARENT_AGENT_ID: parent.id,
          LETTA_CODE_AGENT_ROLE: "subagent",
          LETTA_SUBAGENT_LAUNCH: "1",
          LETTA_RUNTIME_LISTENER_CONNECTION_ID: undefined,
        }),
        stdout: "pipe",
        stderr: "pipe",
        signal: AbortSignal.timeout(90_000),
      },
    );
    const [stdoutText, stderrText, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const events = stdoutText.split("\n").flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
    const init = events.find(
      (event) => event.type === "system" && event.subtype === "init",
    );
    if (init?.conversation_id) children.push(init.conversation_id);
    expect(exitCode, stderrText).toBe(0);
    expect(init).toMatchObject({ agent_id: null, memfs_enabled: false });
    const worker = { conversationId: init.conversation_id as string };
    expect(
      await backend.retrieveConversation(worker.conversationId),
    ).toMatchObject({
      agent_id: null,
      parent_agent_id: parent.id,
      is_subagent: true,
      name: expect.any(String),
    });
    const scope = await prepareToolExecutionContextForScope({
      agentId: null,
      conversationId: worker.conversationId,
    });
    expect(scope.agent).toBeNull();
    const command = `${JSON.stringify(process.execPath)} -e 'console.log("HAS_SECRET="+Boolean(process.env.WORKER_TEST_SECRET));console.log("HAS_MEMORY="+Boolean(process.env.MEMORY_DIR));console.log("HAS_OWNER="+Boolean(process.env.AGENT_ID));console.log(process.env.WORKER_TEST_SECRET)'`;
    const output = await executeTool(
      "exec_command",
      {
        cmd: process.platform === "win32" ? `& ${command}` : command,
        description: "Verify worker resource scope",
      },
      { toolContextId: scope.preparedToolContext.contextId },
    );
    expect(output.status).toBe("success");
    expect(output.toolReturn).toContain("HAS_SECRET=true");
    expect(output.toolReturn).toContain("HAS_MEMORY=false");
    expect(output.toolReturn).toContain("HAS_OWNER=false");
    expect(output.toolReturn).not.toContain(secret);
    expect(output.toolReturn).toContain("<REDACTED>");

    // The CLI resolves the persisted conversation parent before opening a real
    // stdio MCP server. The fixture belongs only to that parent.
    const stdout: string[] = [];
    const stderr: string[] = [];
    expect(
      await runMcpSubcommand(
        ["call", "mcp__fixture__echo", "--args", '{"message":"worker-mcp-ok"}'],
        {
          env: { LETTA_CONVERSATION_ID: worker.conversationId },
          getLocalServers: (id) =>
            id === parent.id
              ? [
                  {
                    name: "fixture",
                    transport: "stdio",
                    command: "node",
                    args: [
                      fileURLToPath(
                        new URL(
                          "./dist/index.js",
                          import.meta.resolve(
                            "@modelcontextprotocol/server-everything/package.json",
                          ),
                        ),
                      ),
                    ],
                  },
                ]
              : [],
          stdout: (text) => stdout.push(text),
          stderr: (text) => stderr.push(text),
        },
      ),
    ).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain("worker-mcp-ok");

    const fork = await backend.forkConversation(worker.conversationId, {
      ephemeral: true,
      isSubagent: true,
      name: "Forked worker",
      hidden: true,
    });
    children.push(fork.id);
    expect(await backend.retrieveConversation(fork.id)).toMatchObject({
      agent_id: null,
      parent_agent_id: parent.id,
      is_subagent: true,
    });
    expect(await getMcpScopeAgentId(fork.id)).toBe(parent.id);

    const unparented = await createEphemeralConversation({
      model: "openai/gpt-5.6-luna",
      systemPromptCustom: "No inherited resources",
    });
    children.push(unparented.conversationId);
    await expect(getMcpScopeAgentId(unparented.conversationId)).rejects.toThrow(
      "no parent MCP",
    );
    const isolated = await prepareToolExecutionContextForScope({
      agentId: null,
      conversationId: unparented.conversationId,
    });
    const isolatedOutput = await executeTool(
      "exec_command",
      {
        cmd: process.platform === "win32" ? `& ${command}` : command,
        description: "Verify unparented resource isolation",
      },
      { toolContextId: isolated.preparedToolContext.contextId },
    );
    expect(isolatedOutput.toolReturn).toContain("HAS_SECRET=false");
  } finally {
    for (const id of children.reverse()) await backend.deleteConversation?.(id);
    await client.agents.delete(parent.id);
  }
}, 180_000);
