import { validateRequiredParams } from "./validation.js";

interface QuestionOption {
  label: string;
  description: string;
}

interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

interface AskUserQuestionArgs {
  questions: Question[];
  answers?: Record<string, string>;
}

interface AskUserQuestionResult {
  message: string;
}

export async function ask_user_question(
  args: AskUserQuestionArgs,
): Promise<AskUserQuestionResult> {
  validateRequiredParams(args, ["questions"], "AskUserQuestion");

  if (!Array.isArray(args.questions) || args.questions.length === 0) {
    throw new Error("questions must be a non-empty array");
  }

  if (args.questions.length > 4) {
    throw new Error("Maximum of 4 questions allowed");
  }

  for (const q of args.questions) {
    if (!q.question || typeof q.question !== "string") {
      throw new Error("Each question must have a question string");
    }
    if (!q.header || typeof q.header !== "string") {
      throw new Error("Each question must have a header string");
    }
    if (
      !Array.isArray(q.options) ||
      q.options.length < 2 ||
      q.options.length > 4
    ) {
      throw new Error("Each question must have 2-4 options");
    }
    if (typeof q.multiSelect !== "boolean") {
      throw new Error("Each question must have a multiSelect boolean");
    }
    for (const opt of q.options) {
      if (!opt.label || typeof opt.label !== "string") {
        throw new Error("Each option must have a label string");
      }
      if (!opt.description || typeof opt.description !== "string") {
        throw new Error("Each option must have a description string");
      }
    }
  }

  // If answers are provided (filled in by UI layer), format the response
  if (args.answers && Object.keys(args.answers).length > 0) {
    const answerParts = args.questions.map((q) => {
      const answer = args.answers?.[q.question] || "";
      return `"${q.question}"="${answer}"`;
    });
    return {
      message: `User has answered your questions: ${answerParts.join(", ")}. You can now continue with the user's answers in mind.`,
    };
  }

  // Otherwise, return a placeholder - the UI layer should intercept this tool call
  // and show the question UI before returning the actual response
  return {
    message: "Waiting for user response...",
  };
}
