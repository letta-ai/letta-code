import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { clearAllSubagents } from "@/agent/subagent-state";
import { configureBackendMode, getBackend } from "@/backend";
import { resolveBackendMode } from "@/backend/backend-mode";
import {
  clearModPermissions,
  registerModPermission,
} from "@/mods/permission-registry";
import { runWithRuntimeContext } from "@/runtime-context";
import { settingsManager } from "@/settings-manager";
import { __resetClaudeSessionsForTests } from "@/tools/impl/claude-stream-session";
import {
  clearCapturedToolExecutionContexts,
  clearExternalTools,
  executeTool,
  registerExternalTools,
  setExternalToolExecutor,
} from "@/tools/manager";
import { createScriptToolScope } from "@/tools/script-tool-scope";
import { prepareToolExecutionContextForResolvedTarget } from "@/tools/toolset";
import {
  clearPendingMessages,
  type QueuedMessage,
  setMessageQueueAdder,
} from "@/utils/message-queue-bridge";
import { killBackgroundProcess } from "./kill-bash";
import { backgroundProcesses, backgroundTasks } from "./process_manager";

const originalHome = process.env.HOME;
const originalLocalDir = process.env.LETTA_LOCAL_BACKEND_DIR;
const originalLocalFlag = process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL;
const originalMode = resolveBackendMode();
const agentId = "agent-code-mode-test";
const serverPath = fileURLToPath(
  new URL(
    "./dist/index.js",
    import.meta.resolve("@modelcontextprotocol/server-everything/package.json"),
  ),
);
let home: string;
let queued: QueuedMessage[];

beforeEach(async () => {
  queued = [];
  setMessageQueueAdder((message) => queued.push(message));
  await settingsManager.reset();
  home = mkdtempSync(join(tmpdir(), "code-mode-test-"));
  process.env.HOME = home;
  process.env.LETTA_LOCAL_BACKEND_DIR = join(home, "local");
  configureBackendMode("local");
  await settingsManager.initialize();
});

afterEach(async () => {
  setMessageQueueAdder(null);
  clearPendingMessages();
  clearCapturedToolExecutionContexts();
  clearExternalTools();
  clearModPermissions();
  await settingsManager.reset();
  configureBackendMode(originalMode);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalLocalDir === undefined)
    delete process.env.LETTA_LOCAL_BACKEND_DIR;
  else process.env.LETTA_LOCAL_BACKEND_DIR = originalLocalDir;
  if (originalLocalFlag === undefined)
    delete process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL;
  else process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL = originalLocalFlag;
  rmSync(home, { recursive: true, force: true });
});

async function run(
  code: string,
  mode: "unrestricted" | "strict" = "unrestricted",
  signal?: AbortSignal,
  conversationId = "default",
  background: { run_in_background?: boolean; foregroundYieldMs?: number } = {},
) {
  const { preparedToolContext } =
    await prepareToolExecutionContextForResolvedTarget({
      toolsetPreference: "letta",
      clientToolAllowlist: [
        "CodeMode",
        "Read",
        "Write",
        "Agent",
        "SendAgentMessage",
        "AskUserQuestion",
        "Workflow",
        "fetch_thread",
      ],
      workingDirectory: home,
      permissionModeState: { mode },
      runtimeContext: {
        agentId,
        conversationId,
        workingDirectory: home,
      },
    });
  return runWithRuntimeContext(
    {
      agentId,
      conversationId,
      workingDirectory: home,
      toolContextId: preparedToolContext.contextId,
    },
    () =>
      executeTool(
        "CodeMode",
        { code, args: { path: join(home, "input.txt") }, ...background },
        {
          toolContextId: preparedToolContext.contextId,
          signal,
        },
      ),
  );
}

test("combines a real file read and MCP calls without Workflow metadata or model setup", async () => {
  writeFileSync(join(home, "input.txt"), "hello from a file");
  settingsManager.setMcpServers(agentId, [
    {
      name: "everything",
      transport: "stdio",
      command: process.execPath,
      args: [serverPath],
    },
  ]);
  const result = await run(`
const [source, echoed] = await Promise.all([
  tools.Read({ file_path: args.path }),
  tools.mcp__everything__echo({ message: 'hello from MCP' }),
]);
const second = await tools.mcp__everything__echo({ message: echoed });
const schema = await describeTool('mcp__everything__echo');
const names = (await listTools()).map(t => t.name);
console.log('combined', names.length > 0, { echoed });
return {
  file: source.includes('hello from a file'), echoed, second,
  schema: schema.inputSchema.required,
  read: names.includes('Read'), hidden: names.includes('CodeMode'),
  excluded: [typeof tools.CodeMode, typeof tools.Workflow, typeof tools.Bash],
  orchestration: [typeof agent, typeof decide],
};`);
  expect(result.status).toBe("success");
  expect(JSON.parse(result.toolReturn as string)).toEqual({
    result: {
      file: true,
      echoed: "Echo: hello from MCP",
      second: "Echo: Echo: hello from MCP",
      schema: ["message"],
      read: true,
      hidden: false,
      excluded: ["undefined", "undefined", "undefined"],
      orchestration: ["undefined", "undefined"],
    },
    output: ["combined true { echoed: 'Echo: hello from MCP' }"],
  });
}, 15000);

test.each(["everything", "everything_", "_"])(
  "parallel calls to %s do not start unrelated servers",
  async (name) => {
    settingsManager.setMcpServers(agentId, [
      {
        name,
        transport: "stdio",
        command: process.execPath,
        args: [serverPath],
      },
      {
        name: "unused",
        transport: "stdio",
        command: join(home, "must-not-start"),
      },
    ]);
    const result = await run(`
return await Promise.all(Array.from({ length: 36 }, (_, i) =>
  tools[${JSON.stringify(`mcp__${name}__echo`)}]({ message: String(i) })
));`);
    expect(result).toMatchObject({ status: "success" });
    expect(JSON.parse(result.toolReturn as string).result).toEqual(
      Array.from({ length: 36 }, (_, i) => `Echo: ${i}`),
    );
  },
  15000,
);

test("MCP calls resolve collision-generated aliases containing the delimiter", async () => {
  settingsManager.setMcpServers(
    agentId,
    ["foo_", "foo__"].map((name) => ({
      name,
      transport: "stdio",
      command: process.execPath,
      args: [serverPath],
    })),
  );
  const result = await run(
    `const echoed = await tools.mcp__foo__2__echo({message: 'collision'});
return {echoed, listed: (await listTools()).some(t => t.name === 'mcp__foo__2__echo')};`,
  );
  expect(result).toMatchObject({ status: "success" });
  expect(JSON.parse(result.toolReturn as string).result).toEqual({
    echoed: "Echo: collision",
    listed: true,
  });
}, 15000);

test("a scoped owning agent runs built-ins without a conversation lookup", async () => {
  const conversationId = "conv-not-stored";
  await expect(
    getBackend().retrieveConversation(conversationId),
  ).rejects.toThrow();
  writeFileSync(join(home, "input.txt"), "offline read");
  const result = await run(
    "return await tools.Read({ file_path: args.path });",
    "unrestricted",
    undefined,
    conversationId,
  );
  expect(result.status).toBe("success");
  expect(JSON.parse(result.toolReturn as string).result).toContain(
    "offline read",
  );
});

test("strict-mode nested calls need approval and do not write", async () => {
  const result = await run(
    `return await tools.Write({ file_path: args.path, content: 'no' });`,
    "strict",
  );
  expect(result.status).toBe("error");
  expect(result.toolReturn).toContain("needs approval");
  expect(existsSync(join(home, "input.txt"))).toBe(false);
});

test("explicit deny rules block nested calls even in unrestricted mode", async () => {
  mkdirSync(join(home, ".letta"), { recursive: true });
  writeFileSync(
    join(home, ".letta", "settings.local.json"),
    JSON.stringify({ permissions: { deny: ["Write"] } }),
  );
  const result = await run(
    `return await tools.Write({ file_path: args.path, content: 'no' });`,
  );
  expect(result.status).toBe("error");
  expect(result.toolReturn).toContain("denied by permission rules");
  expect(existsSync(join(home, "input.txt"))).toBe(false);
});

test("scripts can catch actual tool failures and continue", async () => {
  const result = await run(`
const results = await Promise.allSettled([tools.Read({ file_path: args.path })]);
return results.map(r => r.status);`);
  expect(result.status).toBe("success");
  expect(JSON.parse(result.toolReturn as string).result).toEqual(["rejected"]);
});

test("invalid JavaScript returns an error rather than running tools", async () => {
  const result = await run("return await ;");
  expect(result.status).toBe("error");
  expect(result.toolReturn).toContain("CodeMode script failed to parse");
});

test("an aborted invocation does not launch nested writes", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await run(
    `return await tools.Write({ file_path: args.path, content: 'no' });`,
    "unrestricted",
    controller.signal,
  );
  expect(result).toMatchObject({
    status: "error",
    toolReturn: "Interrupted by user",
  });
  expect(existsSync(join(home, "input.txt"))).toBe(false);
});

async function waitFor(condition: () => boolean) {
  for (let i = 0; i < 200 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(condition()).toBe(true);
}

test("run_in_background returns a task ID and notifies after the turn is interrupted", async () => {
  writeFileSync(join(home, "input.txt"), "background read");
  const interrupted = new AbortController();
  const launch = await run(
    `const text = await tools.Read({ file_path: args.path });
console.log('read', text.includes('background read'));
return text.includes('background read');`,
    "unrestricted",
    interrupted.signal,
    "default",
    { run_in_background: true },
  );
  interrupted.abort();
  expect(launch.status).toBe("success");
  const taskId = (launch.toolReturn as string).match(/with ID: (\S+)/)?.[1];
  expect(taskId).toStartWith("code_mode_");
  await waitFor(() => queued.length === 1);
  expect(queued[0]).toMatchObject({ kind: "task_notification", agentId });
  expect(queued[0]?.text).toContain("<status>completed</status>");
  expect(queued[0]?.text).toContain('{"result":true,"output":["read true"]}');
  expect(backgroundProcesses.get(taskId as string)?.status).toBe("completed");
});

test("a script still running after the foreground wait yields, and TaskStop aborts it silently", async () => {
  const launch = await run(
    "await new Promise(() => {});",
    "unrestricted",
    undefined,
    "default",
    { foregroundYieldMs: 20 },
  );
  expect(launch.toolReturn).toContain("still running with task ID");
  const taskId = (launch.toolReturn as string).match(/task ID: (\S+)/)?.[1];
  expect(backgroundProcesses.get(taskId as string)?.status).toBe("running");
  expect(killBackgroundProcess(taskId as string)).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(backgroundProcesses.has(taskId as string)).toBe(false);
  expect(queued).toHaveLength(0);
});

// The manager, CodeMode runtime, schema discovery, and permissions are real;
// only the hosting harness transport is replaced with an in-process executor.
test("scripts discover and call captured harness-provided tools through the manager", async () => {
  const calls: unknown[] = [];
  registerExternalTools([
    {
      name: "fetch_thread",
      description: "Fetch a thread supplied by the hosting harness",
      parameters: {
        type: "object",
        properties: { thread: { type: "string" } },
        required: ["thread"],
      },
    },
    {
      name: "hidden_harness_tool",
      description: "Not selected for this turn",
      parameters: {},
    },
  ]);
  setExternalToolExecutor(async (_id, name, input, context) => {
    calls.push({
      name,
      input,
      conversationId: context?.tool.runtime?.conversationId,
    });
    // Registrations can change while a turn is running: discovery and calls
    // must continue using the turn's captured definitions and executor.
    clearExternalTools();
    return {
      content: [{ type: "text", text: `thread:${input.thread}` }],
      isError: false,
    };
  });
  const result = await run(`
const schema = await describeTool('fetch_thread');
const first = await tools.fetch_thread({thread: '123'});
const second = await tools.fetch_thread({thread: '456'});
return { first, second, schema, names: (await listTools()).map(t => t.name), hidden: typeof tools.hidden_harness_tool };
`);
  expect(result.status).toBe("success");
  const output = JSON.parse(result.toolReturn as string).result;
  expect(output.first).toBe("thread:123");
  expect(output.second).toBe("thread:456");
  expect(output.schema.inputSchema.required).toEqual(["thread"]);
  expect(output.names).toContain("fetch_thread");
  expect(output.names).not.toContain("hidden_harness_tool");
  expect(output.hidden).toBe("undefined");
  expect(calls).toEqual([
    {
      name: "fetch_thread",
      input: { thread: "123" },
      conversationId: undefined,
    },
    {
      name: "fetch_thread",
      input: { thread: "456" },
      conversationId: undefined,
    },
  ]);
});

test("approval-required harness tools fail closed without invoking the transport", async () => {
  let called = false;
  registerExternalTools([
    { name: "fetch_thread", description: "Fetch a thread", parameters: {} },
  ]);
  setExternalToolExecutor(async () => {
    called = true;
    return { content: [], isError: false };
  });
  const result = await run("return await tools.fetch_thread({});", "strict");
  expect(result.status).toBe("error");
  expect(result.toolReturn).toContain("needs approval");
  expect(called).toBe(false);
});

test("Agent and SendAgentMessage are callable and discoverable while interactive orchestration tools stay excluded", async () => {
  const { preparedToolContext } =
    await prepareToolExecutionContextForResolvedTarget({
      toolsetPreference: "letta",
      clientToolAllowlist: [
        "Agent",
        "SendAgentMessage",
        "AskUserQuestion",
        "Workflow",
        "CodeMode",
      ],
      workingDirectory: home,
      permissionModeState: { mode: "strict" },
      runtimeContext: { agentId, conversationId: "conv-script-parent" },
    });
  await runWithRuntimeContext(
    { toolContextId: preparedToolContext.contextId },
    async () => {
      const scope = await createScriptToolScope(null);
      try {
        const listed = (await scope.listTools()).map((t) => t.name);
        for (const name of ["Agent", "SendAgentMessage"]) {
          expect(scope.builtinToolNames).toContain(name);
          expect(listed).toContain(name);
          await expect(scope.callTool(name, {})).rejects.toThrow(
            "needs approval",
          );
        }
        for (const name of ["AskUserQuestion", "Workflow", "CodeMode"]) {
          expect(scope.builtinToolNames).not.toContain(name);
          expect(listed).not.toContain(name);
        }
      } finally {
        await scope.cleanup();
      }
    },
  );
  const result = await run(
    `return [typeof tools.Agent, typeof tools.SendAgentMessage, typeof tools.AskUserQuestion, typeof tools.Workflow, typeof tools.CodeMode];`,
  );
  expect(JSON.parse(result.toolReturn as string).result).toEqual([
    "function",
    "function",
    "undefined",
    "undefined",
    "undefined",
  ]);
});

test.skipIf(process.platform === "win32")(
  "a script-launched Agent delivers its background notification to the invoking conversation",
  async () => {
    const originalPath = process.env.PATH;
    const bin = join(home, "bin");
    mkdirSync(bin);
    // Replace only the external model CLI. The Agent implementation, background
    // task lifecycle, manager context, and notification queue remain real.
    writeFileSync(
      join(bin, "claude"),
      `#!${process.execPath}
if (process.argv.includes("auth")) {
  console.log(JSON.stringify({loggedIn: true})); process.exit(0);
}
const send = value => console.log(JSON.stringify(value));
const rl = require("node:readline").createInterface({input: process.stdin});
rl.on("line", line => {
  if (JSON.parse(line).type !== "user") return;
  send({type: "system", subtype: "init", session_id: "11111111-1111-4111-8111-111111111111"});
  send({type: "result", is_error: false, result: "Completed script task"});
});
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${originalPath}`;
    try {
      const result = await run(
        `return await tools.Agent({
      subagent_type: 'claude-code', prompt: 'Perform a task', description: 'Script task', mcp: {inherit: false}
    });`,
        "unrestricted",
        undefined,
        "conv-script-notification",
      );
      expect(result.status).toBe("success");
      const receipt = JSON.parse(result.toolReturn as string).result;
      expect(receipt).toContain("Task");
      await waitFor(() =>
        queued.some((message) => message.kind === "task_notification"),
      );
      expect(queued).toContainEqual(
        expect.objectContaining({
          kind: "task_notification",
          agentId,
          conversationId: "conv-script-notification",
          text: expect.stringContaining("Completed script task"),
        }),
      );
    } finally {
      for (const task of backgroundTasks.values())
        task.abortController?.abort();
      backgroundTasks.clear();
      clearAllSubagents();
      __resetClaudeSessionsForTests();
      process.env.PATH = originalPath;
    }
  },
  15000,
);

test("nested calls use the captured turn's approval permission overlays", async () => {
  const calls: unknown[] = [];
  registerExternalTools([
    { name: "fetch_thread", description: "Fetch a thread", parameters: {} },
  ]);
  setExternalToolExecutor(async () => {
    calls.push("executed");
    return { content: [], isError: false };
  });
  registerModPermission({
    id: "script-turn-gate",
    description: "Block this conversation",
    path: join(home, "gate.ts"),
    owner: {
      id: "global:script-turn-gate",
      path: join(home, "gate.ts"),
      scope: "global",
      generation: 1,
    },
    activationSignal: new AbortController().signal,
    check(event) {
      if (
        event.phase === "approval" &&
        event.toolName === "fetch_thread" &&
        event.conversationId === "conv-gated-script"
      ) {
        return { decision: "deny", reason: "Conversation gate" };
      }
      return undefined;
    },
  });
  const result = await run(
    "return await tools.fetch_thread({});",
    "unrestricted",
    undefined,
    "conv-gated-script",
  );
  expect(result.status).toBe("error");
  expect(result.toolReturn).toContain("denied by permission rules");
  expect(calls).toEqual([]);
});

test("parallel harness calls receive distinct manager tool-call IDs", async () => {
  const ids: string[] = [];
  registerExternalTools([
    { name: "fetch_thread", description: "Fetch a thread", parameters: {} },
  ]);
  setExternalToolExecutor(async (id, _name, input) => {
    ids.push(id);
    return {
      content: [{ type: "text", text: String(input.thread) }],
      isError: false,
    };
  });
  const result = await run(
    `return await Promise.all(Array.from({length: 20}, (_, thread) => tools.fetch_thread({thread})));`,
  );
  expect(result.status).toBe("success");
  expect(JSON.parse(result.toolReturn as string).result).toEqual(
    Array.from({ length: 20 }, (_, i) => String(i)),
  );
  expect(ids).toHaveLength(20);
  expect(new Set(ids).size).toBe(20);
});
