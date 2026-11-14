import { describe, expect, test } from "bun:test";
import { buildForkSystemReminder } from "./subagent-reminders";

describe("fork reminder", () => {
  test("the assignment selects the work while history supplies requirements", () => {
    const reminder = buildForkSystemReminder();
    expect(reminder).toContain(
      "The task in the user message below tells you what to do now",
    );
    expect(reminder).toContain(
      "use the inherited conversation history as the source for everything else",
    );
    expect(reminder).toContain(
      "If the task conflicts with what people said in the history, follow what people said in the history.",
    );
    expect(reminder).toContain(
      "Do not resume unrelated work from the history.",
    );
    expect(reminder).not.toContain("Your sole task is the one described");
  });
  test("recall retains its search-only role", () => {
    const reminder = buildForkSystemReminder("recall");
    expect(reminder).toContain(
      "Your sole task is now to search previous conversation history",
    );
    expect(reminder).toContain("You cannot edit files");
  });
});
