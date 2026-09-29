import { expect, test } from "bun:test";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import { TestDirectory } from "@/test-utils/test-fs";
import { expandListenerUserSkillMessages } from "./skill-invocation";

test("expands only explicit text-only user skill messages and keeps their identity", async () => {
  const directory = new TestDirectory();
  try {
    directory.createFile(
      ".agents/skills/grill-me/SKILL.md",
      "---\nname: grill-me\ndescription: Ask hard questions\n---\n\nAsk hard questions.\n",
    );
    const options = {
      workingDirectory: directory.path,
      skillSources: ["project" as const],
      attachedRepositories: [],
    };
    const original: MessageCreate = {
      role: "user",
      content: "/grill-me about this spec",
      otid: "same-client-message",
    };
    const expanded = await expandListenerUserSkillMessages(
      [original],
      options,
      () => false,
    );
    expect(expanded[0]).toMatchObject({
      role: "user",
      otid: "same-client-message",
    });
    if (!expanded[0] || !("content" in expanded[0])) {
      throw new Error("Expected a user message");
    }
    expect(JSON.stringify(expanded[0].content)).toContain(
      "Ask hard questions.",
    );
    expect(JSON.stringify(expanded[0].content)).toContain("about this spec");
    expect(
      await expandListenerUserSkillMessages([original], options, () => true),
    ).toEqual([original]);
    expect(
      await expandListenerUserSkillMessages(
        [{ role: "user", content: "/unknown" }],
        options,
        () => false,
      ),
    ).toEqual([{ role: "user", content: "/unknown" }]);
    expect(
      await expandListenerUserSkillMessages(
        [original, { role: "user", content: "another message" }],
        options,
        () => false,
      ),
    ).toEqual([
      {
        role: "user",
        otid: "same-client-message",
        content: [
          {
            type: "text",
            text: expect.stringContaining("Ask hard questions."),
          },
        ],
      },
      { role: "user", content: "another message" },
    ]);
    const withImage: MessageCreate = {
      role: "user",
      content: [
        { type: "text", text: "/grill-me" },
        {
          type: "image",
          source: { type: "url", url: "https://example.com/a.png" },
        },
      ],
    };
    expect(
      await expandListenerUserSkillMessages([withImage], options, () => false),
    ).toEqual([withImage]);
  } finally {
    directory.cleanup();
  }
});
