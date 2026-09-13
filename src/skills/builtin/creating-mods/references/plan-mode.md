# Plan mode mod example

Use this as the canonical multi-capability mod example. It composes a slash command, model-callable tools, turn reminders, permission overlays, and local state to recreate the old built-in plan-mode flow with mod APIs.

This is a pattern reference, not a full product implementation. Keep local mods self-contained and avoid importing Letta Code internals.

## Contents

- Flow
- Capabilities used
- State
- Entry command and tool
- Turn reminder
- Permission overlay
- Exit tool
- Notes

## Flow

```text
/plan or enter_plan_mode
-> create ~/.letta/plans/<random>.md
-> remember active plan state for this conversation
-> remind the agent that only read-only tools and plan-file writes are allowed
-> permission overlay denies mutations outside ~/.letta/plans/*.md
-> agent writes the plan with normal Write/Edit/ApplyPatch tools
-> agent reads the plan and calls AskUserQuestion with the full current plan text and Approve / Revise
-> if approved, agent calls exit_plan_mode
-> exit_plan_mode clears state and returns the approved-plan execution handoff
```

Plan files are normal markdown files. Do not add a special `update_plan_file` tool unless the user explicitly wants that abstraction. Let the agent use normal write tools and constrain those tools with permissions.

Plan approval must show the user the full current plan text. Do not ask "does this look right?" with only a summary. After every revision, read the plan file again and present the full revised plan in the `AskUserQuestion.question` body before exiting plan mode.

## Capabilities used

Guard each registration with the matching capability:

- `commands`: `/plan` for explicit human entry
- `tools`: `enter_plan_mode` and `exit_plan_mode` for model-driven entry/exit
- `events.turns`: append a focused plan-mode reminder while active
- `permissions`: block mutating tools except planning coordination tools and plan-file writes

Do not use panels for persistent mode state. Panels are transient UI and can be noisy/fragile for mode indicators. Do not claim the order-0 statusline panel just to show plan mode; that slot is a single primary line, not an additive indicator. This example intentionally keeps visible mode state out of scope.

## State

Use small local state under `~/.letta/mods/`, keyed by conversation ID:

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";

const PLANS_DIR = join(homedir(), ".letta", "plans");
const STATE_PATH = join(homedir(), ".letta", "mods", "plan-mode.state.json");
const GLOBAL_CONVERSATION_ID = "__global__";

type PlanSession = {
  conversationId: string;
  planFilePath: string;
  startedAt: number;
  cwd: string;
};

type PlanState = { sessions: Record<string, PlanSession> };

function conversationKey(id: string | null | undefined): string {
  return id || GLOBAL_CONVERSATION_ID;
}

function readState(): PlanState {
  try {
    if (!existsSync(STATE_PATH)) return { sessions: {} };
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    return parsed?.sessions ? { sessions: parsed.sessions } : { sessions: {} };
  } catch {
    return { sessions: {} };
  }
}

function writeState(state: PlanState): void {
  mkdirSync(join(homedir(), ".letta", "mods"), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}
```

Generate plan paths under `~/.letta/plans/`. The old built-in used random adjective/adjective/noun names like `zesty-dazzling-coral.md`; any collision-resistant readable name is fine.

## Entry command and tool

`/plan` and `enter_plan_mode` should call the same activation helper. The command returns a prompt/system reminder so the agent receives the path. The tool returns the same text as a tool result.

```ts
function buildEnterPlanModeMessage(session, cwd) {
  const relativePatchPath = relative(cwd, session.planFilePath).replace(/\\/g, "/");
  return `Entered plan mode. You should now focus on exploring the codebase and designing an implementation approach.

In plan mode, you should:
1. Thoroughly explore the codebase to understand existing patterns
2. Identify similar features and architectural approaches
3. Consider multiple approaches and their trade-offs
4. Use direct read-only tools for exploration. Do not launch coding, general-purpose, or fork subagents in plan mode; they may mutate files and should be denied. Only recall-style subagents are allowed if available.
5. Use AskUserQuestion if you need to clarify the approach
6. Design a concrete implementation strategy
7. When ready, write the plan to the plan file, read the plan file, use AskUserQuestion to present the full current plan text for approval, and call exit_plan_mode after the user approves

Remember: DO NOT write or edit any files except the plan file. This is a read-only exploration and planning phase.

Plan file path: ${session.planFilePath}
If using apply_patch, use this exact relative patch path: ${relativePatchPath}`;
}

export default function activate(letta) {
  const disposers = [];

  if (letta.capabilities.commands) {
    disposers.push(letta.commands.register({
      id: "plan",
      description: "Enter plan mode",
      override: true,
      run(ctx) {
        const session = activatePlanMode(ctx.conversation.id, ctx.cwd);
        return {
          type: "prompt",
          systemReminder: true,
          content: buildEnterPlanModeMessage(session, ctx.cwd),
        };
      },
    }));
  }

  if (letta.capabilities.tools) {
    disposers.push(letta.tools.register({
      name: "enter_plan_mode",
      description:
        "Enter plan mode before a non-trivial implementation task. Use this for new features, multi-file changes, architectural decisions, unclear requirements, or tasks where the user should approve the approach before implementation.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      requiresApproval: true,
      parallelSafe: false,
      run(ctx) {
        const session = activatePlanMode(ctx.conversation.id, ctx.cwd);
        return buildEnterPlanModeMessage(session, ctx.cwd);
      },
    }));
  }

  return () => disposers.reverse().forEach((dispose) => dispose());
}
```

## Turn reminder

Append a reminder while plan mode is active. Keep it narrow and explicit about the allowed plan-file exception:

```ts
function buildActiveReminder(session, cwd) {
  const relativePatchPath = relative(cwd, session.planFilePath).replace(/\\/g, "/");
  return `<system-reminder>
Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits (with the exception of the plan file mentioned below), run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supersedes any other instructions you have received. Instead, you should:
1. Answer the user's query comprehensively, using the AskUserQuestion tool if you need to ask the user clarifying questions.
2. Write your implementation plan to the plan file. Plan file path: ${session.planFilePath}
3. If using apply_patch, use this exact relative path in patch headers: ${relativePatchPath}
4. Use direct read-only tools for exploration. Do not launch coding, general-purpose, or fork subagents in plan mode; they may mutate files and should be denied. Only recall-style subagents are allowed if available.
5. When the plan is complete, read the plan file and present the full current plan text to the user with AskUserQuestion. The question body must include the entire plan, not a summary. The question should offer at least "Approve" and "Revise" options.
6. If the user approves, call exit_plan_mode immediately. If the user asks to revise, stay in plan mode, update the plan file, then read and present the full revised plan again.
Do NOT make any file changes outside the plan file or run any tools that modify the system state until the user has approved the plan and you have called exit_plan_mode.
</system-reminder>`;
}

if (letta.capabilities.events.turns) {
  disposers.push(letta.events.on("turn_start", (event) => {
    const session = getSession(event.conversationId);
    if (!session) return;
    return { input: [{ role: "user", content: buildActiveReminder(session, session.cwd) }, ...event.input] };
  }));
}
```

## Permission overlay

Use a permission overlay, not `tool_start`, for policy. Normalize tool names by family; UI display names and provider-specific tool names drift (`Read`, `read`, `read_file`, `ReadFile`, `SearchFileContent`, etc.). Keep pure read-only tools separate from planning coordination tools like `AskUserQuestion` and todo/plan updates so the policy stays honest.

```ts
const readOnlyToolNames = new Set([
  "glob",
  "globgemini",
  "grep",
  "grepfiles",
  "list",
  "listdir",
  "listdirectory",
  "ls",
  "notebookread",
  "read",
  "readfile",
  "readfilegemini",
  "readlsp",
  "readmanyfiles",
  "search",
  "searchfilecontent",
  "searchfiles",
  "skill",
  "taskoutput",
  "viewimage",
]);

const planningToolNames = new Set([
  "askuserquestion",
  "enterplanmode",
  "exitplanmode",
  "todowrite",
  "updateplan",
  "writetodos",
]);

const readOnlySubagentTypes = new Set(["recall"]);

function normalizedToolName(toolName) {
  return toolName.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function isReadOnlyToolName(toolName) {
  return readOnlyToolNames.has(normalizedToolName(toolName));
}

function isPlanningToolName(toolName) {
  return planningToolNames.has(normalizedToolName(toolName));
}

function isAllowedReadOnlySubagent(args) {
  const subagentType = args?.subagent_type;
  return typeof subagentType === "string" && readOnlySubagentTypes.has(normalizedToolName(subagentType));
}

function isPlanFileWrite(toolName, args, cwd) {
  // For Write/Edit-style tools, check file_path/path/notebook_path.
  // For ApplyPatch-style tools, parse *** Add/Update/Delete File and *** Move to directives.
  // Allow only if every target resolves to a .md file under ~/.letta/plans/.
}

if (letta.capabilities.permissions) {
  disposers.push(letta.permissions.register({
    id: "plan-mode",
    description: "Allow read-only tools and writes only to ~/.letta/plans/*.md while plan mode is active.",
    check(event) {
      const session = getSession(event.conversationId);
      if (!session) return;
      const toolName = String(event.toolName);
      const args = event.args ?? {};

      if (isReadOnlyToolName(toolName)) return { decision: "allow" };
      if (isPlanningToolName(toolName)) return { decision: "allow", reason: "planning" };

      const normalized = normalizedToolName(toolName);
      if ((normalized === "agent" || normalized === "task") && isAllowedReadOnlySubagent(args)) {
        return { decision: "allow", reason: "read-only subagent" };
      }

      if (isPlanFileWrite(toolName, args, event.workingDirectory || event.cwd)) {
        return { decision: "allow", reason: "plan file" };
      }

      return {
        decision: "deny",
        reason:
          `Plan mode is active. Use direct read-only tools (Read, Grep, Glob, List, Search, Skill, TaskOutput, safe read-only Bash), planning tools (AskUserQuestion, TodoWrite/UpdatePlan), or recall-style subagents only. ` +
          `Do not use coding, general-purpose, or fork subagents in plan mode. ` +
          `Write your plan to: ${session.planFilePath}. ` +
          `When ready, read the plan file and include the full current plan text in AskUserQuestion for approval, then call exit_plan_mode after approval.`,
      };
    },
  }));
}
```

Shell allowlists are easy to get wrong. Start conservative: allow clearly read-only shell commands if needed, plus a narrow plan-file heredoc or `mv old.md new.md` only when every target is inside `~/.letta/plans/*.md`. Deny mutating shell patterns such as `sed -i`, `find -delete`, `rm`, `cp`, `touch`, package installs, and arbitrary interpreters.

## Exit tool

In the mod version, `exit_plan_mode` is not the approval UI. The agent should read the plan file, present the full current plan text with `AskUserQuestion`, then call `exit_plan_mode` only after the user approves.

Use `approvalPolicy: "alwaysAsk"` so the final state transition still pauses for human confirmation in unrestricted/yolo mode.

```ts
if (letta.capabilities.tools) {
  disposers.push(letta.tools.register({
    name: "exit_plan_mode",
    description:
      "Exit plan mode only after the plan file has been written, the full current plan text has been presented with AskUserQuestion, and the user has approved it.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    approvalPolicy: "alwaysAsk",
    parallelSafe: false,
    run(ctx) {
      const session = getSession(ctx.conversation.id);
      if (!session) {
        return { status: "error", content: "Plan mode is not active for this conversation." };
      }
      if (!planFileExists(session)) {
        return {
          status: "error",
          content:
            `You must write your plan to a plan file before exiting plan mode.\n` +
            `Plan file path: ${session.planFilePath}\n` +
            `Use a write tool to create your plan in ${PLANS_DIR}, then use AskUserQuestion to present the plan to the user.`,
        };
      }

      clearSession(ctx.conversation.id);
      return (
        "User has approved your plan. You can now start coding.\n" +
        "Start with updating your todo list if applicable.\n\n" +
        "Tip: If this plan will be referenced in the future by your future-self, other agents, or humans, consider renaming the plan file to something easily identifiable with a timestamp (e.g., `2026-01-auth-refactor.md`) rather than the random name."
      );
    },
  }));
}
```

## Notes

- Keep `exit_plan_mode` as the final state transition and execution handoff. The approved-plan text in its tool return is useful model context.
- Plan approval must include the full current plan text in `AskUserQuestion.question`, not just a summary or "does this look right?". After revisions, re-read the file and present the full revised plan again.
- Keep arbitrary coding subagents denied in plan mode unless the runtime has a true read-only child mode. With the current subagent set, allow only recall-style subagents.
- If the user renames the plan file, exit logic can use the newest non-empty `~/.letta/plans/*.md` modified after plan mode started, or accept an optional plan path. Keep the user-facing flow normal: write plan file, ask approval, then exit.
