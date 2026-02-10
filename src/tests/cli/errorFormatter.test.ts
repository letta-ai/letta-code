import { describe, expect, test } from "bun:test";
import { formatErrorDetails } from "../../cli/helpers/errorFormatter";

describe("formatErrorDetails", () => {
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
});
