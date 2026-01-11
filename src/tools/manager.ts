import { getModelInfo } from "../agent/model";
import { getAllSubagentConfigs } from "../agent/subagents";
import { INTERRUPTED_BY_USER } from "../constants";
import { telemetry } from "../telemetry";
import { TOOL_DEFINITIONS, type ToolName } from "./toolDefinitions";

export const TOOL_NAMES = Object.keys(TOOL_DEFINITIONS) as ToolName[];

// Maps internal tool names to server/model-facing tool names
// This allows us to have multiple implementations (e.g., write_file_gemini, Write from Anthropic)
// that map to the same server tool name since only one toolset is active at a time
const TOOL_NAME_MAPPINGS: Partial<Record<ToolName, string>> = {
  // Gemini tools - map to their original Gemini CLI names
  glob_gemini: "glob",
  write_todos: "write_todos",
  write_file_gemini: "write_file",
  replace: "replace",
  search_file_content: "search_file_content",
  read_many_files: "read_many_files",
  read_file_gemini: "read_file",
  list_directory: "list_directory",
  run_shell_command: "run_shell_command",
};

/**
 * Get the server-facing name for a tool (maps internal names to what the model sees)
 */
export function getServerToolName(internalName: string): string {
  return TOOL_NAME_MAPPINGS[internalName as ToolName] || internalName;
}

/**
 * Get the internal tool name from a server-facing name
 * Used when the server sends back tool calls/approvals with server names
 */
export function getInternalToolName(serverName: string): string {
  // Build reverse mapping
  for (const [internal, server] of Object.entries(TOOL_NAME_MAPPINGS)) {
    if (server === serverName) {
      return internal;
    }
  }
  // If not in mapping, the server name is the internal name
  return serverName;
}

export const ANTHROPIC_DEFAULT_TOOLS: ToolName[] = [
  "AskUserQuestion",
  "Bash",
  "BashOutput",
  "Edit",
  "EnterPlanMode",
  "ExitPlanMode",
  "Glob",
  "Grep",
  "KillBash",
  // "MultiEdit",
  // "LS",
  "Read",
  "Skill",
  "Task",
  "TodoWrite",
  "Write",
];

export const OPENAI_DEFAULT_TOOLS: ToolName[] = [
  "shell_command",
  "shell",
  "read_file",
  "list_dir",
  "grep_files",
  "apply_patch",
  "update_plan",
  "Skill",
  "Task",
];

export const GEMINI_DEFAULT_TOOLS: ToolName[] = [
  "run_shell_command",
  "read_file_gemini",
  "list_directory",
  "glob_gemini",
  "search_file_content",
  "replace",
  "write_file_gemini",
  "write_todos",
  "read_many_files",
  "Skill",
  "Task",
];

// PascalCase toolsets (codex-2 and gemini-2) for consistency with Skill tool naming
export const OPENAI_PASCAL_TOOLS: ToolName[] = [
  // Additional Letta Code tools
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "Task",
  "Skill",
  // Standard Codex tools
  "ShellCommand",
  "Shell",
  "ReadFile",
  "ListDir",
  "GrepFiles",
  "ApplyPatch",
  "UpdatePlan",
];

export const GEMINI_PASCAL_TOOLS: ToolName[] = [
  // Additional Letta Code tools
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "Skill",
  "Task",
  // Standard Gemini tools
  "RunShellCommand",
  "ReadFileGemini",
  "ListDirectory",
  "GlobGemini",
  "SearchFileContent",
  "Replace",
  "WriteFileGemini",
  "WriteTodos",
  "ReadManyFiles",
];

// Tool permissions configuration
const TOOL_PERMISSIONS: Record<ToolName, { requiresApproval: boolean }> = {
  AskUserQuestion: { requiresApproval: true },
  Bash: { requiresApproval: true },
  BashOutput: { requiresApproval: false },
  Edit: { requiresApproval: true },
  EnterPlanMode: { requiresApproval: true },
  ExitPlanMode: { requiresApproval: false },
  Glob: { requiresApproval: false },
  Grep: { requiresApproval: false },
  KillBash: { requiresApproval: true },
  LS: { requiresApproval: false },
  MultiEdit: { requiresApproval: true },
  Read: { requiresApproval: false },
  ReadLSP: { requiresApproval: false },
  Skill: { requiresApproval: false },
  Task: { requiresApproval: true },
  TodoWrite: { requiresApproval: false },
  Write: { requiresApproval: true },
  shell_command: { requiresApproval: true },
  shell: { requiresApproval: true },
  read_file: { requiresApproval: false },
  list_dir: { requiresApproval: false },
  grep_files: { requiresApproval: false },
  apply_patch: { requiresApproval: true },
  update_plan: { requiresApproval: false },
  // Gemini toolset
  glob_gemini: { requiresApproval: false },
  list_directory: { requiresApproval: false },
  read_file_gemini: { requiresApproval: false },
  read_many_files: { requiresApproval: false },
  replace: { requiresApproval: true },
  run_shell_command: { requiresApproval: true },
  search_file_content: { requiresApproval: false },
  write_todos: { requiresApproval: false },
  write_file_gemini: { requiresApproval: true },
  // Codex-2 toolset (PascalCase)
  ShellCommand: { requiresApproval: true },
  Shell: { requiresApproval: true },
  ReadFile: { requiresApproval: false },
  ListDir: { requiresApproval: false },
  GrepFiles: { requiresApproval: false },
  ApplyPatch: { requiresApproval: true },
  UpdatePlan: { requiresApproval: false },
  // Gemini-2 toolset (PascalCase)
  RunShellCommand: { requiresApproval: true },
  ReadFileGemini: { requiresApproval: false },
  ListDirectory: { requiresApproval: false },
  GlobGemini: { requiresApproval: false },
  SearchFileContent: { requiresApproval: false },
  Replace: { requiresApproval: true },
  WriteFileGemini: { requiresApproval: true },
  WriteTodos: { requiresApproval: false },
  ReadManyFiles: { requiresApproval: false },
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
 * Resolve a server/visible tool name to an internal tool name
 * based on the currently loaded toolset.
 *
 * - If a tool with the exact name is loaded, prefer that.
 * - Otherwise, fall back to the alias mapping used for Gemini tools.
 * - Returns undefined if no matching tool is loaded.
 */
function resolveInternalToolName(name: string): string | undefined {
  if (toolRegistry.has(name)) {
    return name;
  }

  const internalName = getInternalToolName(name);
  if (toolRegistry.has(internalName)) {
    return internalName;
  }

  return undefined;
}

/**
 * ClientTool interface matching the Letta SDK's expected format.
 * Used when passing client-side tools via the client_tools field.
 */
export interface ClientTool {
  name: string;
  description?: string | null;
  parameters?: { [key: string]: unknown } | null;
}

/**
 * Get all loaded tools in the format expected by the Letta API's client_tools field.
 * Maps internal tool names to server-facing names for proper tool invocation.
 */
export function getClientToolsFromRegistry(): ClientTool[] {
  return Array.from(toolRegistry.entries()).map(([name, tool]) => {
    const serverName = getServerToolName(name);
    return {
      name: serverName,
      description: tool.schema.description,
      parameters: tool.schema.input_schema,
    };
  });
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
 * Loads specific tools by name into the registry.
 * Used when resuming an agent to load only the tools attached to that agent.
 *
 * @param toolNames - Array of specific tool names to load
 */
export async function loadSpecificTools(toolNames: string[]): Promise<void> {
  for (const name of toolNames) {
    // Skip if tool filter is active and this tool is not enabled
    const { toolFilter } = await import("./filter");
    if (!toolFilter.isEnabled(name)) {
      continue;
    }

    // Map server-facing name to our internal tool name
    const internalName = getInternalToolName(name);

    const definition = TOOL_DEFINITIONS[internalName as ToolName];
    if (!definition) {
      console.warn(
        `Tool ${name} (internal: ${internalName}) not found in definitions, skipping`,
      );
      continue;
    }

    if (!definition.impl) {
      throw new Error(`Tool implementation not found for ${internalName}`);
    }

    const toolSchema: ToolSchema = {
      name: internalName,
      description: definition.description,
      input_schema: definition.schema,
    };

    // Register under the internal name so later lookups using mapping succeed
    toolRegistry.set(internalName, {
      schema: toolSchema,
      fn: definition.impl,
    });
  }
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

  // Get all subagents (built-in + custom) to inject into Task description
  const allSubagentConfigs = await getAllSubagentConfigs();
  const discoveredSubagents = Object.entries(allSubagentConfigs).map(
    ([name, config]) => ({
      name,
      description: config.description,
      recommendedModel: config.recommendedModel,
    }),
  );
  const filterActive = toolFilter.isActive();

  let baseToolNames: ToolName[];
  if (!filterActive && modelIdentifier && isGeminiModel(modelIdentifier)) {
    baseToolNames = GEMINI_PASCAL_TOOLS;
  } else if (
    !filterActive &&
    modelIdentifier &&
    isOpenAIModel(modelIdentifier)
  ) {
    baseToolNames = OPENAI_PASCAL_TOOLS;
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

      // For Task tool, inject discovered subagent descriptions
      let description = definition.description;
      if (name === "Task" && discoveredSubagents.length > 0) {
        description = injectSubagentsIntoTaskDescription(
          description,
          discoveredSubagents,
        );
      }

      const toolSchema: ToolSchema = {
        name,
        description,
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

  // If LSP is enabled, swap Read with LSP-enhanced version
  if (process.env.LETTA_ENABLE_LSP && toolRegistry.has("Read")) {
    const lspDefinition = TOOL_DEFINITIONS.ReadLSP;
    if (lspDefinition) {
      // Replace Read with ReadLSP (but keep the name "Read" for the agent)
      toolRegistry.set("Read", {
        schema: {
          name: "Read", // Keep the tool name as "Read" for the agent
          description: lspDefinition.description,
          input_schema: lspDefinition.schema,
        },
        fn: lspDefinition.impl,
      });
    }
  }
}

export function isOpenAIModel(modelIdentifier: string): boolean {
  const info = getModelInfo(modelIdentifier);
  if (info?.handle && typeof info.handle === "string") {
    return info.handle.startsWith("openai/");
  }
  // Fallback: treat raw handle-style identifiers as OpenAI if they start with openai/
  return modelIdentifier.startsWith("openai/");
}

export function isGeminiModel(modelIdentifier: string): boolean {
  const info = getModelInfo(modelIdentifier);
  if (info?.handle && typeof info.handle === "string") {
    return (
      info.handle.startsWith("google/") || info.handle.startsWith("google_ai/")
    );
  }
  // Fallback: treat raw handle-style identifiers as Gemini
  return (
    modelIdentifier.startsWith("google/") ||
    modelIdentifier.startsWith("google_ai/")
  );
}

/**
 * Inject discovered subagent descriptions into the Task tool description
 */
function injectSubagentsIntoTaskDescription(
  baseDescription: string,
  subagents: Array<{
    name: string;
    description: string;
    recommendedModel: string;
  }>,
): string {
  if (subagents.length === 0) {
    return baseDescription;
  }

  // Build subagents section
  const agentsSection = subagents
    .map((agent) => {
      return `### ${agent.name}
- **Purpose**: ${agent.description}
- **Recommended model**: ${agent.recommendedModel}`;
    })
    .join("\n\n");

  // Insert before ## Usage section
  const usageMarker = "## Usage";
  const usageIndex = baseDescription.indexOf(usageMarker);

  if (usageIndex === -1) {
    // Fallback: append at the end
    return `${baseDescription}\n\n## Available Agents\n\n${agentsSection}`;
  }

  // Insert agents section before ## Usage
  const before = baseDescription.slice(0, usageIndex);
  const after = baseDescription.slice(usageIndex);

  return `${before}## Available Agents\n\n${agentsSection}\n\n${after}`;
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
 * @param options - Optional execution options (abort signal, tool call ID, streaming callback)
 * @returns Promise with the tool's execution result including status and optional stdout/stderr
 */
export async function executeTool(
  name: string,
  args: ToolArgs,
  options?: {
    signal?: AbortSignal;
    toolCallId?: string;
    onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
  },
): Promise<ToolExecutionResult> {
  const internalName = resolveInternalToolName(name);
  if (!internalName) {
    return {
      toolReturn: `Tool not found: ${name}. Available tools: ${Array.from(toolRegistry.keys()).join(", ")}`,
      status: "error",
    };
  }

  const tool = toolRegistry.get(internalName);
  if (!tool) {
    return {
      toolReturn: `Tool not found: ${name}. Available tools: ${Array.from(toolRegistry.keys()).join(", ")}`,
      status: "error",
    };
  }

  const startTime = Date.now();

  try {
    // Inject options for tools that support them without altering schemas
    let enhancedArgs = args;

    // Inject abort signal and streaming callback for Bash tool
    if (internalName === "Bash") {
      if (options?.signal) {
        enhancedArgs = { ...enhancedArgs, signal: options.signal };
      }
      if (options?.onOutput) {
        enhancedArgs = { ...enhancedArgs, onOutput: options.onOutput };
      }
    }

    // Inject toolCallId and abort signal for Task tool
    if (internalName === "Task") {
      if (options?.toolCallId) {
        enhancedArgs = { ...enhancedArgs, toolCallId: options.toolCallId };
      }
      if (options?.signal) {
        enhancedArgs = { ...enhancedArgs, signal: options.signal };
      }
    }

    const result = await tool.fn(enhancedArgs);
    const duration = Date.now() - startTime;

    // Extract stdout/stderr if present (for bash tools)
    const recordResult = isRecord(result) ? result : undefined;
    const stdoutValue = recordResult?.stdout;
    const stderrValue = recordResult?.stderr;
    const stdout = isStringArray(stdoutValue) ? stdoutValue : undefined;
    const stderr = isStringArray(stderrValue) ? stderrValue : undefined;

    // Check if tool returned a status (e.g., Bash returns status: "error" on abort)
    const toolStatus = recordResult?.status === "error" ? "error" : "success";

    // Flatten the response to plain text
    const flattenedResponse = flattenToolResponse(result);

    // Track tool usage
    telemetry.trackToolUsage(
      internalName,
      toolStatus === "success",
      duration,
      flattenedResponse.length,
      toolStatus === "error" ? "tool_error" : undefined,
      stderr ? stderr.join("\n") : undefined,
    );

    // Return the full response (truncation happens in UI layer only)
    return {
      toolReturn: flattenedResponse,
      status: toolStatus,
      ...(stdout && { stdout }),
      ...(stderr && { stderr }),
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const isAbort =
      error instanceof Error &&
      (error.name === "AbortError" ||
        error.message === "The operation was aborted" ||
        // node:child_process AbortError may include code/message variants
        ("code" in error && error.code === "ABORT_ERR"));
    const errorType = isAbort
      ? "abort"
      : error instanceof Error
        ? error.name
        : "unknown";
    const errorMessage = isAbort
      ? INTERRUPTED_BY_USER
      : error instanceof Error
        ? error.message
        : String(error);

    // Track tool usage error
    telemetry.trackToolUsage(
      internalName,
      false,
      duration,
      errorMessage.length,
      errorType,
      errorMessage,
    );

    // Don't console.error here - it pollutes the TUI
    // The error message is already returned in toolReturn
    return {
      toolReturn: errorMessage,
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
  const internalName = resolveInternalToolName(name);
  if (!internalName) return undefined;
  return toolRegistry.get(internalName)?.schema;
}

/**
 * Clears the tool registry (useful for testing).
 */
export function clearTools(): void {
  toolRegistry.clear();
}
