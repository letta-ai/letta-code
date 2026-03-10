import { relative } from "node:path";
import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "../constants";
import { permissionMode } from "../permissions/mode";

/**
 * Build the plan mode system reminder if plan mode is active.
 * Returns empty string if not in plan mode.
 *
 * Shared between App.tsx (interactive CLI) and listen-client.ts (listener mode).
 */
export function getPlanModeReminder(): string {
  if (permissionMode.getMode() !== "plan") {
    return "";
  }

  const planFilePath = permissionMode.getPlanFilePath();
  const applyPatchRelativePath = planFilePath
    ? relative(process.cwd(), planFilePath).replace(/\\/g, "/")
    : null;

  return `${SYSTEM_REMINDER_OPEN}
      Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits (with the exception of the plan file mentioned below), run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supersedes any other instructions you have received.

## Plan File Info:
${planFilePath ? `No plan file exists yet. You should create your plan at ${planFilePath} using a write tool (e.g. Write, ApplyPatch, etc. depending on your toolset).\n${applyPatchRelativePath ? `If using apply_patch, use this exact relative patch path: ${applyPatchRelativePath}.` : ""}` : "No plan file path assigned."}

You should build your plan incrementally by writing to or editing this file. NOTE that this is the only file you are allowed to edit - other than this you are only allowed to take READ-ONLY actions.

**Plan File Guidelines:** The plan file should contain only your final recommended approach, not all alternatives considered. Keep it comprehensive yet concise - detailed enough to execute effectively while avoiding unnecessary verbosity.

## Enhanced Planning Workflow

### Phase 1: Initial Understanding
Goal: Gain a comprehensive understanding of the user's request by reading through code and asking them questions.

1. Understand the user's request thoroughly
2. Explore the codebase to understand existing patterns and relevant code
3. Use AskUserQuestion tool to clarify ambiguities in the user request up front.

### Phase 2: Planning
Goal: Come up with an approach to solve the problem identified in phase 1.

- Provide any background context that may help with the task without prescribing the exact design itself
- Create a detailed plan

### Phase 3: Synthesis
Goal: Synthesize the perspectives from Phase 2, and ensure that it aligns with the user's intentions by asking them questions.

1. Collect all findings from exploration
2. Keep track of critical files that should be read before implementing the plan
3. Use AskUserQuestion to ask the user questions about trade offs.

### Phase 4: Final Plan
Once you have all the information you need, ensure that the plan file has been updated with your synthesized recommendation including:

- Recommended approach with rationale
- Key insights from different perspectives
- Critical files that need modification

### Phase 5: Call ExitPlanMode
At the very end of your turn, once you have asked the user questions and are happy with your final plan file - you should always call ExitPlanMode to indicate to the user that you are done planning.

This is critical - your turn should only end with either asking the user a question or calling ExitPlanMode. Do not stop unless it's for these 2 reasons.

NOTE: At any point in time through this workflow you should feel free to ask the user questions or clarifications. Don't make large assumptions about user intent. The goal is to present a well researched plan to the user, and tie any loose ends before implementation begins.
${SYSTEM_REMINDER_CLOSE}
`;
}
