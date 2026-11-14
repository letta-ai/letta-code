import { describe, expect, test } from "bun:test";
import recallSubagentPrompt from "@/agent/prompts/recall_subagent.md";
import recallSubagentLocalPrompt from "@/agent/prompts/recall_subagent_local.md";

const RECALL_PROMPTS = [
  { name: "recall_subagent.md", prompt: recallSubagentPrompt },
  { name: "recall_subagent_local.md", prompt: recallSubagentLocalPrompt },
];

describe("recall subagent prompts", () => {
  test.each(RECALL_PROMPTS)(
    "$name expands a search hit in the conversation it came from",
    ({ prompt }) => {
      // `messages list` defaults to the agent's `default` conversation, so an
      // expansion that omits `--conversation` reads the wrong conversation.
      const expansions = prompt.match(/letta messages list [^\n]*/g) ?? [];
      const contextExpansions = expansions.filter(
        (command) =>
          command.includes("--before") || command.includes("--after"),
      );
      expect(contextExpansions.length).toBeGreaterThan(0);
      for (const command of contextExpansions) {
        expect(command).toContain("--conversation");
      }
    },
  );

  test.each(RECALL_PROMPTS)(
    "$name documents the conversation id a search result carries",
    ({ prompt }) => {
      expect(prompt).toContain("conversation_id");
      expect(prompt).toContain("--conversation <id>");
    },
  );
});
