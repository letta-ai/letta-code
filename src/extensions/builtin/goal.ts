import type { LettaExtensionApi } from "@/extensions/extension-engine";
import type {
  ExtensionContext,
  ExtensionToolRegistration,
  ExtensionToolRunContext,
  ExtensionToolRunResult,
} from "@/extensions/types";
import { settingsManager } from "@/settings-manager";

const GET_GOAL_DESCRIPTION =
  "Get the current goal for this conversation, including status, budgets, token and elapsed-time usage, and remaining token budget.";

const CREATE_GOAL_DESCRIPTION = `Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks.

Set token_budget only when an explicit token budget is requested. Fails if a goal exists; use the goal update tool only for status.`;

const UPDATE_GOAL_DESCRIPTION = `Update the existing goal.

Use this tool only to mark the goal achieved or blocked.
Set status to \`complete\` only when the objective has actually been achieved and no required work remains.
Set status to \`blocked\` only after the same blocking condition has recurred for at least three consecutive goal turns and you are at an impasse. After a blocked goal is resumed, the resumed run starts a fresh blocked audit.
Do not mark a goal complete merely because its budget is nearly exhausted or because you are stopping work.
You cannot use this tool to pause, resume, budget-limit, or usage-limit a goal; those status changes are controlled by the user or system.
When marking a budgeted goal achieved with status \`complete\`, report the final token usage from the tool result to the user.`;

const GET_GOAL_PARAMETERS = {
  type: "object",
  properties: {},
  additionalProperties: false,
} satisfies Record<string, unknown>;

const CREATE_GOAL_PARAMETERS = {
  type: "object",
  properties: {
    objective: {
      type: "string",
      description:
        "Required. The concrete objective to start pursuing. This starts a new active goal only when no goal is currently defined; if a goal already exists, this tool fails.",
    },
    token_budget: {
      type: "integer",
      description: "Optional positive token budget for the new active goal.",
    },
  },
  required: ["objective"],
  additionalProperties: false,
} satisfies Record<string, unknown>;

const UPDATE_GOAL_PARAMETERS = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["complete", "blocked"],
      description:
        "Required. Set to complete only when the objective is achieved and no required work remains. Set to blocked only after the same blocking condition has recurred for at least three consecutive goal turns and the agent is at an impasse.",
    },
  },
  required: ["status"],
  additionalProperties: false,
} satisfies Record<string, unknown>;

export const GOAL_EXTENSION_SNAKE_TOOL_NAMES = [
  "get_goal",
  "create_goal",
  "update_goal",
] as const;

export const GOAL_EXTENSION_PASCAL_TOOL_NAMES = [
  "GetGoal",
  "CreateGoal",
  "UpdateGoal",
] as const;

export const GOAL_EXTENSION_TOOL_NAMES = [
  ...GOAL_EXTENSION_SNAKE_TOOL_NAMES,
  ...GOAL_EXTENSION_PASCAL_TOOL_NAMES,
] as const;

const GOAL_EXTENSION_TOOL_NAME_SET = new Set<string>(GOAL_EXTENSION_TOOL_NAMES);

export type GoalExtensionToolName = (typeof GOAL_EXTENSION_TOOL_NAMES)[number];

export type GoalExtensionToolsetName =
  | "codex"
  | "codex_snake"
  | "default"
  | "gemini"
  | "gemini_snake"
  | "none";

export function isGoalExtensionToolName(
  toolName: string,
): toolName is GoalExtensionToolName {
  return GOAL_EXTENSION_TOOL_NAME_SET.has(toolName);
}

export function getGoalExtensionToolNamesForToolset(
  toolsetName: GoalExtensionToolsetName,
): GoalExtensionToolName[] {
  switch (toolsetName) {
    case "codex_snake":
    case "gemini_snake":
      return [...GOAL_EXTENSION_SNAKE_TOOL_NAMES];
    case "codex":
    case "gemini":
    case "default":
      return [...GOAL_EXTENSION_PASCAL_TOOL_NAMES];
    case "none":
      return [];
  }
}

export function shouldExposeGoalExtensionToolForToolset(
  toolName: string,
  toolsetName: GoalExtensionToolsetName,
): boolean {
  if (!isGoalExtensionToolName(toolName)) return true;
  return getGoalExtensionToolNamesForToolset(toolsetName).includes(toolName);
}

function getConversationIdFromExtensionContext(
  context: ExtensionContext,
): string | null {
  return context.sessionId;
}

function getConversationIdFromToolRunContext(
  context: ExtensionToolRunContext,
): string | null {
  return context.conversation.id ?? context.getContext().sessionId;
}

function areGoalToolsEnabled(context: ExtensionContext): boolean {
  const conversationId = getConversationIdFromExtensionContext(context);
  if (!conversationId) return false;
  try {
    return settingsManager.areConversationGoalToolsEnabled(
      conversationId,
      context.cwd,
    );
  } catch {
    return false;
  }
}

function jsonResult(result: Record<string, unknown>): ExtensionToolRunResult {
  return {
    output: JSON.stringify(result),
    status: "success",
  };
}

async function getGoal(
  context: ExtensionToolRunContext,
): Promise<ExtensionToolRunResult> {
  const conversationId = getConversationIdFromToolRunContext(context);
  if (!conversationId) {
    return jsonResult({ goal: null, remaining_tokens: null });
  }
  const goal = settingsManager.getConversationGoal(
    conversationId,
    context.workingDirectory,
  );
  return jsonResult({
    goal,
    remaining_tokens:
      goal?.tokenBudget != null
        ? Math.max(0, goal.tokenBudget - goal.tokensUsed)
        : null,
  });
}

async function createGoal(
  context: ExtensionToolRunContext,
): Promise<ExtensionToolRunResult> {
  const args = context.args;
  const objective =
    typeof args.objective === "string" ? args.objective.trim() : "";
  if (!objective) {
    throw new Error("objective is required");
  }
  const tokenBudget =
    typeof args.token_budget === "number" && Number.isFinite(args.token_budget)
      ? Math.floor(args.token_budget)
      : null;
  if (tokenBudget !== null && tokenBudget <= 0) {
    throw new Error("token_budget must be a positive integer");
  }
  const conversationId = getConversationIdFromToolRunContext(context);
  if (!conversationId) {
    throw new Error("No active conversation.");
  }
  const existing = settingsManager.getConversationGoal(
    conversationId,
    context.workingDirectory,
  );
  if (existing) {
    throw new Error(
      "cannot create a new goal because this conversation already has a goal; use the goal update tool only when the existing goal is complete",
    );
  }
  const goal = settingsManager.setConversationGoal(
    conversationId,
    objective,
    context.workingDirectory,
    tokenBudget,
    true,
  );
  return jsonResult({
    goal,
    remaining_tokens: tokenBudget,
  });
}

async function updateGoal(
  context: ExtensionToolRunContext,
): Promise<ExtensionToolRunResult> {
  const args = context.args;
  if (args.status !== "complete" && args.status !== "blocked") {
    throw new Error(
      'the goal update tool can only mark the existing goal complete or blocked; use status "complete" or "blocked".',
    );
  }
  const conversationId = getConversationIdFromToolRunContext(context);
  if (!conversationId) {
    throw new Error("No active conversation.");
  }
  const goal = settingsManager.updateConversationGoalStatus(
    conversationId,
    args.status,
    context.workingDirectory,
  );
  if (!goal) {
    throw new Error("No active goal exists for this conversation.");
  }
  return jsonResult({
    goal,
    remaining_tokens:
      goal.tokenBudget != null
        ? Math.max(0, goal.tokenBudget - goal.tokensUsed)
        : null,
    completion_budget_report:
      args.status === "complete" && goal.tokenBudget
        ? `Goal achieved. Report final budget usage to the user: tokens used: ${goal.tokensUsed} of ${goal.tokenBudget}; time used: ${goal.activeTimeSeconds} seconds.`
        : null,
  });
}

const TOOL_REGISTRATIONS: ExtensionToolRegistration[] = [
  {
    name: "get_goal",
    description: GET_GOAL_DESCRIPTION,
    parameters: GET_GOAL_PARAMETERS,
    requiresApproval: false,
    run: getGoal,
    isEnabled: areGoalToolsEnabled,
  },
  {
    name: "create_goal",
    description: CREATE_GOAL_DESCRIPTION,
    parameters: CREATE_GOAL_PARAMETERS,
    requiresApproval: false,
    run: createGoal,
    isEnabled: areGoalToolsEnabled,
  },
  {
    name: "update_goal",
    description: UPDATE_GOAL_DESCRIPTION,
    parameters: UPDATE_GOAL_PARAMETERS,
    requiresApproval: false,
    run: updateGoal,
    isEnabled: areGoalToolsEnabled,
  },
  {
    name: "GetGoal",
    description: GET_GOAL_DESCRIPTION,
    parameters: GET_GOAL_PARAMETERS,
    requiresApproval: false,
    run: getGoal,
    isEnabled: areGoalToolsEnabled,
  },
  {
    name: "CreateGoal",
    description: CREATE_GOAL_DESCRIPTION,
    parameters: CREATE_GOAL_PARAMETERS,
    requiresApproval: false,
    run: createGoal,
    isEnabled: areGoalToolsEnabled,
  },
  {
    name: "UpdateGoal",
    description: UPDATE_GOAL_DESCRIPTION,
    parameters: UPDATE_GOAL_PARAMETERS,
    requiresApproval: false,
    run: updateGoal,
    isEnabled: areGoalToolsEnabled,
  },
];

export function installGoalExtension(letta: LettaExtensionApi): undefined {
  for (const tool of TOOL_REGISTRATIONS) {
    letta.tools.register(tool);
  }
  return undefined;
}
