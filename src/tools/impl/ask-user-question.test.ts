import { describe, expect, test } from "bun:test";
import { ask_user_question } from "./ask-user-question";

describe("ask_user_question", () => {
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

  test("defaults missing multiSelect to single-select for answered questions", async () => {
    const result = await ask_user_question({
      questions: [baseQuestion],
      answers: {
        "Which approach should we use?": "Recommended",
      },
    });

    expect(result.message).toBe(
      'User has answered your questions: "Which approach should we use?"="Recommended". You can now continue with the user\'s answers in mind.',
    );
  });

  test("rejects non-boolean multiSelect values", async () => {
    await expect(
      ask_user_question({
        questions: [
          {
            ...baseQuestion,
            multiSelect: "false" as never,
          },
        ],
      }),
    ).rejects.toThrow("Each question's multiSelect must be a boolean");
  });
});
