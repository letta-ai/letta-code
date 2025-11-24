import type Letta from "@letta-ai/letta-client";
import {
  AuthenticationError,
  PermissionDeniedError,
} from "@letta-ai/letta-client";
import { getModelInfo } from "../agent/model";
import { TOOL_DEFINITIONS, type ToolName } from "./toolDefinitions";

export const TOOL_NAMES = Object.keys(TOOL_DEFINITIONS) as ToolName[];

const ANTHROPIC_DEFAULT_TOOLS: ToolName[] = [
  "Bash",
  "BashOutput",
  "Edit",
  "ExitPlanMode",
  "Glob",
  "Grep",
  "KillBash",
  "LS",
  "MultiEdit",
  "Read",
  "TodoWrite",
  "Write",
];

const OPENAI_DEFAULT_TOOLS: ToolName[] = [
  "shell_command",
  "shell",
  "read_file",
  "list_dir",
  "grep_files",
  "apply_patch",
];

// Tool permissions configuration
const TOOL_PERMISSIONS: Record<ToolName, { requiresApproval: boolean }> = {
  Bash: { requiresApproval: true },
  BashOutput: { requiresApproval: false },
  Edit: { requiresApproval: true },
  ExitPlanMode: { requiresApproval: false },
  Glob: { requiresApproval: false },
  Grep: { requiresApproval: false },
  KillBash: { requiresApproval: true },
  LS: { requiresApproval: false },
  MultiEdit: { requiresApproval: true },
  Read: { requiresApproval: false },
  TodoWrite: { requiresApproval: false },
  Write: { requiresApproval: true },
  shell_command: { requiresApproval: true },
  shell: { requiresApproval: true },
  read_file: { requiresApproval: false },
  list_dir: { requiresApproval: false },
  grep_files: { requiresApproval: false },
  apply_patch: { requiresApproval: true },
};

interface JsonSchema {
  properties?: Record<string, JsonSchema>;
  required?: string[];
  [key: string]: unknown;
}

type ToolArgs = Record<string, unknown>;

interface ToolSchema {
  name: string;
  description: string;
  input_schema: JsonSchema;
}

interface ToolDefinition {
  schema: ToolSchema;
  fn: (args: ToolArgs) => Promise<unknown>;
}

export type ToolExecutionResult = {
  toolReturn: string;
  status: "success" | "error";
  stdout?: string[];
  stderr?: string[];
};

type ToolRegistry = Map<string, ToolDefinition>;

// Use globalThis to ensure singleton across bundle
// This prevents Bun's bundler from creating duplicate instances of the registry
const REGISTRY_KEY = Symbol.for("@letta/toolRegistry");

type GlobalWithRegistry = typeof globalThis & {
  [key: symbol]: ToolRegistry;
};

function getRegistry(): ToolRegistry {
  const global = globalThis as GlobalWithRegistry;
  if (!global[REGISTRY_KEY]) {
    global[REGISTRY_KEY] = new Map();
  }
  return global[REGISTRY_KEY];
}

const toolRegistry = getRegistry();

/**
 * Generates a Python stub for a tool that will be executed client-side.
 * This is registered with Letta so the agent knows about the tool.
 */
function generatePythonStub(
  name: string,
  _description: string,
  schema: JsonSchema,
): string {
  const params = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const required = schema.required ?? [];

  // Generate function parameters
  const paramList = Object.keys(params)
    .map((key) => {
      const isRequired = required.includes(key);
      return isRequired ? key : `${key}=None`;
    })
    .join(", ");

  return `def ${name}(${paramList}):
    """Stub method. This tool is executed client-side via the approval flow.
    """
    raise Exception("This is a stub tool. Execution should happen on client.")  
`;
}

/**
 * Get permissions for a specific tool.
 * @param toolName - The name of the tool
 * @returns Tool permissions object with requiresApproval flag
 */
export function getToolPermissions(toolName: string) {
  return TOOL_PERMISSIONS[toolName as ToolName] || { requiresApproval: false };
}

/**
 * Check if a tool requires approval before execution.
 * @param toolName - The name of the tool
 * @returns true if the tool requires approval, false otherwise
 * @deprecated Use checkToolPermission instead for full permission system support
 */
export function requiresApproval(toolName: string): boolean {
  return TOOL_PERMISSIONS[toolName as ToolName]?.requiresApproval ?? false;
}

/**
 * Check permission for a tool execution using the full permission system.
 * @param toolName - Name of the tool
 * @param toolArgs - Tool arguments
 * @param workingDirectory - Current working directory (defaults to process.cwd())
 * @returns Permission decision: "allow", "deny", or "ask"
 */
export async function checkToolPermission(
  toolName: string,
  toolArgs: ToolArgs,
  workingDirectory: string = process.cwd(),
): Promise<{
  decision: "allow" | "deny" | "ask";
  matchedRule?: string;
  reason?: string;
}> {
  const { checkPermission } = await import("../permissions/checker");
  const { loadPermissions } = await import("../permissions/loader");

  const permissions = await loadPermissions(workingDirectory);
  return checkPermission(toolName, toolArgs, permissions, workingDirectory);
}

/**
 * Save a permission rule to settings
 * @param rule - Permission rule (e.g., "Read(src/**)")
 * @param ruleType - Type of rule ("allow", "deny", or "ask")
 * @param scope - Where to save ("project", "local", "user", or "session")
 * @param workingDirectory - Current working directory
 */
export async function savePermissionRule(
  rule: string,
  ruleType: "allow" | "deny" | "ask",
  scope: "project" | "local" | "user" | "session",
  workingDirectory: string = process.cwd(),
): Promise<void> {
  // Handle session-only permissions
  if (scope === "session") {
    const { sessionPermissions } = await import("../permissions/session");
    sessionPermissions.addRule(rule, ruleType);
    return;
  }

  // Handle persisted permissions
  const { savePermissionRule: save } = await import("../permissions/loader");
  await save(rule, ruleType, scope, workingDirectory);
}

/**
 * Analyze approval context for a tool execution
 * @param toolName - Name of the tool
 * @param toolArgs - Tool arguments
 * @param workingDirectory - Current working directory
 * @returns Approval context with recommended rule and button text
 */
export async function analyzeToolApproval(
  toolName: string,
  toolArgs: ToolArgs,
  workingDirectory: string = process.cwd(),
): Promise<import("../permissions/analyzer").ApprovalContext> {
  const { analyzeApprovalContext } = await import("../permissions/analyzer");
  return analyzeApprovalContext(toolName, toolArgs, workingDirectory);
}

/**
 * Loads all tools defined in TOOL_NAMES and constructs their full schemas + function references.
 * This should be called on program startup.
 * Will error if any expected tool files are missing.
 *
 * @returns Promise that resolves when all tools are loaded
 */
export async function loadTools(modelIdentifier?: string): Promise<void> {
  const { toolFilter } = await import("./filter");
  const filterActive = toolFilter.isActive();

  let baseToolNames: ToolName[];
  if (!filterActive && modelIdentifier && isOpenAIModel(modelIdentifier)) {
    baseToolNames = OPENAI_DEFAULT_TOOLS;
  } else if (!filterActive) {
    baseToolNames = ANTHROPIC_DEFAULT_TOOLS;
  } else {
    // When user explicitly sets --tools, respect that and allow any tool name
    baseToolNames = TOOL_NAMES;
  }

  for (const name of baseToolNames) {
    if (!toolFilter.isEnabled(name)) {
      continue;
    }

    try {
      const definition = TOOL_DEFINITIONS[name];
      if (!definition) {
        throw new Error(`Missing tool definition for ${name}`);
      }

      if (!definition.impl) {
        throw new Error(`Tool implementation not found for ${name}`);
      }

      const toolSchema: ToolSchema = {
        name,
        description: definition.description,
        input_schema: definition.schema,
      };

      toolRegistry.set(name, {
        schema: toolSchema,
        fn: definition.impl,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : JSON.stringify(error);
      throw new Error(
        `Required tool "${name}" could not be loaded from bundled assets. ${message}`,
      );
    }
  }
}

function isOpenAIModel(modelIdentifier: string): boolean {
  const info = getModelInfo(modelIdentifier);
  if (info?.handle && typeof info.handle === "string") {
    return info.handle.startsWith("openai/");
  }
  // Fallback: treat raw handle-style identifiers as OpenAI if they start with openai/
  return modelIdentifier.startsWith("openai/");
}

/**
 * Upserts all loaded tools to the Letta server with retry logic.
 * This registers Python stubs so the agent knows about the tools,
 * while actual execution happens client-side via the approval flow.
 *
 * Implements resilient retry logic:
 * - Retries if operation takes more than 5 seconds
 * - Keeps retrying up to 30 seconds total
 * - Uses exponential backoff between retries
 *
 * @param client - Letta client instance
 * @returns Promise that resolves when all tools are registered
 */
export async function upsertToolsToServer(client: Letta): Promise<void> {
  const OPERATION_TIMEOUT = 5000; // 5 seconds
  const MAX_TOTAL_TIME = 30000; // 30 seconds
  const startTime = Date.now();

  async function attemptUpsert(retryCount: number = 0): Promise<void> {
    const attemptStartTime = Date.now();

    // Check if we've exceeded total time budget
    if (Date.now() - startTime > MAX_TOTAL_TIME) {
      throw new Error(
        "Tool upserting exceeded maximum time limit (30s). Please check your network connection and try again.",
      );
    }

    try {
      // Create a timeout promise
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error("Tool upsert operation timed out (5s)"));
        }, OPERATION_TIMEOUT);
      });

      // Race the upsert against the timeout
      const upsertPromise = Promise.all(
        Array.from(toolRegistry.entries()).map(async ([name, tool]) => {
          const pythonStub = generatePythonStub(
            name,
            tool.schema.description,
            tool.schema.input_schema,
          );

          // Construct the full JSON schema in Letta's expected format
          const fullJsonSchema = {
            name,
            description: tool.schema.description,
            parameters: tool.schema.input_schema,
          };

          await client.tools.upsert({
            default_requires_approval: true,
            source_code: pythonStub,
            json_schema: fullJsonSchema,
          });
        }),
      );

      await Promise.race([upsertPromise, timeoutPromise]);

      // Success! Operation completed within timeout
      return;
    } catch (error) {
      const elapsed = Date.now() - attemptStartTime;
      const totalElapsed = Date.now() - startTime;

      // Check if this is an auth error - fail immediately without retrying
      if (
        error instanceof AuthenticationError ||
        error instanceof PermissionDeniedError
      ) {
        throw new Error(
          `Authentication failed. Please check your LETTA_API_KEY.\n` +
            `Run 'rm ~/.letta/settings.json' and restart to re-authenticate.\n` +
            `Original error: ${error.message}`,
        );
      }

      // If we still have time, retry with exponential backoff
      if (totalElapsed < MAX_TOTAL_TIME) {
        const backoffDelay = Math.min(1000 * 2 ** retryCount, 5000); // Max 5s backoff
        const remainingTime = MAX_TOTAL_TIME - totalElapsed;

        console.error(
          `Tool upsert attempt ${retryCount + 1} failed after ${elapsed}ms. Retrying in ${backoffDelay}ms... (${Math.round(remainingTime / 1000)}s remaining)`,
        );
        console.error(
          `Error: ${error instanceof Error ? error.message : String(error)}`,
        );

        await new Promise((resolve) => setTimeout(resolve, backoffDelay));
        return attemptUpsert(retryCount + 1);
      }

      // Out of time, throw the error
      throw error;
    }
  }

  await attemptUpsert();
}

/**
 * Helper to clip tool return text to a reasonable display size
 * Used by UI components to truncate long responses for display
 */
export function clipToolReturn(
  text: string,
  maxLines: number = 3,
  maxChars: number = 300,
): string {
  if (!text) return text;

  // First apply character limit to avoid extremely long text
  let clipped = text;
  if (text.length > maxChars) {
    clipped = text.slice(0, maxChars);
  }

  // Then split into lines and limit line count
  const lines = clipped.split("\n");
  if (lines.length > maxLines) {
    clipped = lines.slice(0, maxLines).join("\n");
  }

  // Add ellipsis if we truncated
  if (text.length > maxChars || lines.length > maxLines) {
    // Try to break at a word boundary if possible
    const lastSpace = clipped.lastIndexOf(" ");
    if (lastSpace > maxChars * 0.8) {
      clipped = clipped.slice(0, lastSpace);
    }
    clipped += "…";
  }

  return clipped;
}

/**
 * Flattens a tool response to a simple string format.
 * Extracts the actual content from structured responses to match what the LLM expects.
 *
 * @param result - The raw result from a tool execution
 * @returns A flattened string representation of the result
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function flattenToolResponse(result: unknown): string {
  if (result === null || result === undefined) {
    return "";
  }

  if (typeof result === "string") {
    return result;
  }

  if (!isRecord(result)) {
    return JSON.stringify(result);
  }

  if (typeof result.message === "string") {
    return result.message;
  }

  if (typeof result.content === "string") {
    return result.content;
  }

  if (Array.isArray(result.content)) {
    const textContent = result.content
      .filter(
        (item): item is { type: string; text: string } =>
          isRecord(item) &&
          item.type === "text" &&
          typeof item.text === "string",
      )
      .map((item) => item.text)
      .join("\n");

    if (textContent) {
      return textContent;
    }
  }

  if (typeof result.output === "string") {
    return result.output;
  }

  if (Array.isArray(result.files)) {
    const files = result.files.filter(
      (file): file is string => typeof file === "string",
    );
    if (files.length === 0) {
      return "No files found";
    }
    return `Found ${files.length} file${files.length === 1 ? "" : "s"}\n${files.join("\n")}`;
  }

  if (typeof result.killed === "boolean") {
    return result.killed
      ? "Process killed successfully"
      : "Failed to kill process (may have already exited)";
  }

  if (typeof result.error === "string") {
    return result.error;
  }

  if (Array.isArray(result.todos)) {
    return `Updated ${result.todos.length} todo${result.todos.length !== 1 ? "s" : ""}`;
  }

  return JSON.stringify(result);
}

/**
 * Executes a tool by name with the provided arguments.
 *
 * @param name - The name of the tool to execute
 * @param args - Arguments object to pass to the tool
 * @returns Promise with the tool's execution result including status and optional stdout/stderr
 */
export async function executeTool(
  name: string,
  args: ToolArgs,
  options?: { signal?: AbortSignal },
): Promise<ToolExecutionResult> {
  const tool = toolRegistry.get(name);

  if (!tool) {
    return {
      toolReturn: `Tool not found: ${name}. Available tools: ${Array.from(toolRegistry.keys()).join(", ")}`,
      status: "error",
    };
  }

  try {
    // Inject abort signal for tools that support it (currently Bash) without altering schemas
    const argsWithSignal =
      name === "Bash" && options?.signal
        ? { ...args, signal: options.signal }
        : args;

    const result = await tool.fn(argsWithSignal);

    // Extract stdout/stderr if present (for bash tools)
    const recordResult = isRecord(result) ? result : undefined;
    const stdoutValue = recordResult?.stdout;
    const stderrValue = recordResult?.stderr;
    const stdout = isStringArray(stdoutValue) ? stdoutValue : undefined;
    const stderr = isStringArray(stderrValue) ? stderrValue : undefined;
    // Flatten the response to plain text
    const flattenedResponse = flattenToolResponse(result);

    // Return the full response (truncation happens in UI layer only)
    return {
      toolReturn: flattenedResponse,
      status: "success",
      ...(stdout && { stdout }),
      ...(stderr && { stderr }),
    };
  } catch (error) {
    const isAbort =
      error instanceof Error &&
      (error.name === "AbortError" ||
        error.message === "The operation was aborted" ||
        // node:child_process AbortError may include code/message variants
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (error as any).code === "ABORT_ERR");

    if (isAbort) {
      return {
        toolReturn: "User interrupted tool execution",
        status: "error",
      };
    }

    // Don't console.error here - it pollutes the TUI
    // The error message is already returned in toolReturn
    return {
      toolReturn: error instanceof Error ? error.message : String(error),
      status: "error",
    };
  }
}

/**
 * Gets all loaded tool names (for passing to Letta agent creation).
 *
 * @returns Array of tool names
 */
export function getToolNames(): string[] {
  return Array.from(toolRegistry.keys());
}

/**
 * Returns all Letta Code tool names known to this build, regardless of what is currently loaded.
 * Useful for unlinking/removing tools when switching providers/models.
 */
export function getAllLettaToolNames(): string[] {
  return [...TOOL_NAMES];
}

/**
 * Gets all loaded tool schemas (for inspection/debugging).
 *
 * @returns Array of tool schemas
 */
export function getToolSchemas(): ToolSchema[] {
  return Array.from(toolRegistry.values()).map((tool) => tool.schema);
}

/**
 * Gets a single tool's schema by name.
 *
 * @param name - The tool name
 * @returns The tool schema or undefined if not found
 */
export function getToolSchema(name: string): ToolSchema | undefined {
  return toolRegistry.get(name)?.schema;
}

/**
 * Clears the tool registry (useful for testing).
 */
export function clearTools(): void {
  toolRegistry.clear();
}
