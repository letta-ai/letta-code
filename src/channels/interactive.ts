import type {
  ApprovalResponseBody,
  ApprovalResponseDecision,
} from "@/types/protocol_v2";
import type { ChannelControlRequestEvent } from "./types";

type AskUserQuestionInput = {
  questions?: Array<{
    question?: string;
    header?: string;
    options?: Array<{
      label?: string;
      description?: string;
    }>;
    multiSelect?: boolean;
  }>;
  answers?: Record<string, string>;
};

type ParsedChannelControlRequestResponse =
  | {
      type: "response";
      response: ApprovalResponseBody;
    }
  | {
      type: "reprompt";
      message: string;
    };

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isAffirmativeResponse(text: string): boolean {
  const normalized = normalizeWhitespace(text).toLowerCase();
  return [
    "approve",
    "approved",
    "allow",
    "yes",
    "y",
    "ok",
    "okay",
    "continue",
    "go ahead",
    "looks good",
    "lgtm",
    "sgtm",
    "ship it",
  ].includes(normalized);
}

function isNegativeResponse(text: string): boolean {
  const normalized = normalizeWhitespace(text).toLowerCase();
  return [
    "deny",
    "denied",
    "reject",
    "rejected",
    "no",
    "n",
    "cancel",
    "skip",
    "keep planning",
  ].includes(normalized);
}

function stripApprovalPrefix(text: string): string {
  return normalizeWhitespace(
    text.replace(
      /^(approve|allow|yes|y|ok|okay|deny|reject|no|n)\s*[:-]?\s*/i,
      "",
    ),
  );
}

function summarizeControlRequestInput(
  input: Record<string, unknown>,
): string | null {
  const serialized = JSON.stringify(input, null, 2);
  if (!serialized || serialized === "{}") {
    return null;
  }
  if (serialized.length <= 1200) {
    return serialized;
  }
  return `${serialized.slice(0, 1197).trimEnd()}...`;
}

function summarizePlanPreview(planContent: string): string {
  const normalized = planContent.trim();
  if (!normalized) {
    return "";
  }

  const maxLength = 1800;
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength).trimEnd()}\n\n[Plan preview truncated for channel delivery.]`;
}

function buildQuestionPrompt(
  question: NonNullable<AskUserQuestionInput["questions"]>[number],
  index: number,
): string[] {
  const lines = [
    `${index + 1}. ${question.question ?? `Question ${index + 1}`}`,
  ];
  const options = question.options ?? [];
  options.forEach((option, optionIndex) => {
    const label = option.label?.trim() || `Option ${optionIndex + 1}`;
    const description = option.description?.trim();
    lines.push(
      description
        ? `   ${optionIndex + 1}) ${label} — ${description}`
        : `   ${optionIndex + 1}) ${label}`,
    );
  });
  if (question.multiSelect) {
    lines.push(
      "   Choose one or more options. Separate multiple answers with commas.",
    );
  }
  return lines;
}

function matchQuestionOption(
  question: NonNullable<AskUserQuestionInput["questions"]>[number],
  text: string,
): string {
  const trimmed = normalizeWhitespace(text);
  const options = question.options ?? [];
  if (!trimmed || options.length === 0) {
    return trimmed;
  }

  const numberMatch = trimmed.match(/^(\d+)$/);
  if (numberMatch?.[1]) {
    const option = options[Number(numberMatch[1]) - 1];
    if (option?.label?.trim()) {
      return option.label.trim();
    }
  }

  const exactLabel = options.find(
    (option) =>
      option.label &&
      normalizeWhitespace(option.label).toLowerCase() === trimmed.toLowerCase(),
  );
  if (exactLabel?.label?.trim()) {
    return exactLabel.label.trim();
  }

  const trimmedLower = trimmed.toLowerCase();
  const exactAlias = options.find((option) =>
    optionAliases(option).some(
      (alias) => normalizeWhitespace(alias).toLowerCase() === trimmedLower,
    ),
  );
  if (exactAlias?.label?.trim()) {
    return exactAlias.label.trim();
  }

  if (/^(recommended|default|defaults)$/i.test(trimmed)) {
    const recommended = options.find((option) => {
      const label = option.label?.toLowerCase() ?? "";
      const description = option.description?.toLowerCase() ?? "";
      return (
        label.includes("recommended") || description.includes("recommended")
      );
    });
    if (recommended?.label?.trim()) {
      return recommended.label.trim();
    }
  }

  return trimmed;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function optionAliases(option: { label?: string }): string[] {
  const aliases = new Set<string>();
  const label = normalizeWhitespace(option.label ?? "");
  if (label) {
    aliases.add(label);
    const withoutParenthetical = normalizeWhitespace(
      label.replace(/\s*\([^)]*\)\s*/g, " "),
    );
    if (withoutParenthetical) {
      aliases.add(withoutParenthetical);
    }
  }
  return Array.from(aliases).filter((alias) => alias.length >= 3);
}

function containsPhrase(text: string, phrase: string): boolean {
  const normalizedText = normalizeWhitespace(text);
  const normalizedPhrase = normalizeWhitespace(phrase);
  if (!normalizedText || !normalizedPhrase) {
    return false;
  }

  const escapedPhrase = escapeRegExp(normalizedPhrase).replace(/\s+/g, "\\s+");
  return new RegExp(`(^|\\W)${escapedPhrase}(?=$|\\W)`, "i").test(
    normalizedText,
  );
}

function inferQuestionAnswerFromText(
  question: NonNullable<AskUserQuestionInput["questions"]>[number],
  rawText: string,
): string | null {
  const options = question.options ?? [];
  const matches = options
    .filter((option) =>
      optionAliases(option).some((alias) => containsPhrase(rawText, alias)),
    )
    .map((option) => option.label?.trim())
    .filter((label): label is string => Boolean(label));

  const uniqueMatches = Array.from(new Set(matches));
  if (uniqueMatches.length === 1) {
    return uniqueMatches[0] ?? null;
  }

  const normalized = normalizeWhitespace(rawText).toLowerCase();
  if (
    /\b(recommended|default|defaults|you decide|whatever you recommend)\b/.test(
      normalized,
    )
  ) {
    const recommended = options.find((option) => {
      const label = option.label?.toLowerCase() ?? "";
      const description = option.description?.toLowerCase() ?? "";
      return (
        label.includes("recommended") || description.includes("recommended")
      );
    });
    if (recommended?.label?.trim()) {
      return recommended.label.trim();
    }
  }

  return null;
}

function matchQuestionAnswer(
  question: NonNullable<AskUserQuestionInput["questions"]>[number],
  text: string,
): string {
  if (!question.multiSelect) {
    return matchQuestionOption(question, text);
  }

  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return normalized;
  }

  const selections = normalized
    .replace(/\band\b/gi, ",")
    .split(/\s*(?:,|\/|;)\s*/)
    .map((entry) => normalizeWhitespace(entry))
    .filter(Boolean);

  if (selections.length <= 1) {
    return matchQuestionOption(question, normalized);
  }

  const matchedSelections = Array.from(
    new Set(
      selections
        .map((selection) => matchQuestionOption(question, selection))
        .filter(Boolean),
    ),
  );

  return matchedSelections.length > 0
    ? matchedSelections.join(", ")
    : normalized;
}

function parseNumberedAnswers(
  rawText: string,
  questions: NonNullable<AskUserQuestionInput["questions"]>,
): Record<string, string> | null {
  const matches = Array.from(
    rawText.matchAll(
      /(?:^|\n)\s*(\d+)[).:-]\s*(.+?)(?=(?:\n\s*\d+[).:-]\s*)|$)/gs,
    ),
  );
  if (matches.length === 0) {
    return null;
  }

  const answers: Record<string, string> = {};
  for (const match of matches) {
    const questionIndex = Number(match[1]) - 1;
    const question = questions[questionIndex];
    const answerText = match[2]?.trim();
    if (!question?.question || !answerText) {
      continue;
    }
    answers[question.question] = matchQuestionAnswer(question, answerText);
  }

  return Object.keys(answers).length > 0 ? answers : null;
}

function parsePositionalAnswers(
  rawText: string,
  questions: NonNullable<AskUserQuestionInput["questions"]>,
): Record<string, string> | null {
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean);
  if (lines.length === questions.length) {
    const answers: Record<string, string> = {};
    questions.forEach((question, index) => {
      if (question.question) {
        answers[question.question] = matchQuestionAnswer(
          question,
          lines[index] ?? "",
        );
      }
    });
    return answers;
  }

  const normalized = normalizeWhitespace(rawText);
  const compactParts = normalized
    .split(/\s*(?:,|\/|;)\s*/)
    .map((part) => normalizeWhitespace(part))
    .filter(Boolean);
  if (
    compactParts.length === questions.length &&
    compactParts.every((part) => /^\d+$/.test(part))
  ) {
    const answers: Record<string, string> = {};
    questions.forEach((question, index) => {
      if (question.question) {
        answers[question.question] = matchQuestionAnswer(
          question,
          compactParts[index] ?? "",
        );
      }
    });
    return answers;
  }

  return null;
}

function parseFlexibleMultiQuestionAnswers(
  rawText: string,
  questions: NonNullable<AskUserQuestionInput["questions"]>,
): Record<string, string> | null {
  const normalized = normalizeWhitespace(rawText);
  if (!normalized) {
    return null;
  }

  const positionalAnswers = parsePositionalAnswers(rawText, questions);
  if (positionalAnswers) {
    return positionalAnswers;
  }

  const answers: Record<string, string> = {};
  for (const question of questions) {
    if (!question.question) {
      continue;
    }
    const inferred = inferQuestionAnswerFromText(question, rawText);
    if (inferred) {
      answers[question.question] = inferred;
    }
  }

  const hasInferredAnswers = Object.keys(answers).length > 0;
  for (const question of questions) {
    if (!question.question || Object.hasOwn(answers, question.question)) {
      continue;
    }
    answers[question.question] = hasInferredAnswers
      ? `Not specified. Full user reply: ${normalized}`
      : normalized;
  }

  return Object.keys(answers).length > 0 ? answers : null;
}

function buildAllowResponse(
  requestId: string,
  decision: ApprovalResponseDecision,
): ApprovalResponseBody {
  return {
    request_id: requestId,
    decision,
  };
}

function buildDenyResponse(
  requestId: string,
  message: string,
): ApprovalResponseBody {
  return {
    request_id: requestId,
    decision: {
      behavior: "deny",
      message,
    },
  };
}

function getAskUserQuestionInput(
  input: Record<string, unknown>,
): AskUserQuestionInput {
  return input as AskUserQuestionInput;
}

function formatAskUserQuestionPrompt(
  event: ChannelControlRequestEvent,
): string {
  const input = getAskUserQuestionInput(event.input);
  const questions = (input.questions ?? []).filter((question) =>
    normalizeWhitespace(question.question ?? ""),
  );

  const lines = [
    "SYSTEM MESSAGE — reply required to continue",
    "",
    ...questions.flatMap((question, index) =>
      buildQuestionPrompt(question, index),
    ),
    "",
  ];

  if (questions.length <= 1) {
    const singleQuestion = questions[0];
    lines.push(
      singleQuestion?.multiSelect
        ? "Reply with one or more option numbers/labels separated by commas, or just send a freeform answer in your next message."
        : "Reply with an option number/label, or just send a freeform answer in your next message.",
    );
  } else {
    lines.push(
      "Reply in plain language, or answer each question separately with numbered lines:",
      "1: your answer",
      "2: your answer",
      "",
      "Option numbers/labels work too. For multi-select questions, separate multiple answers with commas.",
    );
  }

  return lines.join("\n");
}

function formatEnterPlanModePrompt(): string {
  return [
    "The agent wants to enter plan mode before making changes.",
    "",
    "Reply `approve` to let it plan first, or reply `deny` to skip planning and continue normally.",
  ].join("\n");
}

function formatExitPlanModePrompt(event: ChannelControlRequestEvent): string {
  const lines = [
    "The agent is ready to leave plan mode and start implementing.",
  ];

  if (event.planContent?.trim()) {
    lines.push("", "Proposed plan:", summarizePlanPreview(event.planContent));
    if (event.planFilePath?.trim()) {
      lines.push("", `Plan file: ${event.planFilePath.trim()}`);
    }
  }

  lines.push(
    "",
    "Reply `approve` to accept the plan and start coding.",
    "Reply with feedback instead if you want the agent to keep planning.",
  );
  return lines.join("\n");
}

function formatGenericToolApprovalPrompt(
  event: ChannelControlRequestEvent,
): string {
  const inputSummary = summarizeControlRequestInput(event.input);
  const lines = [`The agent wants approval to run \`${event.toolName}\`.`];

  if (inputSummary) {
    lines.push("", "Tool input:", inputSummary);
  }

  lines.push(
    "",
    "Reply `approve` to allow it.",
    "Reply with feedback instead if you want to deny it.",
  );
  return lines.join("\n");
}

export function formatChannelControlRequestPrompt(
  event: ChannelControlRequestEvent,
): string {
  switch (event.kind) {
    case "ask_user_question":
      return formatAskUserQuestionPrompt(event);
    case "enter_plan_mode":
      return formatEnterPlanModePrompt();
    case "exit_plan_mode":
      return formatExitPlanModePrompt(event);
    case "generic_tool_approval":
      return formatGenericToolApprovalPrompt(event);
    default: {
      const exhaustiveCheck: never = event.kind;
      return exhaustiveCheck;
    }
  }
}

function parseAskUserQuestionResponse(
  event: ChannelControlRequestEvent,
  rawText: string,
): ParsedChannelControlRequestResponse {
  const input = getAskUserQuestionInput(event.input);
  const questions = (input.questions ?? []).filter((question) =>
    normalizeWhitespace(question.question ?? ""),
  );
  if (questions.length === 0) {
    return {
      type: "reprompt",
      message:
        "I couldn't find the original question payload. Please ask the agent to try again.",
    };
  }

  if (questions.length === 1) {
    const [question] = questions;
    if (!question?.question) {
      return {
        type: "reprompt",
        message:
          "I couldn't find the original question text. Please ask the agent to try again.",
      };
    }
    const answer = matchQuestionAnswer(question, rawText);
    return {
      type: "response",
      response: buildAllowResponse(event.requestId, {
        behavior: "allow",
        updated_input: {
          ...event.input,
          answers: {
            ...(input.answers ?? {}),
            [question.question]: answer,
          },
        },
      }),
    };
  }

  const numberedAnswers = parseNumberedAnswers(rawText, questions);
  const answers =
    numberedAnswers ?? parseFlexibleMultiQuestionAnswers(rawText, questions);
  if (!answers) {
    return {
      type: "reprompt",
      message:
        "Please send a reply so I can pass it back to the agent. You can answer naturally or use numbered lines like `1: ...` and `2: ...`.",
    };
  }

  return {
    type: "response",
    response: buildAllowResponse(event.requestId, {
      behavior: "allow",
      updated_input: {
        ...event.input,
        answers: {
          ...(input.answers ?? {}),
          ...answers,
        },
      },
    }),
  };
}

function parseEnterPlanModeResponse(
  event: ChannelControlRequestEvent,
  rawText: string,
): ParsedChannelControlRequestResponse {
  if (isAffirmativeResponse(rawText)) {
    return {
      type: "response",
      response: buildAllowResponse(event.requestId, {
        behavior: "allow",
      }),
    };
  }

  if (isNegativeResponse(rawText)) {
    return {
      type: "response",
      response: buildDenyResponse(
        event.requestId,
        "User chose to skip plan mode and continue implementing directly.",
      ),
    };
  }

  return {
    type: "reprompt",
    message:
      "Reply `approve` to let the agent enter plan mode, or `deny` to skip planning.",
  };
}

function parseExitPlanModeResponse(
  event: ChannelControlRequestEvent,
  rawText: string,
): ParsedChannelControlRequestResponse {
  if (isAffirmativeResponse(rawText)) {
    return {
      type: "response",
      response: buildAllowResponse(event.requestId, {
        behavior: "allow",
      }),
    };
  }

  const feedback = stripApprovalPrefix(rawText);
  return {
    type: "response",
    response: buildDenyResponse(
      event.requestId,
      feedback || "Please keep planning and revise the proposal.",
    ),
  };
}

function parseGenericToolApprovalResponse(
  event: ChannelControlRequestEvent,
  rawText: string,
): ParsedChannelControlRequestResponse {
  if (isAffirmativeResponse(rawText)) {
    const message = stripApprovalPrefix(rawText);
    return {
      type: "response",
      response: buildAllowResponse(event.requestId, {
        behavior: "allow",
        ...(message ? { message } : {}),
      }),
    };
  }

  const feedback = stripApprovalPrefix(rawText);
  return {
    type: "response",
    response: buildDenyResponse(
      event.requestId,
      feedback || "Denied by channel user.",
    ),
  };
}

export function parseChannelControlRequestResponse(
  event: ChannelControlRequestEvent,
  rawText: string,
): ParsedChannelControlRequestResponse {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return {
      type: "reprompt",
      message: formatChannelControlRequestPrompt(event),
    };
  }

  switch (event.kind) {
    case "ask_user_question":
      return parseAskUserQuestionResponse(event, trimmed);
    case "enter_plan_mode":
      return parseEnterPlanModeResponse(event, trimmed);
    case "exit_plan_mode":
      return parseExitPlanModeResponse(event, trimmed);
    case "generic_tool_approval":
      return parseGenericToolApprovalResponse(event, trimmed);
    default: {
      const exhaustiveCheck: never = event.kind;
      return exhaustiveCheck;
    }
  }
}
