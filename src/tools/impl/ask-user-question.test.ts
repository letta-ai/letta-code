import { describe, expect, test } from "bun:test";
import { ask_user_question_async } from "./ask-user-question";

describe("ask_user_question_async", () => {
  const baseQuestion = {
    question: "Which approach should we use?",
    header: "Approach",
    options: [
      {
        label: "Recommended",
        description: "Use the recommended approach",
      },
      {
        label: "Alternative",
        description: "Use the alternative approach",
      },
    ],
  };

  test("returns a receipt without waiting for an answer", async () => {
    const result = await ask_user_question_async({
      questions: [baseQuestion],
      toolCallId: "call-question",
    });
    expect(result).toMatchObject({
      type: "ask_user_question",
      version: 2,
      toolCallId: "call-question",
      questions: [baseQuestion],
    });
    expect(result.message).toContain("Answers or dismissal will arrive later");
  });

  test("rejects non-boolean multiSelect values", async () => {
    await expect(
      ask_user_question_async({
        toolCallId: "call-question",
        questions: [
          {
            ...baseQuestion,
            multiSelect: "false" as never,
          },
        ],
      }),
    ).rejects.toThrow("optional boolean multiSelect");
  });

  test("rejects missing executor identity and duplicate question keys", async () => {
    await expect(
      ask_user_question_async({ questions: [baseQuestion], toolCallId: "" }),
    ).rejects.toThrow("executor-provided");
    await expect(
      ask_user_question_async({
        questions: [baseQuestion, baseQuestion],
        toolCallId: "call-question",
      }),
    ).rejects.toThrow("distinct questions");
  });
});
