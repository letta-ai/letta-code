import { describe, expect, test } from "bun:test";
import guidance from "@/skills/builtin/curating-memory-palace/SKILL.md";

const ACTION_KEYS = new Set([
  "actionId",
  "label",
  "conversationId",
  "instruction",
]);

/**
 * Why the Palace would show a `palace-action` block as an error instead of a
 * button, or null. Mirrors the action parser in Letta Code Desktop.
 */
function actionProblem(source: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return "not JSON";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "not an object";
  }
  const extra = Object.keys(parsed).filter((key) => !ACTION_KEYS.has(key));
  if (extra.length > 0) return `unknown keys: ${extra.join(", ")}`;
  const { actionId, label, conversationId, instruction } = parsed as Record<
    string,
    unknown
  >;
  if (typeof actionId !== "string" || !/^\S{1,64}$/.test(actionId)) {
    return "bad actionId";
  }
  if (typeof label !== "string" || !label.trim() || label.length > 80) {
    return "bad label";
  }
  if (
    instruction !== undefined &&
    (typeof instruction !== "string" || instruction.length > 300)
  ) {
    return "bad instruction";
  }
  if (
    conversationId !== undefined &&
    (typeof conversationId !== "string" ||
      !/^[A-Za-z0-9-]{1,64}$/.test(conversationId))
  ) {
    return "bad conversationId";
  }
  return null;
}

describe("curating-memory-palace guidance", () => {
  test("every example button renders, with an instruction under 200 characters", () => {
    const blocks = [
      ...guidance.matchAll(/```palace-action\s*\n([\s\S]*?)```/g),
    ].map((match) => match[1] ?? "");

    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(actionProblem(block)).toBeNull();
      const { instruction } = JSON.parse(block) as { instruction?: string };
      expect(instruction?.length ?? 0).toBeLessThan(200);
    }
  });

  test("the example index lists the three core sections first, in order", () => {
    const index = [...guidance.matchAll(/```markdown\n([\s\S]*?)```/g)]
      .map((match) => match[1] ?? "")
      .find((block) => block.startsWith("# Memory Palace"));
    const links = [...(index ?? "").matchAll(/\]\(([^)]+\.md)\)/g)].map(
      (match) => match[1],
    );

    expect(links.slice(0, 3)).toEqual([
      "overview.md",
      "needs-attention.md",
      "suggestions.md",
    ]);
  });

  test("routine health guidance supplies the required schedule ID for run history", () => {
    expect(guidance).toContain("`letta cron list --agent <agent-id>`");
    expect(guidance).toContain(
      "`letta cron runs --id <id> --agent <agent-id>`",
    );
  });
});
