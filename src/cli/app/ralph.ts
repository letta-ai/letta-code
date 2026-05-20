import { buildGoalContinuationPrompt } from "@/cli/helpers/goal-command";
import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "@/constants";
import type { RalphState } from "@/ralph/mode";
import { settingsManager } from "@/settings-manager";

// Parse /ralph or /yolo-ralph command arguments
export function parseRalphArgs(input: string): {
  prompt: string | null;
  completionPromise: string | null | undefined; // undefined = use default, null = no promise
  maxIterations: number;
} {
  let rest = input.replace(/^\/(yolo-)?ralph\s*/, "");

  // Extract --completion-promise "value" or --completion-promise 'value'
  // Also handles --completion-promise "" or none for opt-out
  let completionPromise: string | null | undefined;
  const promiseMatch = rest.match(/--completion-promise\s+["']([^"']*)["']/);
  if (promiseMatch) {
    const val = promiseMatch[1] ?? "";
    completionPromise = val === "" || val.toLowerCase() === "none" ? null : val;
    rest = rest.replace(/--completion-promise\s+["'][^"']*["']\s*/, "");
  }

  // Extract --max-iterations N
  const maxMatch = rest.match(/--max-iterations\s+(\d+)/);
  const maxIterations = maxMatch?.[1] ? parseInt(maxMatch[1], 10) : 0;
  rest = rest.replace(/--max-iterations\s+\d+\s*/, "");

  // Remaining text is the inline prompt (may be quoted)
  const prompt = rest.trim().replace(/^["']|["']$/g, "") || null;
  return { prompt, completionPromise, maxIterations };
}

// Build Ralph first-turn reminder (when activating)
// Uses exact wording from claude-code/plugins/ralph-wiggum/scripts/setup-ralph-loop.sh
export function buildRalphFirstTurnReminder(state: RalphState): string {
  const iterInfo =
    state.maxIterations > 0
      ? `${state.currentIteration}/${state.maxIterations}`
      : `${state.currentIteration}`;

  let reminder = `${SYSTEM_REMINDER_OPEN}
🔄 Ralph Wiggum mode activated (iteration ${iterInfo})
`;

  if (state.completionPromise) {
    reminder += `
═══════════════════════════════════════════════════════════
RALPH LOOP COMPLETION PROMISE
═══════════════════════════════════════════════════════════

To complete this loop, output this EXACT text:
  <promise>${state.completionPromise}</promise>

STRICT REQUIREMENTS (DO NOT VIOLATE):
  ✓ Use <promise> XML tags EXACTLY as shown above
  ✓ The statement MUST be completely and unequivocally TRUE
  ✓ Do NOT output false statements to exit the loop
  ✓ Do NOT lie even if you think you should exit

IMPORTANT - Do not circumvent the loop:
  Even if you believe you're stuck, the task is impossible,
  or you've been running too long - you MUST NOT output a
  false promise statement. The loop is designed to continue
  until the promise is GENUINELY TRUE. Trust the process.

  If the loop should stop, the promise statement will become
  true naturally. Do not force it by lying.
═══════════════════════════════════════════════════════════
`;
  } else {
    reminder += `
No completion promise set - loop runs until --max-iterations or ESC/Shift+Tab to exit.
`;
  }

  reminder += SYSTEM_REMINDER_CLOSE;
  return reminder;
}

// Build Ralph continuation reminder (on subsequent iterations)
// Exact format from claude-code/plugins/ralph-wiggum/hooks/stop-hook.sh line 160
export function buildRalphContinuationReminder(state: RalphState): string {
  const iterInfo =
    state.maxIterations > 0
      ? `${state.currentIteration}/${state.maxIterations}`
      : `${state.currentIteration}`;

  if (state.completionPromise) {
    return `${SYSTEM_REMINDER_OPEN}
🔄 Ralph iteration ${iterInfo} | To stop: output <promise>${state.completionPromise}</promise> (ONLY when statement is TRUE - do not lie to exit!)
${SYSTEM_REMINDER_CLOSE}`;
  } else {
    return `${SYSTEM_REMINDER_OPEN}
🔄 Ralph iteration ${iterInfo} | No completion promise set - loop runs infinitely
${SYSTEM_REMINDER_CLOSE}`;
  }
}

export function buildGoalPrompt(
  state: RalphState,
  conversationId?: string | null,
): string {
  const storedGoal = conversationId
    ? settingsManager.getConversationGoal(conversationId)
    : null;
  const liveActiveSeconds =
    storedGoal?.activeStartedAt && storedGoal.status === "active"
      ? Math.max(
          0,
          Math.floor(
            (Date.now() - Date.parse(storedGoal.activeStartedAt)) / 1000,
          ),
        )
      : 0;
  return buildGoalContinuationPrompt({
    objective: state.originalPrompt,
    status: "active",
    tokensUsed: storedGoal?.tokensUsed ?? 0,
    tokenBudget: storedGoal?.tokenBudget ?? state.tokenBudget,
    timeUsedSeconds: (storedGoal?.activeTimeSeconds ?? 0) + liveActiveSeconds,
  });
}

export function buildLoopPrompt(
  state: RalphState,
  conversationId?: string | null,
): string {
  return state.mode === "goal"
    ? buildGoalPrompt(state, conversationId)
    : buildRalphContinuationReminder(state);
}

export function buildLoopFirstTurnPrompt(
  state: RalphState,
  conversationId?: string | null,
): string {
  return state.mode === "goal"
    ? buildGoalPrompt(state, conversationId)
    : buildRalphFirstTurnReminder(state);
}
