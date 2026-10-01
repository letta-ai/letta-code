import { describe, expect, test } from "bun:test";
import guidance from "@/skills/builtin/curating-memory-palace/SKILL.md";

const ACTION_KEYS = new Set([
  "actionId",
  "label",
  "conversationId",
  "instruction",
  "kind",
]);
const LINK_KEYS = new Set(["label", "url"]);

/**
 * Why the Palace would not show a `palace-action` block as a button, or null.
 * Mirrors the action parser in Letta Code Desktop, which ignores unknown keys
 * and hides a block that is still invalid.
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
  const { actionId, label, conversationId, instruction, kind } =
    parsed as Record<string, unknown>;
  if (typeof actionId !== "string" || !/^\S{1,64}$/.test(actionId)) {
    return "bad actionId";
  }
  if (typeof label !== "string" || !label.trim() || label.length > 80) {
    return "bad label";
  }
  if (
    instruction !== undefined &&
    (typeof instruction !== "string" || instruction.length > 1000)
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
  if (kind !== undefined && typeof kind !== "string") return "bad kind";
  return null;
}

/**
 * Why the Palace would show a `palace-links` block as an error instead of
 * link chips, or null. Mirrors the links parser in Letta Code Desktop.
 * Why the Palace would not show a `palace-links` block as link chips, or null.
 * Mirrors the links parser in Letta Code Desktop, which hides a block that is
 * still invalid.
function linksProblem(source: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return "not JSON";
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 4) {
    return "not a list of 1 to 4 links";
  }
  for (const entry of parsed as unknown[]) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return "not an object";
    }
    const extra = Object.keys(entry).filter((key) => !LINK_KEYS.has(key));
    if (extra.length > 0) return `unknown keys: ${extra.join(", ")}`;
    const { label, url } = entry as Record<string, unknown>;
    if (typeof label !== "string" || !label.trim() || label.length > 60) {
      return "bad label";
    }
    if (typeof url !== "string" || url.length > 2000) return "bad url";
    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol !== "https:" || !parsedUrl.hostname) {
        return "bad url";
      }
    } catch {
      return "bad url";
    }
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
      // The page ignores unknown keys, but examples must model documented ones.
      expect(
        Object.keys(JSON.parse(block)).filter((key) => !ACTION_KEYS.has(key)),
      ).toEqual([]);
      const { instruction } = JSON.parse(block) as { instruction?: string };
      expect(instruction?.length ?? 0).toBeLessThan(200);
    }
  });

  test("every example links block renders", () => {
    const blocks = [
      ...guidance.matchAll(/```palace-links\s*\n([\s\S]*?)```/g),
    ].map((match) => match[1] ?? "");

    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(linksProblem(block)).toBeNull();
    }
  });

  test("the example index lists the core sections first, in order", () => {
    const index = [...guidance.matchAll(/```markdown\n([\s\S]*?)```/g)]
      .map((match) => match[1] ?? "")
      .find((block) => block.startsWith("# Memory Palace"));
    const links = [...(index ?? "").matchAll(/\]\(([^)]+\.md)\)/g)].map(
      (match) => match[1],
    );

    expect(links.slice(0, 4)).toEqual([
      "overview.md",
      "needs-attention.md",
      "suggestions.md",
      "curiosities.md",
    ]);
  });

  test("an unknown button key is ignored, and the skill says so", () => {
    expect(
      actionProblem('{"actionId": "a", "label": "Do it", "cadence": "weekly"}'),
    ).toBeNull();
    expect(guidance).not.toContain("renders the block as an error");
    expect(guidance).toContain("Unknown keys are ignored");
    expect(guidance).toContain("Use only the keys above");
  });

  test("the instruction limit is 1,000 characters, with advice to stay under 200", () => {
    expect(guidance).not.toContain("300 characters");
    expect(guidance).toContain("up to 1,000 characters");
    expect(guidance).toContain("aim for under 200");
  });

  test("Curiosities buttons name the check and the section isn't padded", () => {
    expect(guidance).not.toContain('one "Investigate" button');
    expect(guidance).toContain('"Check PR 324\'s status"');
    expect(guidance).toContain("gets its Connect link and no button");
    expect(guidance).toContain("Never a fix, draft, or schedule button");
    expect(guidance).toContain("Don't pad the section");
  });

  test("write-ups default to one or two sentences", () => {
    expect(guidance).toContain("one or two sentences by default");
    expect(guidance).not.toContain("as many sentences as it needs");
  });

  test("the Overview gives the role and where the main work stands", () => {
    expect(guidance).toContain("A role line alone isn't enough");
  });

  test("the page covers only the user's own work", () => {
    expect(guidance).toContain("The page covers only the user's own work");
    expect(guidance).toContain(
      "Work that sits with someone else stays off the page",
    );
  });

  test("routine health guidance supplies the required schedule ID for run history", () => {
    expect(guidance).toContain("`letta cron list --agent <agent-id>`");
    expect(guidance).toContain(
      "`letta cron runs --id <id> --agent <agent-id>`",
    );
  });
});
