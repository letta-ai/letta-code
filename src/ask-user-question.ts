/** Browser-safe question receipts and user-message notifications. */
export interface AskUserQuestion {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiSelect?: boolean;
}

export interface AskUserQuestionReceipt {
  type: "ask_user_question";
  version: 2;
  toolCallId: string;
  questions: AskUserQuestion[];
}

export interface AskUserQuestionResponse {
  type: "ask_user_question_response";
  version: 2;
  toolCallId: string;
  questions: AskUserQuestion[];
  status: "answered" | "dismissed";
  answers?: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isAskUserQuestions(value: unknown): value is AskUserQuestion[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 4 &&
    value.every(
      (question) =>
        isRecord(question) &&
        isNonemptyString(question.question) &&
        isNonemptyString(question.header) &&
        (question.multiSelect === undefined ||
          typeof question.multiSelect === "boolean") &&
        Array.isArray(question.options) &&
        question.options.length >= 2 &&
        question.options.length <= 4 &&
        question.options.every(
          (option: unknown) =>
            isRecord(option) &&
            isNonemptyString(option.label) &&
            isNonemptyString(option.description),
        ),
    ) &&
    new Set(value.map((question) => question.question)).size === value.length
  );
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function hasQuestionIdentity(value: unknown): value is Record<
  string,
  unknown
> & {
  version: 2;
  toolCallId: string;
  questions: AskUserQuestion[];
} {
  return (
    isRecord(value) &&
    value.version === 2 &&
    isNonemptyString(value.toolCallId) &&
    isAskUserQuestions(value.questions)
  );
}

export function parseAskUserQuestionReceipt(
  value: unknown,
): AskUserQuestionReceipt | null {
  const receipt = typeof value === "string" ? parseJson(value) : value;
  if (!hasQuestionIdentity(receipt) || receipt.type !== "ask_user_question")
    return null;
  return {
    type: receipt.type,
    version: 2,
    toolCallId: receipt.toolCallId,
    questions: receipt.questions,
  };
}

function parseResponse(value: unknown): AskUserQuestionResponse | null {
  if (
    !hasQuestionIdentity(value) ||
    value.type !== "ask_user_question_response"
  )
    return null;
  const base = {
    type: value.type,
    version: 2,
    toolCallId: value.toolCallId,
    questions: value.questions,
  } as const;
  if (value.status === "dismissed" && value.answers === undefined)
    return { ...base, status: "dismissed" };
  if (value.status !== "answered" || !isRecord(value.answers)) return null;
  const answers = value.answers;
  if (
    Object.keys(answers).length !== value.questions.length ||
    !value.questions.every(
      (question) =>
        Object.hasOwn(answers, question.question) &&
        isNonemptyString(answers[question.question]),
    )
  )
    return null;
  return {
    ...base,
    status: "answered",
    answers: answers as Record<string, string>,
  };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Return content for a user-role message submitted through normal message delivery. */
export function prepareAskUserQuestionNotif(
  response: AskUserQuestionResponse,
): string {
  const parsed = parseResponse(response);
  if (!parsed) throw new Error("Invalid AskUserQuestion response");
  return `<task-notification>\n<task-id>${escapeXml(parsed.toolCallId)}</task-id>\n<summary>User ${parsed.status} your questions.</summary>\n<ask-user-question-response>${escapeXml(JSON.stringify(parsed))}</ask-user-question-response>\n</task-notification>`;
}

/** Match only complete notifications; queued messages may coalesce several together. */
export function parseAskUserQuestionNotif(
  text: string,
): AskUserQuestionResponse[] {
  const responses: AskUserQuestionResponse[] = [];
  const notifications = text.matchAll(
    /<task-notification>(?:(?!<task-notification>)[\s\S])*?<\/task-notification>/g,
  );
  for (const [notification] of notifications) {
    const content = notification.match(
      /<ask-user-question-response>([\s\S]*?)<\/ask-user-question-response>/,
    )?.[1];
    if (!content) continue;
    const decoded = content
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
    const response = parseResponse(parseJson(decoded));
    if (response) responses.push(response);
  }
  return responses;
}
