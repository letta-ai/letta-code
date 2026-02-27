import { beforeEach, describe, expect, test } from "bun:test";
import { APIError } from "@letta-ai/letta-client/core/error";
import {
  clearErrorContext,
  setErrorContext,
} from "../../cli/helpers/errorContext";
import {
  checkChatGptUsageLimitError,
  formatErrorDetails,
} from "../../cli/helpers/errorFormatter";

describe("formatErrorDetails", () => {
  beforeEach(() => {
    clearErrorContext();
  });

  describe("encrypted content org mismatch", () => {
    const chatGptDetail =
      'INTERNAL_SERVER_ERROR: ChatGPT request failed (400): {\n  "error": {\n    "message": "The encrypted content for item rs_0dd1c85f779f9f0301698a7e40a0508193ba9a669d32159bf0 could not be verified. Reason: Encrypted content organization_id did not match the target organization.",\n    "type": "invalid_request_error",\n    "param": null,\n    "code": "invalid_encrypted_content"\n  }\n}';

    test("handles nested error object from run metadata", () => {
      // This is the errorObject shape constructed in App.tsx from run.metadata.error
      const errorObject = {
        error: {
          error: {
            message_type: "error_message",
            run_id: "run-cb408f59-f901-4bde-ad1f-ed58a1f13482",
            error_type: "internal_error",
            message: "An error occurred during agent execution.",
            detail: chatGptDetail,
            seq_id: null,
          },
          run_id: "run-cb408f59-f901-4bde-ad1f-ed58a1f13482",
        },
      };

      const result = formatErrorDetails(errorObject);

      expect(result).toContain("OpenAI error:");
      expect(result).toContain("invalid_encrypted_content");
      expect(result).toContain("/clear to start a new conversation.");
      expect(result).toContain("different OpenAI authentication scope");
      // Should NOT be raw JSON
      expect(result).not.toContain('"message_type"');
      expect(result).not.toContain('"run_id"');
    });

    test("formats inner error as JSON-like block", () => {
      const errorObject = {
        error: {
          error: {
            detail: chatGptDetail,
          },
        },
      };

      const result = formatErrorDetails(errorObject);

      // JSON-like structured format
      expect(result).toContain('type: "invalid_request_error"');
      expect(result).toContain('code: "invalid_encrypted_content"');
      expect(result).toContain("organization_id did not match");
      expect(result).toContain("  {");
      expect(result).toContain("  }");
    });

    test("handles error with direct detail field", () => {
      const errorObject = {
        detail: chatGptDetail,
      };

      const result = formatErrorDetails(errorObject);

      expect(result).toContain("OpenAI error:");
      expect(result).toContain("/clear to start a new conversation.");
    });

    test("falls back gracefully when detail JSON is malformed", () => {
      const errorObject = {
        error: {
          error: {
            detail:
              "INTERNAL_SERVER_ERROR: ChatGPT request failed (400): invalid_encrypted_content garbled",
          },
        },
      };

      const result = formatErrorDetails(errorObject);

      expect(result).toContain("OpenAI error:");
      expect(result).toContain("/clear to start a new conversation.");
    });
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

  test("uses premium-specific guidance for premium-usage-exceeded", () => {
    const error = new APIError(
      429,
      {
        error: "Rate limited",
        reasons: ["premium-usage-exceeded"],
      },
      undefined,
      new Headers(),
    );

    const message = formatErrorDetails(error);

    expect(message).toContain("Premium model usage limit");
    expect(message).toContain("Standard or Basic hosted models");
    expect(message).toContain("/model");
    expect(message).not.toContain("hosted model usage limit");
  });

  test("uses standard-specific guidance for standard-usage-exceeded", () => {
    const error = new APIError(
      429,
      {
        error: "Rate limited",
        reasons: ["standard-usage-exceeded"],
      },
      undefined,
      new Headers(),
    );

    const message = formatErrorDetails(error);

    expect(message).toContain("Standard model usage limit");
    expect(message).toContain("Basic hosted models");
    expect(message).toContain("/model");
  });

  test("uses basic-specific guidance for basic-usage-exceeded", () => {
    const error = new APIError(
      429,
      {
        error: "Rate limited",
        reasons: ["basic-usage-exceeded"],
      },
      undefined,
      new Headers(),
    );

    const message = formatErrorDetails(error);

    expect(message).toContain("Basic model usage limit");
    expect(message).toContain("/model");
  });

  describe("ChatGPT usage_limit_reached", () => {
    const chatGptRateLimitDetail =
      'RATE_LIMIT_EXCEEDED: ChatGPT rate limit exceeded: {"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","plan_type":"team","resets_at":1772074086,"eligible_promo":null,"resets_in_seconds":3032}}';

    test("pretty-prints with reset time and plan type", () => {
      const result = checkChatGptUsageLimitError(chatGptRateLimitDetail);

      expect(result).toBeDefined();
      expect(result).toContain("ChatGPT usage limit reached");
      expect(result).toContain("team plan");
      expect(result).toContain("Resets at");
      expect(result).toContain("/model");
      expect(result).toContain("/connect");
      // Should NOT contain raw JSON
      expect(result).not.toContain('"type"');
      expect(result).not.toContain("RATE_LIMIT_EXCEEDED");
    });

    test("handles error with only resets_at (no resets_in_seconds)", () => {
      const futureTimestamp = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
      const detail = `RATE_LIMIT_EXCEEDED: ChatGPT rate limit exceeded: {"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","plan_type":"plus","resets_at":${futureTimestamp}}}`;

      const result = checkChatGptUsageLimitError(detail);

      expect(result).toBeDefined();
      expect(result).toContain("ChatGPT usage limit reached");
      expect(result).toContain("plus plan");
      expect(result).toContain("Resets at");
    });

    test("handles error with no reset info gracefully", () => {
      const detail =
        'RATE_LIMIT_EXCEEDED: ChatGPT rate limit exceeded: {"error":{"type":"usage_limit_reached","message":"The usage limit has been reached"}}';

      const result = checkChatGptUsageLimitError(detail);

      expect(result).toBeDefined();
      expect(result).toContain("ChatGPT usage limit reached");
      expect(result).toContain("Try again later");
      expect(result).toContain("/model");
    });

    test("handles malformed JSON gracefully", () => {
      const detail =
        "RATE_LIMIT_EXCEEDED: ChatGPT rate limit exceeded: usage_limit_reached {broken json";

      const result = checkChatGptUsageLimitError(detail);

      expect(result).toBeDefined();
      expect(result).toContain("ChatGPT usage limit reached");
    });

    test("returns undefined for non-matching errors", () => {
      const result = checkChatGptUsageLimitError(
        "ChatGPT API error: some other error",
      );
      expect(result).toBeUndefined();
    });

    test("formats correctly via formatErrorDetails from run metadata object", () => {
      // Shape constructed in App.tsx from run.metadata.error
      const errorObject = {
        error: {
          error: {
            message_type: "error_message",
            run_id: "run-abc123",
            error_type: "llm_error",
            message: "An error occurred during agent execution.",
            detail: chatGptRateLimitDetail,
          },
          run_id: "run-abc123",
        },
      };

      const result = formatErrorDetails(errorObject);

      expect(result).toContain("ChatGPT usage limit reached");
      expect(result).toContain("team plan");
      expect(result).toContain("/model");
      // Should NOT contain the raw detail
      expect(result).not.toContain("RATE_LIMIT_EXCEEDED");
      expect(result).not.toContain("[usage_limit_reached]");
    });
  });

  test("formats Z.ai error from APIError with embedded error code", () => {
    const error = new APIError(
      429,
      {
        error:
          "Rate limited by OpenAI: Error code: 429 - {'error': {'code': 1302, 'message': 'High concurrency usage exceeds limits'}}",
      },
      undefined,
      new Headers(),
    );

    const message = formatErrorDetails(error);

    expect(message).toContain("Z.ai rate limit");
    expect(message).toContain("High concurrency usage exceeds limits");
    expect(message).not.toContain("OpenAI");
  });
});
