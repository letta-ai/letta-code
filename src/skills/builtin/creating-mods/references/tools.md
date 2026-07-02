# Mod tool recipes

Use tools when the agent/model should call a local capability autonomously.

For tools that are part of a larger mod with commands, UI, local state, or events, also read `architecture.md`.

## Contents

- Defaults
- Read-only shell tool
- Tool with arguments
- Mutating or risky tool

## Defaults

- Name: lowercase/underscore tool name, e.g. `branch_summary`.
- Description: explain when the model should use it.
- Parameters: JSON Schema object. Use `additionalProperties: false` when possible.
- `requiresApproval: false` only for read-only, low-risk local introspection.
- `approvalPolicy: "alwaysAsk"` only for tools that must pause for human approval even in unrestricted/yolo mode.
- `parallelSafe: true` only for read-only tools with no shared mutation or long-lived exclusive resource.
- Use `ctx.cwd` as the invocation workspace.
- Use the dynamic context passed to `run(ctx)` (`ctx.agent`, `ctx.model`, `ctx.toolset`, `ctx.permissionMode`) instead of reading global app context.
- Use `await ctx.conversation.getHistory()` when a tool needs recent conversation context. It returns the most recent messages in chronological order by default.
- Respect `ctx.signal` for long-running work when practical.
- Tools should return information for the model to use; they should not start hidden model runs.

## Read-only shell tool

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export default function activate(letta) {
  if (!letta.capabilities.tools) return;

  return letta.tools.register({
    name: "branch_summary",
    description: "Summarize the current git branch, working tree status, and recent commits.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    requiresApproval: false,
    parallelSafe: true,
    async run(ctx) {
      const [{ stdout: status }, { stdout: log }] = await Promise.all([
        execFileAsync("git", ["status", "--short", "--branch"], { cwd: ctx.cwd }),
        execFileAsync("git", ["log", "--oneline", "-5"], { cwd: ctx.cwd }),
      ]);

      return ["## Branch", status.trim(), "", "## Recent commits", log.trim()].join("\n");
    },
  });
}
```

## Tool with arguments

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export default function activate(letta) {
  if (!letta.capabilities.tools) return;

  return letta.tools.register({
    name: "repo_notes_search",
    description: "Search local repo notes for a query and return matching snippets.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    requiresApproval: false,
    parallelSafe: true,
    async run(ctx) {
      const query = String(ctx.args.query ?? "").trim();
      if (!query) return { status: "error", content: "query is required" };

      try {
        const { stdout } = await execFileAsync(
          "rg",
          ["--line-number", "--max-count", "20", query, "notes"],
          { cwd: ctx.cwd },
        );
        return stdout.trim() || "No matches.";
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === 1) {
          return "No matches.";
        }
        throw error;
      }
    },
  });
}
```

## Mutating or risky tool

Set approval required and avoid `parallelSafe` unless it is truly safe:

```ts
letta.tools.register({
  name: "format_file",
  description: "Format a specific file in the current workspace.",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
  requiresApproval: true,
  parallelSafe: false,
  async run(ctx) {
    // mutate only the requested file, with clear output
    return "formatted";
  },
});
```

## Always-ask tool

Use `approvalPolicy: "alwaysAsk"` when a tool represents a human gate rather than a risky operation. Deny rules and permission overlays still win, but unrestricted/yolo mode will not auto-approve it.

```ts
letta.tools.register({
  name: "exit_plan_mode",
  description: "Exit plan mode after the user has reviewed and approved the plan.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  approvalPolicy: "alwaysAsk",
  parallelSafe: false,
  run(ctx) {
    return "Plan approved. You can now start coding.";
  },
});
```
