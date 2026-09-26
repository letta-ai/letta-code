import { apiRequest } from "@/backend/api/request";

const DEFAULT_JEV_MODEL = "~typesafe/jev-latest";

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export interface DecisionRequest {
  model?: string;
  state: string | RecordValue | unknown[];
  questions: RecordValue;
  provider?: RecordValue;
  session_id?: string;
  trace?: RecordValue;
  user?: string;
}

export interface DecisionResponse {
  model: string;
  answers: Record<string, RecordValue & { calibrated: true }>;
  usage: { input_tokens: number; output_tokens: number; cost: number };
  id: string;
  provider: string;
}

function validateRequest(input: unknown): DecisionRequest {
  if (!isRecord(input)) throw new Error("decide() requires a request object.");
  const { model, state, questions, provider, session_id, trace, user } = input;
  if (
    model !== undefined &&
    (typeof model !== "string" ||
      (!/^typesafe\/jev-[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(model) &&
        model !== DEFAULT_JEV_MODEL))
  ) {
    throw new Error("decide() model must be a Jev handle.");
  }
  if (!(typeof state === "string" || isRecord(state) || Array.isArray(state))) {
    throw new Error("decide() state must be a string, object, or array.");
  }
  if (!isRecord(questions) || Object.keys(questions).length === 0) {
    throw new Error("decide() questions must be a non-empty object.");
  }
  for (const [id, question] of Object.entries(questions)) {
    if (
      !isRecord(question) ||
      typeof question.instructions !== "string" ||
      !question.instructions.trim()
    ) {
      throw new Error(`decide() question ${id} requires instructions.`);
    }
    if (question.type === "choice") {
      if (
        !isRecord(question.criteria) ||
        Object.keys(question.criteria).length === 0 ||
        Object.keys(question.criteria).length > 255 ||
        !Object.values(question.criteria).every(
          (value) => typeof value === "string",
        )
      ) {
        throw new Error(
          `decide() choice ${id} requires a non-empty criteria map (at most 255 options).`,
        );
      }
    } else if (question.type === "score") {
      if (
        !Array.isArray(question.criteria) ||
        question.criteria.length === 0 ||
        !question.criteria.every((value) => typeof value === "string")
      ) {
        throw new Error(
          `decide() score ${id} requires a non-empty criteria array.`,
        );
      }
    } else if (question.type !== "noul") {
      throw new Error(`decide() question ${id} has an unsupported type.`);
    }
  }
  if (provider !== undefined && !isRecord(provider))
    throw new Error("decide() provider must be an object.");
  if (isRecord(provider) && provider.allow_fallbacks === true) {
    throw new Error("decide() does not allow model/provider fallbacks.");
  }
  if (
    session_id !== undefined &&
    (typeof session_id !== "string" || session_id.length > 256)
  ) {
    throw new Error(
      "decide() session_id must be a string of at most 256 characters.",
    );
  }
  if (trace !== undefined && !isRecord(trace))
    throw new Error("decide() trace must be an object.");
  if (user !== undefined && typeof user !== "string")
    throw new Error("decide() user must be a string.");
  return input as unknown as DecisionRequest;
}

function validProbabilityMap(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every(isFiniteNumber);
}

function validAnswer(answer: unknown, question: RecordValue): boolean {
  if (!isRecord(answer) || answer.type !== question.type) return false;
  if (answer.type === "choice") {
    return (
      typeof answer.choice === "string" &&
      isRecord(question.criteria) &&
      Object.hasOwn(question.criteria, answer.choice) &&
      (answer.probabilities === undefined ||
        validProbabilityMap(answer.probabilities)) &&
      (answer.confidence === undefined || isFiniteNumber(answer.confidence))
    );
  }
  if (answer.type === "score") {
    return (
      isFiniteNumber(answer.score) &&
      isRecord(answer.legend) &&
      Object.values(answer.legend).every(
        (value) => typeof value === "string",
      ) &&
      (answer.probabilities === undefined ||
        validProbabilityMap(answer.probabilities)) &&
      (answer.confidence === undefined || isFiniteNumber(answer.confidence))
    );
  }
  return (
    answer.type === "noul" &&
    isFiniteNumber(answer.noul) &&
    answer.noul >= 0 &&
    answer.noul <= 1
  );
}

function validateResponse(
  response: unknown,
  request: DecisionRequest,
): DecisionResponse {
  if (
    !isRecord(response) ||
    typeof response.model !== "string" ||
    typeof response.id !== "string" ||
    typeof response.provider !== "string" ||
    !isRecord(response.usage) ||
    !isFiniteNumber(response.usage.input_tokens) ||
    !isFiniteNumber(response.usage.output_tokens) ||
    !isFiniteNumber(response.usage.cost) ||
    !isRecord(response.answers)
  ) {
    throw new Error("decide() received a malformed response.");
  }
  const answers = response.answers as RecordValue;
  const questionIds = Object.keys(request.questions);
  if (
    Object.keys(answers).length !== questionIds.length ||
    questionIds.some(
      (id) => !validAnswer(answers[id], request.questions[id] as RecordValue),
    )
  ) {
    throw new InvalidDecisionAnswerError();
  }
  return {
    ...response,
    answers: Object.fromEntries(
      questionIds.map((id) => [
        id,
        { ...(answers[id] as RecordValue), calibrated: true },
      ]),
    ),
  } as unknown as DecisionResponse;
}

class InvalidDecisionAnswerError extends Error {
  constructor() {
    super("decide() received invalid answers for the requested questions.");
  }
}

/** Submit one typed Jev decision; only an invalid answer is retried once. */
export async function submitWorkflowDecision(
  input: unknown,
  signal: AbortSignal,
  onResult?: (result: {
    model: string;
    cost?: number;
    calibrated: boolean;
    valid: boolean;
    totalTokens: number;
  }) => void,
): Promise<DecisionResponse | null> {
  const request = validateRequest(input);
  const body: RecordValue = {
    ...request,
    model: request.model ?? DEFAULT_JEV_MODEL,
    // Jev is the only supported model; never silently switch provider.
    provider: { ...request.provider, allow_fallbacks: false },
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal.aborted) throw new Error("Workflow aborted.");
    const response = await apiRequest<unknown>(
      "POST",
      "/v1/alpha/decisions",
      body,
      { signal: AbortSignal.any([signal, AbortSignal.timeout(35_000)]) },
    );
    try {
      const result = validateResponse(response, request);
      onResult?.({
        model: result.model,
        cost: result.usage.cost,
        calibrated: true,
        valid: true,
        totalTokens: result.usage.input_tokens + result.usage.output_tokens,
      });
      return result;
    } catch (error) {
      if (!(error instanceof InvalidDecisionAnswerError)) throw error;
      const usage = (response as { usage: DecisionResponse["usage"] }).usage;
      onResult?.({
        model: (response as { model: string }).model,
        cost: usage.cost,
        calibrated: false,
        valid: false,
        totalTokens: usage.input_tokens + usage.output_tokens,
      });
      if (attempt === 1) return null;
    }
  }
  return null;
}
