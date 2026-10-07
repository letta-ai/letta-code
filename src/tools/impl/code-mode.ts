import { randomUUID } from "node:crypto";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import {
  buildMcpToolCatalog,
  callMcpCatalogTool,
  type McpToolCatalog,
} from "@/mcp-tool-catalog";
import { scrubAmbientSecrets } from "@/tools/secret-substitution";
import { isRecord } from "@/utils/type-guards";

interface Invocation {
  toolContextId: string;
  signal?: AbortSignal;
  onNestedToolApproval?: (request: {
    toolName: string;
    args: Record<string, unknown>;
    toolCallId: string;
    reason?: string;
    allowPersistence?: boolean;
    signal?: AbortSignal;
  }) => Promise<{ approved: boolean; args?: Record<string, unknown> }>;
}

const MAX_CALLS = 32;
const MAX_OUTPUT = 20_000;
const MAX_NESTED_RESULT = 2_000_000;
const MAX_SCRIPT = 64_000;

/** Execute only agent-scoped MCP calls in an isolated QuickJS/WASM worker. */
export async function code_mode(input: Record<string, unknown>) {
  const invocation = input._codeModeInvocation as Invocation | undefined;
  const code = input.code;
  if (
    !invocation?.toolContextId ||
    typeof code !== "string" ||
    code.length > MAX_SCRIPT
  ) {
    return {
      status: "error",
      output: "CodeMode requires code and a prepared turn context (max 64 KiB)",
    };
  }
  // Lazy: manager imports tool-definitions, which imports this module.
  const {
    checkToolPermission,
    executeCodeModeRemoteTool,
    getCodeModeCapabilities,
  } = await import("@/tools/manager");
  const capabilities = getCodeModeCapabilities(invocation.toolContextId);
  if (!capabilities)
    return { status: "error", output: "CodeMode turn context unavailable" };
  const agentId = capabilities.agentId;
  if (!agentId)
    return {
      status: "error",
      output: "CodeMode requires an agent-scoped MCP context",
    };
  let catalog: McpToolCatalog;
  try {
    catalog = await buildMcpToolCatalog({}, agentId);
  } catch {
    return {
      status: "error",
      output:
        "MCP catalog unavailable; check agent connections and credentials",
    };
  }
  const tools = new Map(catalog.tools.map((tool) => [tool.schema.name, tool]));
  let calls = 0;
  const audit: string[] = [];
  const invoke = async (name: unknown, value: unknown, signal: AbortSignal) => {
    if (typeof name !== "string" || !isRecord(value))
      throw new Error("Invalid MCP tool call");
    const tool = tools.get(name);
    if (!tool) throw new Error("MCP tool is not available in this agent scope");
    if (++calls > MAX_CALLS) throw new Error("MCP tool call limit reached");
    if (JSON.stringify(value).length > MAX_SCRIPT)
      throw new Error("MCP tool arguments exceed 64 KiB");
    const args = value as Record<string, unknown>;
    const toolCallId = `codemode-${randomUUID()}`;
    let status = "error";
    try {
      if (signal.aborted || invocation.signal?.aborted)
        throw new Error("Aborted");
      if (!getCodeModeCapabilities(invocation.toolContextId))
        throw new Error("CodeMode turn context expired");
      const permission = await checkToolPermission(
        name,
        args,
        capabilities.workingDirectory,
        undefined,
        agentId,
        invocation.toolContextId,
        toolCallId,
      );
      if (permission.decision === "deny")
        throw new Error("MCP tool permission denied");
      let approvedArgs = args;
      if (permission.decision !== "allow") {
        if (!invocation.onNestedToolApproval)
          throw new Error("MCP tool approval unavailable");
        const approval = await invocation.onNestedToolApproval({
          toolName: name,
          args,
          toolCallId,
          reason: permission.reason ?? "MCP tool approval required",
          allowPersistence: permission.decision !== "alwaysAsk",
          signal,
        });
        if (!approval.approved) throw new Error("MCP tool approval denied");
        if (approval.args) {
          if (!isRecord(approval.args))
            throw new Error("Invalid approved arguments");
          approvedArgs = approval.args;
          const rechecked = await checkToolPermission(
            name,
            approvedArgs,
            capabilities.workingDirectory,
            undefined,
            agentId,
            invocation.toolContextId,
            toolCallId,
          );
          if (rechecked.decision === "deny")
            throw new Error("Modified arguments denied");
          if (
            rechecked.decision !== "allow" &&
            JSON.stringify(approvedArgs) !== JSON.stringify(args)
          )
            throw new Error("Modified arguments require new approval");
        }
      }
      if (signal.aborted || invocation.signal?.aborted)
        throw new Error("Aborted");
      if (!getCodeModeCapabilities(invocation.toolContextId))
        throw new Error("CodeMode turn context expired");
      const result = await executeCodeModeRemoteTool({
        toolContextId: invocation.toolContextId,
        toolName: name,
        toolCallId,
        args: approvedArgs,
        signal,
        run: async (finalArgs) => {
          let response: Awaited<ReturnType<typeof callMcpCatalogTool>>;
          try {
            response = await callMcpCatalogTool(
              tool,
              agentId,
              finalArgs,
              {},
              signal,
              true,
            );
          } catch {
            throw new Error(
              "MCP tool execution failed; check association and credentials",
            );
          }
          const serialized = JSON.stringify(response);
          if (serialized.length > MAX_NESTED_RESULT)
            throw new Error("MCP result exceeds 2 MiB");
          return {
            status: response.isError ? "error" : "success",
            toolReturn: serialized,
          };
        },
      });
      status = result.status;
      return { status, output: result.toolReturn };
    } finally {
      audit.push(
        `${name}(${Object.keys(args).slice(0, 20).join(", ")}): ${status}`,
      );
    }
  };
  let sandbox: CodemodeSandbox | undefined;
  try {
    sandbox = new CodemodeSandbox({
      timeoutMs: 120_000,
      memoryLimitBytes: 64 * 1024 * 1024,
      globals: [
        {
          name: "tool.call",
          spread: true,
          execute: async (args, ctx) => {
            const [name, value] = args as unknown[];
            return invoke(name, value, ctx.signal);
          },
        },
        {
          name: "tool.list",
          execute: () =>
            [...tools.values()].slice(0, 100).map(({ schema }) => ({
              name: schema.name,
              description: (schema.description ?? "").slice(0, 300),
            })),
        },
        {
          name: "tool.search",
          spread: true,
          execute: (args) => {
            const [query] = args as unknown[];
            if (typeof query !== "string" || query.length > 200)
              throw new Error("Invalid MCP search query");
            const needle = query.toLowerCase();
            return [...tools.values()]
              .filter(({ schema }) =>
                `${schema.name} ${schema.description ?? ""}`
                  .toLowerCase()
                  .includes(needle),
              )
              .slice(0, 20)
              .map(({ schema }) => ({
                name: schema.name,
                description: (schema.description ?? "").slice(0, 300),
              }));
          },
        },
        {
          name: "tool.describe",
          spread: true,
          execute: (args) => {
            const [name] = args as unknown[];
            if (typeof name !== "string")
              throw new Error("Invalid MCP tool name");
            const schema = tools.get(name)?.schema;
            if (!schema)
              throw new Error("MCP tool is not available in this agent scope");
            const description = {
              name: schema.name,
              description: schema.description,
              inputSchema: schema.inputSchema,
            };
            if (JSON.stringify(description).length > MAX_SCRIPT)
              throw new Error("MCP tool schema exceeds 64 KiB");
            return description;
          },
        },
      ],
    });
    const result = await sandbox.execute(code, { signal: invocation.signal });
    const display = result.output
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    const response = result.ok
      ? { output: display, value: result.value }
      : { output: display, error: result.error.message };
    return {
      status: result.ok ? "success" : "error",
      output: scrubAmbientSecrets(
        JSON.stringify({ ...response, calls: audit }).slice(0, MAX_OUTPUT),
      ),
    };
  } catch (error) {
    return {
      status: "error",
      output: scrubAmbientSecrets(String(error).slice(0, 1000)),
    };
  } finally {
    await sandbox?.close();
    await catalog.close();
  }
}
