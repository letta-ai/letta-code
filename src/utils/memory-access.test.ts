import { expect, test } from "bun:test";
import { isMemoryAccessRefusal } from "./memory-access";

test("recognizes git authentication refusals without caching transient failures", () => {
  for (const message of [
    "fatal: The requested URL returned error: 401",
    "fatal: The requested URL returned error: 403",
    "fatal: Authentication failed for repository",
  ]) {
    expect(isMemoryAccessRefusal(new Error(message))).toBe(true);
  }
  expect(isMemoryAccessRefusal(new Error("HTTP 503"))).toBe(false);
  expect(isMemoryAccessRefusal(new Error("Connection timed out"))).toBe(false);
});
