// src/agent/approval-execution.ts
// Shared logic for executing approval batches (used by both interactive and headless modes)
import * as path from "node:path";
import type {
  ApprovalReturn,
  TextContent,
  ToolReturn,
} from "@letta-ai/letta-client/resources/agents/messages";
import type { ToolReturnMessage } from "@letta-ai/letta-client/resources/tools";
import type { ApprovalRequest } from "../cli/helpers/stream";
import { INTERRUPTED_BY_USER } from "../constants";
import {
  executeTool,
  type ToolExecutionResult,
  type ToolReturnContent,
} from "../tools/manager";

/**
 * Extract displayable text from tool return content (for UI display).
 * Multimodal content returns the text parts concatenated.
 */
export function getDisplayableToolReturn(content: ToolReturnContent): string {
  if (typeof content === "string") {
    return content;
  }
  // Extract text from multimodal content
  return content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/**
 * Tools that are safe to execute in parallel (read-only or independent).
 * These tools don't modify files or shared state, so they can't race with each other.
 * Note: Bash/shell tools are intentionally excluded - they can run arbitrary commands that may write files.
 *
 * Includes equivalent tools across all toolsets (Anthropic, Codex/OpenAI, Gemini).
 */
const PARALLEL_SAFE_TOOLS = new Set([
  // === Anthropic toolset (default) ===
  "Read",
  "view_image",
  "Grep",
  "Glob",

  // === Codex/OpenAI toolset ===
  // snake_case variants
  "read_file",
  "list_dir",
  "grep_files",
  // PascalCase variants
  "ReadFile",
  "ListDir",
  "GrepFiles",

  // === Gemini toolset ===
  // snake_case variants
  "read_file_gemini",
  "list_directory",
  "glob_gemini",
  "search_file_content",
  "read_many_files",
  // PascalCase variants
  "ReadFileGemini",
  "ListDirectory",
  "GlobGemini",
  "SearchFileContent",
  "ReadManyFiles",

  // === Cross-toolset tools ===
  // Search/fetch tools (external APIs or read-only queries)
  "conversation_search",
  "web_search",
  "fetch_webpage",
  // Background task output (read-only check)
  "TaskOutput",
  // Task spawns independent subagents
  "Task",
  // Plan mode tools (no parameters, no file operations)
  "EnterPlanMode",
  "ExitPlanMode",
]);

function isParallelSafe(toolName: string): boolean {
  return PARALLEL_SAFE_TOOLS.has(toolName);
}

/**
 * Tools that modify a single file and use `file_path` as their resource identifier.
 * These can run in parallel when targeting different files.
 */
const FILE_PATH_TOOLS = new Set([
  // Anthropic toolset
  "Edit",
  "Write",
  "MultiEdit",
  // Gemini toolset
  "replace",
  "write_file_gemini",
  "Replace",
  "WriteFileGemini",
]);

/**
 * Tools that use a global lock (can touch multiple resources or have arbitrary side effects).
 * These must serialize with ALL other write tools to prevent race conditions.
 */
const GLOBAL_LOCK_TOOLS = new Set([
  // Shell tools (arbitrary side effects)
  "Bash",
  "KillBash",
  "run_shell_command",
  "RunShellCommand",
  "shell_command",
  "shell",
  "ShellCommand",
  "Shell",
  // Patch tools (can touch multiple files in a single operation)
  "apply_patch",
  "ApplyPatch",
]);

/**
 * Extract the resource key for a tool execution.
 * Tools with the same resource key must be serialized to avoid race conditions.
 *
 * Note: Only call this for non-parallel-safe tools. Use isParallelSafe() first.
 *
 * @param toolName - The name of the tool being executed
 * @param toolArgs - The arguments passed to the tool
 * @returns Resource key string for grouping
 */
export function getResourceKey(
  toolName: string,
  toolArgs: Record<string, unknown>,
): string {
  // Global lock tools serialize with everything
  if (GLOBAL_LOCK_TOOLS.has(toolName)) {
    return "__global__";
  }

  // File-based tools use the file path as resource key
  if (FILE_PATH_TOOLS.has(toolName)) {
    const filePath = toolArgs.file_path;
    if (typeof filePath === "string") {
      // Normalize to absolute path for consistent comparison
      const userCwd = process.env.USER_CWD || process.cwd();
      return path.isAbsolute(filePath)
        ? path.normalize(filePath)
        : path.resolve(userCwd, filePath);
    }
  }

  // Unknown tools or missing file_path get global lock for safety
  return "__global__";
}

/** Result format expected by App.tsx for auto-allowed tools */
export type AutoAllowedResult = {
  toolCallId: string;
  result: ToolExecutionResult;
};

export type ApprovalDecision =
  | {
      type: "approve";
      approval: ApprovalRequest;
      // If set, skip executeTool and use this result (for fancy UI tools)
      precomputedResult?: ToolExecutionResult;
    }
  | { type: "deny"; approval: ApprovalRequest; reason: string };

// Align result type with the SDK's expected union for approvals payloads
export type ApprovalResult = ToolReturn | ApprovalReturn;

/**
 * Execute a single approval decision and return the result.
 * Extracted to allow parallel execution of Task tools.
 */
async function executeSingleDecision(
  decision: ApprovalDecision,
  onChunk?: (chunk: ToolReturnMessage) => void,
  options?: {
    abortSignal?: AbortSignal;
    onStreamingOutput?: (
      toolCallId: string,
      chunk: string,
      isStderr?: boolean,
    ) => void;
  },
): Promise<ApprovalResult> {
  // If aborted, record an interrupted result
  if (options?.abortSignal?.aborted) {
    if (onChunk) {
      onChunk({
        message_type: "tool_return_message",
        id: "dummy",
        date: new Date().toISOString(),
        tool_call_id: decision.approval.toolCallId,
        tool_return: INTERRUPTED_BY_USER,
        status: "error",
      });
    }
    return {
      type: "tool",
      tool_call_id: decision.approval.toolCallId,
      tool_return: INTERRUPTED_BY_USER,
      status: "error",
    };
  }

  if (decision.type === "approve") {
    // If fancy UI already computed the result, use it directly
    if (decision.precomputedResult) {
      return {
        type: "tool",
        tool_call_id: decision.approval.toolCallId,
        tool_return: decision.precomputedResult.toolReturn,
        status: decision.precomputedResult.status,
        stdout: decision.precomputedResult.stdout,
        stderr: decision.precomputedResult.stderr,
      };
    }

    // Execute the approved tool
    try {
      // Safe parse - toolArgs should be "{}" but handle edge cases
      let parsedArgs: Record<string, unknown> = {};
      if (typeof decision.approval.toolArgs === "string") {
        try {
          parsedArgs = JSON.parse(decision.approval.toolArgs);
        } catch {
          // Empty or malformed args - use empty object
          parsedArgs = {};
        }
      } else {
        parsedArgs = decision.approval.toolArgs || {};
      }

      const toolResult = await executeTool(
        decision.approval.toolName,
        parsedArgs,
        {
          signal: options?.abortSignal,
          toolCallId: decision.approval.toolCallId,
          onOutput: options?.onStreamingOutput
            ? (chunk, stream) =>
                options.onStreamingOutput?.(
                  decision.approval.toolCallId,
                  chunk,
                  stream === "stderr",
                )
            : undefined,
        },
      );

      // Update UI if callback provided (interactive mode)
      // Note: UI display uses text-only version, backend gets full multimodal content
      if (onChunk) {
        onChunk({
          message_type: "tool_return_message",
          id: "dummy",
          date: new Date().toISOString(),
          tool_call_id: decision.approval.toolCallId,
          tool_return: getDisplayableToolReturn(toolResult.toolReturn),
          status: toolResult.status,
          stdout: toolResult.stdout,
          stderr: toolResult.stderr,
        });
      }

      return {
        type: "tool",
        tool_call_id: decision.approval.toolCallId,
        tool_return: toolResult.toolReturn, // Full multimodal content for backend
        status: toolResult.status,
        stdout: toolResult.stdout,
        stderr: toolResult.stderr,
      };
    } catch (e) {
      const isAbortError =
        e instanceof Error &&
        (e.name === "AbortError" || e.message === "The operation was aborted");
      const errorMessage = isAbortError
        ? INTERRUPTED_BY_USER
        : `Error executing tool: ${String(e)}`;

      if (onChunk) {
        onChunk({
          message_type: "tool_return_message",
          id: "dummy",
          date: new Date().toISOString(),
          tool_call_id: decision.approval.toolCallId,
          tool_return: errorMessage,
          status: "error",
        });
      }

      return {
        type: "tool",
        tool_call_id: decision.approval.toolCallId,
        tool_return: errorMessage,
        status: "error",
      };
    }
  }

  // Format denial for backend
  if (onChunk) {
    onChunk({
      message_type: "tool_return_message",
      id: "dummy",
      date: new Date().toISOString(),
      tool_call_id: decision.approval.toolCallId,
      tool_return: `Error: request to call tool denied. User reason: ${decision.reason}`,
      status: "error",
    });
  }

  return {
    type: "approval",
    tool_call_id: decision.approval.toolCallId,
    approve: false,
    reason: decision.reason,
  };
}

/**
 * Execute a batch of approval decisions and format results for the backend.
 *
 * This function handles:
 * - Executing approved tools (with error handling)
 * - Formatting denials
 * - Combining all results into a single batch
 *
 * Execution strategy for performance:
 * - Parallel-safe tools (read-only + Task) are executed in parallel
 * - Write tools are grouped by resource (file path) and executed with per-resource queuing:
 *   - Different resources → parallel execution
 *   - Same resource → sequential execution to avoid race conditions
 *
 * Used by both interactive (App.tsx) and headless (headless.ts) modes.
 *
 * @param decisions - Array of approve/deny decisions for each tool
 * @param onChunk - Optional callback to update UI with tool results (for interactive mode)
 * @returns Array of formatted results ready to send to backend (maintains original order)
 */
export async function executeApprovalBatch(
  decisions: ApprovalDecision[],
  onChunk?: (chunk: ToolReturnMessage) => void,
  options?: {
    abortSignal?: AbortSignal;
    onStreamingOutput?: (
      toolCallId: string,
      chunk: string,
      isStderr?: boolean,
    ) => void;
  },
): Promise<ApprovalResult[]> {
  // Pre-allocate results array to maintain original order
  const results: (ApprovalResult | null)[] = new Array(decisions.length).fill(
    null,
  );

  // Categorize decisions by execution strategy
  const parallelIndices: number[] = [];
  const writeToolsByResource = new Map<string, number[]>();
  const denyIndices: number[] = [];

  for (let i = 0; i < decisions.length; i++) {
    const decision = decisions[i];
    if (!decision) continue;

    if (decision.type === "deny") {
      denyIndices.push(i);
      continue;
    }

    const toolName = decision.approval.toolName;

    if (isParallelSafe(toolName)) {
      parallelIndices.push(i);
    } else {
      // Get resource key for write tools
      // Safe parse - handle empty or malformed toolArgs
      let args: Record<string, unknown> = {};
      if (typeof decision.approval.toolArgs === "string") {
        try {
          args = JSON.parse(decision.approval.toolArgs);
        } catch {
          // Empty or malformed args - use empty object (will use global lock)
          args = {};
        }
      } else {
        args = decision.approval.toolArgs || {};
      }
      const resourceKey = getResourceKey(toolName, args);

      const indices = writeToolsByResource.get(resourceKey) || [];
      indices.push(i);
      writeToolsByResource.set(resourceKey, indices);
    }
  }

  // Helper to execute a decision and store result
  const execute = async (i: number) => {
    const decision = decisions[i];
    if (decision) {
      results[i] = await executeSingleDecision(decision, onChunk, options);
    }
  };

  // Execute all categories concurrently:
  // 1. Parallel-safe tools (all in parallel)
  // 2. Write tools grouped by resource (sequential within each group, parallel across groups)
  // 3. Denials (no actual execution needed, but process for UI updates)
  await Promise.all([
    // Parallel-safe tools + denials: all run in parallel
    ...parallelIndices.map(execute),
    ...denyIndices.map(execute),
    // Write tools: sequential within each resource group, parallel across groups
    ...Array.from(writeToolsByResource.values()).map(async (indices) => {
      for (const i of indices) {
        await execute(i);
      }
    }),
  ]);

  // Filter out nulls (shouldn't happen, but TypeScript needs this)
  return results.filter((r): r is ApprovalResult => r !== null);
}

/**
 * Helper to execute auto-allowed tools and map results to the format expected by App.tsx.
 * Consolidates the common pattern of converting approvals to decisions, executing them,
 * and mapping the results back.
 *
 * @param autoAllowed - Array of auto-allowed approval contexts (must have .approval property)
 * @param onChunk - Callback to update UI with tool results
 * @param options - Optional abort signal for cancellation
 * @returns Array of results with toolCallId and ToolExecutionResult
 */
export async function executeAutoAllowedTools(
  autoAllowed: Array<{ approval: ApprovalRequest }>,
  onChunk: (chunk: ToolReturnMessage) => void,
  options?: {
    abortSignal?: AbortSignal;
    onStreamingOutput?: (
      toolCallId: string,
      chunk: string,
      isStderr?: boolean,
    ) => void;
  },
): Promise<AutoAllowedResult[]> {
  const decisions: ApprovalDecision[] = autoAllowed.map((ac) => ({
    type: "approve" as const,
    approval: ac.approval,
  }));

  const batchResults = await executeApprovalBatch(decisions, onChunk, options);

  return batchResults
    .filter((r): r is ApprovalResult & { type: "tool" } => r.type === "tool")
    .map((r) => ({
      toolCallId: r.tool_call_id,
      result: {
        toolReturn: r.tool_return,
        status: r.status,
        stdout: r.stdout,
        stderr: r.stderr,
      } as ToolExecutionResult,
    }));
}
