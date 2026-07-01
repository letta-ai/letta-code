import { describe, expect, test } from "bun:test";
import {
  normalizeConversationTitle,
  shouldPersistAutoConversationTitle,
} from "./conversation-title";

describe("conversation title helpers", () => {
  test("uses normalized first user text as a fallback title", () => {
    expect(normalizeConversationTitle("  fix   the default title bug  ")).toBe(
      "fix the default title bug",
    );
  });

  test("allows auto-title persistence for local default conversations", () => {
    expect(
      shouldPersistAutoConversationTitle("default", {
        localModelCatalog: true,
      }),
    ).toBe(true);
  });

  test("skips auto-title persistence for hosted default conversations", () => {
    expect(
      shouldPersistAutoConversationTitle("default", {
        localModelCatalog: false,
      }),
    ).toBe(false);
  });
});
