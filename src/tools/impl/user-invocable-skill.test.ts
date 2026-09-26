import { expect, test } from "bun:test";
import { TestDirectory } from "@/test-utils/test-fs";
import {
  findUserInvocableSkillInvocation,
  renderUserInvocableSkillInvocation,
} from "./user-invocable-skill";

test("expands a manual-only project skill with the user's arguments", async () => {
  const directory = new TestDirectory();
  try {
    directory.createFile(
      ".agents/skills/grill-me/SKILL.md",
      "---\nname: grill-me\ndescription: Ask hard questions\ndisable-model-invocation: true\n---\n\nAsk hard questions.\n",
    );
    const options = {
      workingDirectory: directory.path,
      skillSources: ["project" as const],
      attachedRepositories: [],
    };
    const invocation = await findUserInvocableSkillInvocation(
      " /grill-me  about this spec ",
      options,
    );
    expect(invocation?.skill.id).toBe("grill-me");
    expect(invocation?.userRequest).toBe("about this spec");
    if (!invocation) throw new Error("Expected an invocation");
    const prompt = await renderUserInvocableSkillInvocation(invocation);
    expect(prompt).toContain('<skill_content name="grill-me">');
    expect(prompt).toContain("Ask hard questions.");
    expect(prompt).toEndWith("</skill_content>\n\nabout this spec");
    expect(
      await findUserInvocableSkillInvocation("/missing", options),
    ).toBeNull();
  } finally {
    directory.cleanup();
  }
});

test("never expands a skill marked user-invocable: false", async () => {
  const directory = new TestDirectory();
  try {
    directory.createFile(
      ".agents/skills/private/SKILL.md",
      "---\nname: private\ndescription: Not user-invocable\nuser-invocable: false\n---\n",
    );
    const options = {
      workingDirectory: directory.path,
      skillSources: ["project" as const],
      attachedRepositories: [],
    };
    expect(
      await findUserInvocableSkillInvocation("/private", options),
    ).toBeNull();
    expect(
      await findUserInvocableSkillInvocation("ordinary text", options),
    ).toBeNull();
  } finally {
    directory.cleanup();
  }
});
