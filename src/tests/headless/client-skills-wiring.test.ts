import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("headless client skills wiring", () => {
  test("pre-load-skills resolves skill paths from client-skills helper", () => {
    const headlessPath = fileURLToPath(
      new URL("../../headless.ts", import.meta.url),
    );
    const source = readFileSync(headlessPath, "utf-8");

    expect(source).toContain("buildClientSkillsPayload({");
    expect(source).toContain(
      "const { skillPathById } = await buildClientSkillsPayload",
    );
    expect(source).toContain("const skillPath = skillPathById[skillId]");
    expect(source).not.toContain("sharedReminderState.skillPathById");
  });
});
