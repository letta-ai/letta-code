// Tool execution context - allows tools to access execution metadata
// Separate file to avoid circular dependencies with manager.ts

interface ToolExecutionContext {
  toolCallId?: string;
}

let currentToolContext: ToolExecutionContext | null = null;

/**
 * Get the current tool execution context.
 * Called by tools that need access to execution metadata (e.g., Read for image queuing).
 */
export function getToolExecutionContext(): ToolExecutionContext | null {
  return currentToolContext;
}

/**
 * Set the current tool execution context.
 * Called by manager.ts before executing a tool.
 */
export function setToolExecutionContext(
  context: ToolExecutionContext | null,
): void {
  currentToolContext = context;
}
