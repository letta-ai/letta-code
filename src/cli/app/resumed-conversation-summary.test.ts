import { describe, expect, test } from "bun:test";
import { resolveResumedConversationSummary } from "./resumed-conversation-summary";

describe("resolveResumedConversationSummary", () => {
  test("uses the persisted conversation summary", () => {
    expect(
      resolveResumedConversationSummary({ summary: "  Persisted title  " }),
    ).toBe("Persisted title");
  });

  test("preserves selector metadata when it is available", () => {
    expect(
      resolveResumedConversationSummary(
        { summary: "Persisted title" },
        "Selector title",
      ),
    ).toBe("Selector title");
  });

  test("falls back to the persisted summary when selector metadata is absent", () => {
    expect(
      resolveResumedConversationSummary({ summary: "Persisted title" }, null),
    ).toBe("Persisted title");
  });

  test("omits blank persisted summaries", () => {
    expect(
      resolveResumedConversationSummary({ summary: "   " }),
    ).toBeUndefined();
  });
});
