import { describe, expect, test } from "bun:test";
import {
  computeRotatedConversationId,
  withCurrentConversation,
} from "@/cli/helpers/conversation-rotation";

describe("computeRotatedConversationId", () => {
  const ids = ["a", "b", "c"];

  test("next advances to the following thread", () => {
    expect(computeRotatedConversationId(ids, "a", "next")).toBe("b");
    expect(computeRotatedConversationId(ids, "b", "next")).toBe("c");
  });

  test("prev moves to the preceding thread", () => {
    expect(computeRotatedConversationId(ids, "c", "prev")).toBe("b");
    expect(computeRotatedConversationId(ids, "b", "prev")).toBe("a");
  });

  test("next wraps from the last thread to the first", () => {
    expect(computeRotatedConversationId(ids, "c", "next")).toBe("a");
  });

  test("prev wraps from the first thread to the last", () => {
    expect(computeRotatedConversationId(ids, "a", "prev")).toBe("c");
  });

  test("returns null when there is only one thread", () => {
    expect(computeRotatedConversationId(["only"], "only", "next")).toBeNull();
  });

  test("returns null for an empty list", () => {
    expect(computeRotatedConversationId([], "a", "next")).toBeNull();
  });

  test("returns null when the current thread is not in the list", () => {
    expect(computeRotatedConversationId(ids, "z", "next")).toBeNull();
  });

  test("ignores duplicate ids when rotating", () => {
    // "a" appears twice (e.g. also pinned); rotating next from b should reach c,
    // not stall on a duplicate.
    expect(
      computeRotatedConversationId(["a", "b", "a", "c"], "c", "next"),
    ).toBe("a");
    expect(
      computeRotatedConversationId(["a", "b", "a", "c"], "a", "next"),
    ).toBe("b");
  });
});

describe("withCurrentConversation", () => {
  test("prepends the current id when it is missing", () => {
    expect(withCurrentConversation(["a", "b"], "default")).toEqual([
      "default",
      "a",
      "b",
    ]);
  });

  test("leaves the list untouched when the current id is present", () => {
    const list = ["a", "b", "c"];
    expect(withCurrentConversation(list, "b")).toBe(list);
  });

  test("rotation works after ensuring the current thread is included", () => {
    const list = withCurrentConversation(["a", "b"], "default");
    expect(computeRotatedConversationId(list, "default", "next")).toBe("a");
    expect(computeRotatedConversationId(list, "default", "prev")).toBe("b");
  });
});
