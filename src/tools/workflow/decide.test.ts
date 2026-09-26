import { describe, expect, test } from "bun:test";
import { submitWorkflowDecision } from "./decide.ts";

describe("workflow decision input validation", () => {
  const signal = new AbortController().signal;

  test("rejects missing or malformed state and questions before network", async () => {
    await expect(submitWorkflowDecision(null, signal)).rejects.toThrow(
      /request object/,
    );
    await expect(
      submitWorkflowDecision({ state: null, questions: {} }, signal),
    ).rejects.toThrow(/state/);
    await expect(
      submitWorkflowDecision({ state: "x", questions: {} }, signal),
    ).rejects.toThrow(/non-empty object/);
    await expect(
      submitWorkflowDecision(
        {
          state: "x",
          questions: {
            q: { type: "choice", instructions: "Pick", criteria: {} },
          },
        },
        signal,
      ),
    ).rejects.toThrow(/criteria map/);
    await expect(
      submitWorkflowDecision(
        {
          state: "x",
          questions: {
            q: { type: "score", instructions: "Rate", criteria: [] },
          },
        },
        signal,
      ),
    ).rejects.toThrow(/criteria array/);
    await expect(
      submitWorkflowDecision(
        {
          state: "x",
          questions: { q: { type: "unsupported", instructions: "Pick" } },
        },
        signal,
      ),
    ).rejects.toThrow(/unsupported type/);
  });

  test("accepts only Jev handles and disallows fallbacks", async () => {
    const questions = { q: { type: "noul", instructions: "Is this valid?" } };
    await expect(
      submitWorkflowDecision(
        { state: "x", questions, model: "openai/gpt-4o" },
        signal,
      ),
    ).rejects.toThrow(/Jev handle/);
    await expect(
      submitWorkflowDecision(
        { state: "x", questions, provider: { allow_fallbacks: true } },
        signal,
      ),
    ).rejects.toThrow(/fallbacks/);
    await expect(
      submitWorkflowDecision(
        { state: "x", questions, session_id: "x".repeat(257) },
        signal,
      ),
    ).rejects.toThrow(/session_id/);
  });
});
