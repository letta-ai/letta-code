import { beforeEach, describe, expect, test } from "bun:test";
import { APIError } from "@letta-ai/letta-client/core/error";
import {
  clearErrorContext,
  setErrorContext,
} from "../../cli/helpers/errorContext";
import { formatErrorDetails } from "../../cli/helpers/errorFormatter";

describe("formatErrorDetails", () => {
  beforeEach(() => {
    clearErrorContext();
  });

  test("uses neutral credit exhaustion copy for free tier not-enough-credits", () => {
    setErrorContext({ billingTier: "free", modelDisplayName: "Kimi K2.5" });

    const error = new APIError(
      402,
      {
        error: "Rate limited",
        reasons: ["not-enough-credits"],
      },
      undefined,
      new Headers(),
    );

    const message = formatErrorDetails(error);

    expect(message).toContain("out of credits");
    expect(message).toContain("/connect");
    expect(message).not.toContain("not available on Free plan");
    expect(message).not.toContain("Selected hosted model");
  });

  test("handles nested reasons for credit exhaustion", () => {
    const error = new APIError(
      402,
      {
        error: {
          reasons: ["not-enough-credits"],
        },
      },
      undefined,
      new Headers(),
    );

    const message = formatErrorDetails(error);
    expect(message).toContain("out of credits");
  });

  test("shows explicit model availability guidance for model-unknown", () => {
    const error = new APIError(
      429,
      {
        error: "Rate limited",
        reasons: ["model-unknown"],
      },
      undefined,
      new Headers(),
    );

    const message = formatErrorDetails(error);

    expect(message).toContain("not currently available");
    expect(message).toContain("Run /model");
    expect(message).toContain("press R");
  });

  test("keeps canonical free model pair for byok-not-available-on-free-tier", () => {
    setErrorContext({ modelDisplayName: "GPT-5" });

    const error = new APIError(
      403,
      {
        error: "Forbidden",
        reasons: ["byok-not-available-on-free-tier"],
      },
      undefined,
      new Headers(),
    );

    const message = formatErrorDetails(error);

    expect(message).toContain("glm-4.7");
    expect(message).toContain("minimax-m2.1");
    expect(message).toContain("Free plan");
  });

  test("keeps canonical free model pair for free-usage-exceeded", () => {
    const error = new APIError(
      429,
      {
        error: "Rate limited",
        reasons: ["free-usage-exceeded"],
      },
      undefined,
      new Headers(),
    );

    const message = formatErrorDetails(error);

    expect(message).toContain("glm-4.7");
    expect(message).toContain("minimax-m2.1");
    expect(message).toContain("/model");
  });
});
