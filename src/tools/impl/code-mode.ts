import { randomUUID } from "node:crypto";
import {
  CodemodeSandbox,
  toCodemodeIdentifier,
} from "@earendil-works/pi-codemode";
import {
  buildMcpToolCatalog,
  callMcpCatalogTool,
  type McpToolCatalog,
} from "@/mcp-tool-catalog";
import { scrubAmbientSecrets } from "@/tools/secret-substitution";
import { getServerToolName } from "@/tools/tool-name-mapping";
import { isRecord } from "@/utils/type-guards";

interface Invocation {
  toolContextId: string;
  signal?: AbortSignal;
  onFileWrite?: (filePath: string, content: string) => void;
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

type ScriptTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
  run: (
    args: Record<string, unknown>,
    toolCallId: string,
    signal: AbortSignal,
  ) => Promise<unknown>;
};

function textParts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) =>
    isRecord(part) && part.type === "text" && typeof part.text === "string"
      ? [part.text]
      : [],
  );
}

/** Text-only MCP content resolves to its (JSON-parsed when possible) text. */
function mcpValue(result: {
  content: unknown[];
  structuredContent?: Record<string, unknown>;
}): unknown {
  if (result.structuredContent) return result.structuredContent;
  const text = textParts(result.content);
  if (text.length === 0 || text.length !== result.content.length)
    return result.content;
  const joined = text.join("\n");
  try {
    return JSON.parse(joined);
  } catch {
    return joined;
  }
}

/** Execute built-in and agent-scoped MCP tools in an isolated QuickJS/WASM worker. */
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
    executeTool,
    getCodeModeCapabilities,
  } = await import("@/tools/manager");
  const capabilities = getCodeModeCapabilities(invocation.toolContextId);
  if (!capabilities)
    return { status: "error", output: "CodeMode turn context unavailable" };
  const agentId = capabilities.agentId;
  const warnings: string[] = [];
  let catalog: McpToolCatalog | undefined;
  if (agentId) {
    try {
      catalog = await buildMcpToolCatalog({}, agentId);
    } catch {
      warnings.push(
        "MCP catalog unavailable; check agent connections and credentials",
      );
    }
  }
  const tools = new Map<string, ScriptTool>();
  // Built-ins run through executeTool, which owns hooks, mod events, and redaction.
  for (const schema of capabilities.builtins) {
    if (schema.name === "CodeMode") continue;
    const name = getServerToolName(schema.name);
    tools.set(name, {
      name,
      description: schema.description,
      inputSchema: schema.input_schema,
      run: async (args, toolCallId, signal) => {
        const result = await executeTool(schema.name, args, {
          toolContextId: invocation.toolContextId,
          toolCallId,
          signal,
          onFileWrite: invocation.onFileWrite,
        });
        const output = textParts(result.toolReturn).join("\n");
        if (output.length > MAX_NESTED_RESULT)
          throw new Error(`${name} result exceeds 2 MiB`);
        if (result.status === "error")
          throw new Error(output.slice(0, 2_000) || `${name} failed`);
        return output;
      },
    });
  }
  for (const tool of catalog?.tools ?? []) {
    const { name, description, inputSchema } = tool.schema;
    if (!agentId || tools.has(name)) continue;
    tools.set(name, {
      name,
      description,
      inputSchema,
      run: async (args, toolCallId, signal) => {
        const result = await executeCodeModeRemoteTool({
          toolContextId: invocation.toolContextId,
          toolName: name,
          toolCallId,
          args,
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
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(result.toolReturn));
        } catch {
          parsed = undefined;
        }
        const response =
          isRecord(parsed) && Array.isArray(parsed.content)
            ? (parsed as {
                content: unknown[];
                structuredContent?: Record<string, unknown>;
              })
            : undefined;
        if (result.status === "error")
          throw new Error(
            (response
              ? textParts(response.content).join("\n")
              : String(result.toolReturn)
            ).slice(0, 2_000) || `${name} failed`,
          );
        // Hooks or mods may replace the output; pass non-MCP text through.
        return response ? mcpValue(response) : result.toolReturn;
      },
    });
  }
  let calls = 0;
  const audit: string[] = [];
  const invoke = async (name: string, value: unknown, signal: AbortSignal) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`Tool is not available: ${name}`);
    if (!isRecord(value))
      throw new Error(`${name} expects one object argument`);
    if (++calls > MAX_CALLS) throw new Error("Tool call limit reached");
    if (JSON.stringify(value).length > MAX_SCRIPT)
      throw new Error("Tool arguments exceed 64 KiB");
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
        throw new Error(`${name} permission denied`);
      let approvedArgs = args;
      if (permission.decision !== "allow") {
        if (!invocation.onNestedToolApproval)
          throw new Error(`${name} approval unavailable`);
        const approval = await invocation.onNestedToolApproval({
          toolName: name,
          args,
          toolCallId,
          reason: permission.reason ?? "Tool approval required",
          allowPersistence: permission.decision !== "alwaysAsk",
          signal,
        });
        if (!approval.approved) throw new Error(`${name} approval denied`);
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
      const result = await tool.run(approvedArgs, toolCallId, signal);
      status = "success";
      return result;
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
      tools: [...tools.values()].map((tool) => ({
        name: tool.name,
        description: (tool.description ?? "").slice(0, 300),
        execute: (args, ctx) => invoke(tool.name, args, ctx.signal),
      })),
      globals: [
        {
          name: "describeTool",
          execute: (name) => {
            if (typeof name !== "string") throw new Error("Invalid tool name");
            const tool =
              tools.get(name) ??
              [...tools.values()].find(
                (candidate) => toCodemodeIdentifier(candidate.name) === name,
              );
            if (!tool) return undefined;
            const description = {
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
            };
            if (JSON.stringify(description).length > MAX_SCRIPT)
              throw new Error("Tool schema exceeds 64 KiB");
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
    if (warnings.length) Object.assign(response, { warnings });
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
    await catalog?.close();
  }
}
