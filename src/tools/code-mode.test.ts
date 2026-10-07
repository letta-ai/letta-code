import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { fileURLToPath } from "node:url";
import { configureBackendMode } from "@/backend";
import { buildMcpToolCatalog, callMcpCatalogTool } from "@/mcp-tool-catalog";
import { permissionMode } from "@/permissions/mode";
import { settingsManager } from "@/settings-manager";
import {
  clearCapturedToolExecutionContexts,
  clearTools,
  executeTool,
  getToolNames,
  loadSpecificTools,
  prepareCurrentToolExecutionContext,
} from "@/tools/manager";

let originalTools: string[];
let originalMode: ReturnType<typeof permissionMode.getMode>;
const originalGetMcpServers =
  settingsManager.getMcpServers.bind(settingsManager);
const agentId = "agent-codemode-test";
beforeAll(async () => {
  originalTools = getToolNames();
  originalMode = permissionMode.getMode();
  permissionMode.setMode("standard");
  configureBackendMode("local");
  await settingsManager.initialize();
});
afterEach(() => {
  clearCapturedToolExecutionContexts();
  settingsManager.getMcpServers = originalGetMcpServers;
});
afterAll(async () => {
  configureBackendMode("api");
  permissionMode.setMode(originalMode);
  if (originalTools.length) await loadSpecificTools(originalTools);
  else clearTools();
});

async function run(
  code: string,
  approval?: NonNullable<
    Parameters<typeof executeTool>[2]
  >["onNestedToolApproval"],
) {
  await loadSpecificTools(["CodeMode", "Read", "Bash", "Write"]);
  const turn = await prepareCurrentToolExecutionContext({
    workingDirectory: process.cwd(),
    runtimeContext: { agentId },
  });
  return executeTool(
    "CodeMode",
    { code },
    { toolContextId: turn.contextId, onNestedToolApproval: approval },
  );
}

function configuredLocalServer() {
  const server = fileURLToPath(
    new URL(
      "./dist/index.js",
      import.meta.resolve(
        "@modelcontextprotocol/server-everything/package.json",
      ),
    ),
  );
  settingsManager.getMcpServers = (id) =>
    id === agentId
      ? [
          {
            name: "everything",
            transport: "stdio",
            command: process.execPath,
            args: [server],
          },
        ]
      : originalGetMcpServers(id);
}

describe("MCP-only CodeMode", () => {
  test("isolates JS and denies built-in and non-MCP tools even if registered", async () => {
    const result =
      await run(`text([typeof process, typeof require, typeof fetch].join(','));
      for (const name of ['Read','Bash','Write','Workflow','CodeMode','attached_non_mcp']) {
        try { await tool.call(name, {}); } catch (e) { text(name + ':' + e.message); }
      }
      return 5`);
    expect(result.status).toBe("success");
    const output = JSON.stringify(result.toolReturn);
    expect(output).toContain("undefined,undefined,undefined");
    for (const name of [
      "Read",
      "Bash",
      "Write",
      "Workflow",
      "CodeMode",
      "attached_non_mcp",
    ]) {
      expect(output).toContain(`${name}:MCP tool is not available`);
    }
  });

  test("connects agent-configured real stdio MCP on demand and requires approval", async () => {
    configuredLocalServer();
    const script = `const names = await tool.list(); const found = await tool.search('echo'); const schema = await tool.describe('mcp__everything__echo');
      const r = await tool.call(schema.name, {message:'hello'}); return {names:names.length, found:found[0].name, schema:schema.inputSchema, result:r.output}`;
    const denied = await run(script);
    expect(JSON.stringify(denied)).toContain("approval unavailable");
    expect(JSON.stringify(denied.toolReturn)).toContain("approval unavailable");
    let approvals = 0;
    const approved = await run(
      script,
      async ({ toolName, allowPersistence }) => {
        expect(toolName).toBe("mcp__everything__echo");
        expect(allowPersistence).toBe(true);
        approvals++;
        return { approved: true };
      },
    );
    expect(approved.status).toBe("success");
    expect(approvals).toBe(1);
    expect(JSON.stringify(approved.toolReturn)).toContain("hello");
    expect(JSON.stringify(approved.toolReturn)).toContain(
      "mcp__everything__echo",
    );
  });

  test("uses Cloud agent associations, scoped tool IDs and run route (not attached Tools)", async () => {
    const paths: string[] = [];
    const client = {
      async get(path: string) {
        paths.push(path);
        if (path.endsWith("/mcp-servers"))
          return [
            {
              id: "server-id",
              server_name: "cloud",
              mcp_server_type: "streamable_http",
            },
          ];
        if (path.endsWith("/tools"))
          return [
            {
              id: "tool-id",
              name: "echo",
              json_schema: {
                parameters: {
                  type: "object",
                  properties: { message: { type: "string" } },
                },
              },
            },
          ];
        throw new Error("unexpected route");
      },
      async post(path: string, options?: { body?: unknown }) {
        paths.push(path);
        expect(options?.body).toEqual({ args: { message: "hi" } });
        return {
          status: "success",
          func_return: { content: [{ type: "text", text: "hi" }] },
        };
      },
    };
    const deps = {
      getLocalServers: () => [],
      getClient: async () => client,
      isServerMcpAvailable: () => true,
      isHostedLettaCloud: () => true,
    };
    const catalog = await buildMcpToolCatalog(deps, agentId);
    try {
      expect(catalog.tools.map(({ schema }) => schema.name)).toEqual([
        "mcp__cloud__echo",
      ]);
      const tool = catalog.tools[0];
      if (!tool) throw new Error("Expected Cloud MCP tool");
      const result = await callMcpCatalogTool(
        tool,
        agentId,
        { message: "hi" },
        deps,
      );
      expect(result.content).toEqual([{ type: "text", text: "hi" }]);
      expect(paths).toContain(
        `/v1/agents/${agentId}/mcp-servers/server-id/tools/tool-id/run`,
      );
      expect(paths.every((path) => !path.includes("agents/tools"))).toBe(true);
    } finally {
      await catalog.close();
    }
  });

  test("forwards abort to the scoped Cloud MCP run request", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const client = {
      get: async () => [],
      post: async (
        _path: string,
        options?: { body?: unknown; signal?: AbortSignal },
      ) => {
        receivedSignal = options?.signal;
        return new Promise<unknown>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new Error("Aborted")),
            { once: true },
          );
        });
      },
    };
    const tool = {
      schema: { name: "mcp__cloud__echo", inputSchema: {} },
      target: {
        kind: "server" as const,
        serverId: "server-id",
        toolId: "tool-id",
      },
    };
    const pending = callMcpCatalogTool(
      tool,
      agentId,
      {},
      { getClient: async () => client },
      controller.signal,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    expect(receivedSignal).toBe(controller.signal);
    await expect(pending).rejects.toThrow("Aborted");
  });

  test("rejects stale contexts and aborted scripts", async () => {
    await loadSpecificTools(["CodeMode"]);
    const turn = await prepareCurrentToolExecutionContext({
      runtimeContext: { agentId },
    });
    clearCapturedToolExecutionContexts();
    const stale = await executeTool(
      "CodeMode",
      { code: "return 1" },
      { toolContextId: turn.contextId },
    );
    expect(stale.status).toBe("error");
    const active = await prepareCurrentToolExecutionContext({
      runtimeContext: { agentId },
    });
    const controller = new AbortController();
    controller.abort();
    const aborted = await executeTool(
      "CodeMode",
      { code: "return 1" },
      { toolContextId: active.contextId, signal: controller.signal },
    );
    expect(aborted.status).toBe("error");
  });
});
