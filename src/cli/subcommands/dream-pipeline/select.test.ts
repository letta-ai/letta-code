import { describe, expect, test } from "bun:test";
import { parseDreamSourceSpec } from "./select";

describe("parseDreamSourceSpec", () => {
  test("bare conversation id is not a pipeline source", () => {
    expect(parseDreamSourceSpec("default")).toBeNull();
    expect(
      parseDreamSourceSpec("6b3a2c9e-0000-0000-0000-000000000000"),
    ).toBeNull();
  });

  test("bare harness name selects the whole store", () => {
    expect(parseDreamSourceSpec("claude")).toEqual({ type: "claude" });
    expect(parseDreamSourceSpec("codex")).toEqual({ type: "codex" });
  });

  test("typed spec carries its locator", () => {
    expect(parseDreamSourceSpec("openhands:/tmp/conv")).toEqual({
      type: "openhands",
      locator: "/tmp/conv",
    });
    expect(parseDreamSourceSpec("transcript:./rows")).toEqual({
      type: "transcript",
      locator: "./rows",
    });
  });

  test("typed spec with empty locator selects the whole store", () => {
    expect(parseDreamSourceSpec("claude:")).toEqual({ type: "claude" });
  });

  test("locators containing colons keep everything after the first", () => {
    expect(parseDreamSourceSpec("claude:C:/Users/x/session.jsonl")).toEqual({
      type: "claude",
      locator: "C:/Users/x/session.jsonl",
    });
  });

  test("unknown typed source throws with supported list", () => {
    expect(() => parseDreamSourceSpec("cursor:/tmp/x")).toThrow(
      /Unknown source type "cursor"/,
    );
  });
});
