import { describe, expect, test } from "bun:test";
import {
  buildGoalBudgetLimitPrompt,
  buildGoalContinuationPrompt,
  buildGoalReminder,
  formatGoalElapsedSeconds,
  formatGoalStatusIndicator,
  formatGoalSummary,
  goalStatusLabel,
  parseGoalArgs,
  validateGoalObjective,
} from "@/cli/helpers/goal-command";
import type { ConversationGoal } from "@/settings-manager";

function makeGoal(overrides: Partial<ConversationGoal> = {}): ConversationGoal {
  return {
    objective: "test objective",
    status: "active",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    activeStartedAt: "2026-01-01T00:00:00Z",
    activeTimeSeconds: 0,
    tokensUsed: 0,
    ...overrides,
  };
}

// ============================================================================
// validateGoalObjective
// ============================================================================

describe("goalCommand - validateGoalObjective", () => {
  test("returns null for valid objective", () => {
    expect(validateGoalObjective("fix the bug")).toBeNull();
  });

  test("returns error for empty string", () => {
    expect(validateGoalObjective("")).not.toBeNull();
  });

  test("returns error for whitespace-only string", () => {
    expect(validateGoalObjective("   ")).not.toBeNull();
  });

  test("returns error for objective exceeding 4000 chars", () => {
    expect(validateGoalObjective("x".repeat(4001))).not.toBeNull();
  });

  test("accepts objective at exactly 4000 chars", () => {
    expect(validateGoalObjective("x".repeat(4000))).toBeNull();
  });
});

// ============================================================================
// goalStatusLabel
// ============================================================================

describe("goalCommand - goalStatusLabel", () => {
  test("maps all statuses to labels", () => {
    expect(goalStatusLabel("active")).toBe("active");
    expect(goalStatusLabel("paused")).toBe("paused");
    expect(goalStatusLabel("complete")).toBe("complete");
    expect(goalStatusLabel("budget_limited")).toBe("budget limited");
  });
});

// ============================================================================
// parseGoalArgs
// ============================================================================

describe("goalCommand - parseGoalArgs", () => {
  test("parses plain objective", () => {
    const result = parseGoalArgs("fix the bug");
    expect(result.objective).toBe("fix the bug");
    expect(result.tokenBudget).toBeNull();
    expect(result.replace).toBe(false);
    expect(result.error).toBeUndefined();
  });

  test("parses --token-budget flag", () => {
    const result = parseGoalArgs("--token-budget 50000 improve coverage");
    expect(result.objective).toBe("improve coverage");
    expect(result.tokenBudget).toBe(50000);
    expect(result.replace).toBe(false);
  });

  test("parses --replace flag", () => {
    const result = parseGoalArgs("--replace new objective");
    expect(result.objective).toBe("new objective");
    expect(result.replace).toBe(true);
  });

  test("parses both --token-budget and --replace", () => {
    const result = parseGoalArgs("--token-budget 1000 --replace redo this");
    expect(result.objective).toBe("redo this");
    expect(result.tokenBudget).toBe(1000);
    expect(result.replace).toBe(true);
  });

  test("strips surrounding quotes from objective", () => {
    const result = parseGoalArgs('"quoted objective"');
    expect(result.objective).toBe("quoted objective");
  });

  test("returns error for zero token budget", () => {
    const result = parseGoalArgs("--token-budget 0 do something");
    expect(result.error).toBe("Token budget must be a positive integer.");
  });

  test("negative token budget is not matched by regex, treated as objective text", () => {
    const result = parseGoalArgs("--token-budget -5 do something");
    // The regex only matches \d+, so -5 is not captured; the whole string becomes the objective
    expect(result.tokenBudget).toBeNull();
    expect(result.error).toBeUndefined();
  });

  test("returns empty objective when only flags are provided", () => {
    const result = parseGoalArgs("--token-budget 50000");
    expect(result.objective).toBe("");
    expect(result.tokenBudget).toBe(50000);
  });
});

// ============================================================================
// formatGoalSummary
// ============================================================================

describe("goalCommand - formatGoalSummary", () => {
  test("formats goal without budget", () => {
    const goal = makeGoal({ tokensUsed: 1000, activeTimeSeconds: 30 });
    const summary = formatGoalSummary(goal);
    expect(summary).toContain("test objective");
    expect(summary).toContain("1k");
    expect(summary).toContain("30");
  });

  test("formats goal with budget", () => {
    const goal = makeGoal({
      tokensUsed: 1000,
      tokenBudget: 50000,
      activeTimeSeconds: 30,
    });
    const summary = formatGoalSummary(goal);
    expect(summary).toContain("50k");
  });
});

// ============================================================================
// formatGoalElapsedSeconds
// ============================================================================

describe("goalCommand - formatGoalElapsedSeconds", () => {
  test("formats seconds", () => {
    expect(formatGoalElapsedSeconds(45)).toBe("45s");
  });

  test("formats minutes with seconds", () => {
    expect(formatGoalElapsedSeconds(120)).toBe("2m 0s");
  });

  test("formats hours with minutes", () => {
    expect(formatGoalElapsedSeconds(3600)).toBe("1h 0m");
  });

  test("formats hours and minutes", () => {
    expect(formatGoalElapsedSeconds(5400)).toBe("1h 30m");
  });

  test("formats days", () => {
    expect(formatGoalElapsedSeconds(86400)).toBe("1d 0h 0m");
  });

  test("clamps negative to 0", () => {
    expect(formatGoalElapsedSeconds(-10)).toBe("0s");
  });
});

// ============================================================================
// formatGoalStatusIndicator
// ============================================================================

describe("goalCommand - formatGoalStatusIndicator", () => {
  test("active goal without budget shows elapsed time", () => {
    const goal = makeGoal({ status: "active", activeTimeSeconds: 60 });
    const indicator = formatGoalStatusIndicator(goal);
    expect(indicator).toContain("Pursuing goal");
  });

  test("active goal with budget shows token usage", () => {
    const goal = makeGoal({
      status: "active",
      tokensUsed: 1000,
      tokenBudget: 50000,
    });
    expect(formatGoalStatusIndicator(goal)).toContain("1k / 50k");
  });

  test("paused goal shows resume hint", () => {
    const goal = makeGoal({ status: "paused" });
    expect(formatGoalStatusIndicator(goal)).toContain("paused");
    expect(formatGoalStatusIndicator(goal)).toContain("/goal resume");
  });

  test("budget_limited goal with budget shows token usage", () => {
    const goal = makeGoal({
      status: "budget_limited",
      tokensUsed: 50000,
      tokenBudget: 50000,
    });
    expect(formatGoalStatusIndicator(goal)).toContain("unmet");
  });

  test("budget_limited goal without budget shows abandoned", () => {
    const goal = makeGoal({ status: "budget_limited" });
    expect(formatGoalStatusIndicator(goal)).toContain("abandoned");
  });

  test("complete goal with budget shows token count", () => {
    const goal = makeGoal({
      status: "complete",
      tokensUsed: 30000,
      tokenBudget: 50000,
    });
    expect(formatGoalStatusIndicator(goal)).toContain("achieved");
    expect(formatGoalStatusIndicator(goal)).toContain("30k");
  });
});

// ============================================================================
// buildGoalReminder
// ============================================================================

describe("goalCommand - buildGoalReminder", () => {
  test("includes goal objective and status", () => {
    const goal = makeGoal({ status: "active", objective: "ship the feature" });
    const reminder = buildGoalReminder(goal);
    expect(reminder).toContain("ship the feature");
    expect(reminder).toContain("active");
  });
});

// ============================================================================
// buildGoalContinuationPrompt
// ============================================================================

describe("goalCommand - buildGoalContinuationPrompt", () => {
  test("escapes XML in objective", () => {
    const prompt = buildGoalContinuationPrompt({
      objective: "fix <script>alert('xss')</script>",
      status: "active",
      tokensUsed: 100,
      tokenBudget: 1000,
      timeUsedSeconds: 30,
    });
    expect(prompt).toContain("&lt;script&gt;");
    expect(prompt).not.toContain("<script>");
  });

  test("shows budget info", () => {
    const prompt = buildGoalContinuationPrompt({
      objective: "do the thing",
      status: "active",
      tokensUsed: 100,
      tokenBudget: 1000,
      timeUsedSeconds: 30,
    });
    expect(prompt).toContain("Tokens used: 100");
    expect(prompt).toContain("Token budget: 1000");
    expect(prompt).toContain("Tokens remaining: 900");
  });

  test("shows unbounded when no budget", () => {
    const prompt = buildGoalContinuationPrompt({
      objective: "do the thing",
      status: "active",
      tokensUsed: 100,
      tokenBudget: null,
      timeUsedSeconds: 30,
    });
    expect(prompt).toContain("Token budget: none");
    expect(prompt).toContain("Tokens remaining: unbounded");
  });
});

// ============================================================================
// buildGoalBudgetLimitPrompt
// ============================================================================

describe("goalCommand - buildGoalBudgetLimitPrompt", () => {
  test("escapes XML in objective", () => {
    const goal = makeGoal({
      objective: "use <tag>here",
      tokensUsed: 50000,
      tokenBudget: 50000,
    });
    const prompt = buildGoalBudgetLimitPrompt(goal);
    expect(prompt).toContain("&lt;tag&gt;");
    expect(prompt).not.toContain("<tag>");
  });

  test("instructs model to wrap up", () => {
    const goal = makeGoal({ tokensUsed: 50000, tokenBudget: 50000 });
    const prompt = buildGoalBudgetLimitPrompt(goal);
    expect(prompt).toContain("budget_limited");
    expect(prompt).toContain("Wrap up");
  });
});
