import {
  type AskUserQuestion,
  type AskUserQuestionReceipt,
  isAskUserQuestions,
} from "@/ask-user-question";

export async function ask_user_question_async(args: {
  questions: AskUserQuestion[];
  toolCallId: string;
}): Promise<AskUserQuestionReceipt & { message: string }> {
  if (!isAskUserQuestions(args.questions)) {
    throw new Error(
      "Expected 1-4 distinct questions, each with a header, 2-4 labeled options with descriptions, and an optional boolean multiSelect",
    );
  }
  if (typeof args.toolCallId !== "string" || !args.toolCallId.trim()) {
    throw new Error(
      "AskUserQuestion requires an executor-provided tool call ID",
    );
  }
  return {
    type: "ask_user_question",
    version: 2,
    toolCallId: args.toolCallId,
    questions: args.questions,
    message:
      "Questions posted. Answers or dismissal will arrive later in a task notification. You may continue working; do not assume an answer.",
  };
}
