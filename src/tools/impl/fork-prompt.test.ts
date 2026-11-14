import { expect, test } from "bun:test";
import { FORK_PROMPT_CHARACTER_LIMIT, validateForkPrompt } from "./fork-prompt";

test("the cap counts the assignment before any harness history is added", () => {
  const atLimit = "x".repeat(FORK_PROMPT_CHARACTER_LIMIT);
  expect(validateForkPrompt(atLimit, true)).toBeUndefined();
  expect(validateForkPrompt(`${atLimit}x`, true)).toContain("2001 characters");
  expect(validateForkPrompt(`${atLimit}x`, false)).toBeUndefined();
});
