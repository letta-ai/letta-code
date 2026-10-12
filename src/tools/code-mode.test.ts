import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  workingDirectory = process.cwd(),
) {
  await loadSpecificTools(["CodeMode", "Read", "Bash", "Write"]);
  const turn = await prepareCurrentToolExecutionContext({
    workingDirectory,
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

describe("CodeMode", () => {
  test("isolates JS and exposes only registered built-ins and MCP tools", async () => {
    const result =
      await run(`text([typeof process, typeof require, typeof fetch].join(','));
      const names = ALL_TOOLS.map((t) => t.name);
      text('listed:' + ['Read','Bash','Write'].every((n) => names.includes(n)));
      text('hidden:' + [typeof tools.CodeMode, typeof tools.Edit].join(','));
      text('searchTools:' + typeof searchTools);
      return 5`);
    expect(result.status).toBe("success");
    const output = JSON.stringify(result.toolReturn);
    expect(output).toContain("undefined,undefined,undefined");
    expect(output).toContain("listed:true");
    // CodeMode never nests; unregistered built-ins are not exposed.
    expect(output).toContain("hidden:undefined,undefined");
    expect(output).toContain("searchTools:undefined");
  });

  test("calls built-in tools through permissions and returns their output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codemode-"));
    const file = join(dir, "note.txt");
    writeFileSync(file, "alpha\nbeta\n");
    try {
      // Read inside the working directory is auto-allowed: no approval needed.
      const read = await run(
        `const out = await tools.Read({ file_path: ${JSON.stringify(file)} });
        return out.includes('beta')`,
        undefined,
        dir,
      );
      expect(read.status).toBe("success");
      expect(JSON.stringify(read.toolReturn)).toContain('\\"value\\":true');
      expect(JSON.stringify(read.toolReturn)).toContain(
        "Read(file_path): success",
      );

      // Bash requires approval: unavailable fails closed, approved runs.
      const marker = join(dir, "marker");
      const script = `return (await tools.Bash({ command: 'touch ${marker} && echo codemode-bash', description: 'touch' })).trim()`;
      const denied = await run(script, undefined, dir);
      expect(JSON.stringify(denied.toolReturn)).toContain(
        "Bash approval unavailable",
      );
      expect(existsSync(marker)).toBe(false);
      const approvals: string[] = [];
      const approved = await run(
        script,
        async ({ toolName }) => {
          approvals.push(toolName);
          return { approved: true };
        },
        dir,
      );
      expect(approved.status).toBe("success");
      expect(approvals).toEqual(["Bash"]);
      expect(JSON.stringify(approved.toolReturn)).toContain("codemode-bash");
      expect(existsSync(marker)).toBe(true);

      // A failed built-in call throws inside the script.
      const failed = await run(
        `try { await tools.Read({ file_path: ${JSON.stringify(join(dir, "missing.txt"))} }); return 'no-throw' } catch (e) { return 'threw' }`,
        undefined,
        dir,
      );
      expect(JSON.stringify(failed.toolReturn)).toContain("threw");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("connects agent-configured real stdio MCP on demand and requires approval", async () => {
    configuredLocalServer();
    const script = `const listed = ALL_TOOLS.some((t) => t.name === 'mcp__everything__echo');
      const schema = await describeTool('mcp__everything__echo');
      const missing = await describeTool('mcp__everything__nope');
      const r = await tools.mcp__everything__echo({ message: 'hello' });
      return { listed, schema: schema.inputSchema, missing: missing === undefined, result: r }`;
    const denied = await run(script);
    expect(JSON.stringify(denied.toolReturn)).toContain(
      "mcp__everything__echo approval unavailable",
    );
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
    const output = JSON.stringify(approved.toolReturn);
    expect(output).toContain('\\"listed\\":true');
    expect(output).toContain('\\"missing\\":true');
    expect(output).toContain("Echo: hello");
    expect(output).toContain("mcp__everything__echo(message): success");
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
