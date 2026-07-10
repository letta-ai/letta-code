import { describe, expect, test } from "bun:test";
import { looksLikeTruncatedStreamJson } from "./subagent-stream";

const initLine = JSON.stringify({
  type: "system",
  subtype: "init",
  agent_id: "agent-1",
});
const resultLine = JSON.stringify({
  type: "result",
  result: "done",
  is_error: false,
});

describe("looksLikeTruncatedStreamJson", () => {
  test("detects a result envelope cut mid-line", () => {
    const truncated = `${initLine}\n${resultLine.slice(0, resultLine.length - 25)}`;
    expect(looksLikeTruncatedStreamJson(truncated)).toBe(true);
  });

  test("detects a partial line even when it is the only output", () => {
    expect(looksLikeTruncatedStreamJson('{"type":"result","resu')).toBe(true);
  });

  test("does not flag a complete stream ending in a result envelope", () => {
    expect(looksLikeTruncatedStreamJson(`${initLine}\n${resultLine}\n`)).toBe(
      false,
    );
  });

  test("does not flag complete-but-unexpected JSON output", () => {
    // Last line parses fine — this is a wrong-shape stream, not truncation,
    // so retrying could double side effects for no reason.
    expect(looksLikeTruncatedStreamJson(`${initLine}\n`)).toBe(false);
  });

  test("does not flag empty output", () => {
    expect(looksLikeTruncatedStreamJson("")).toBe(false);
    expect(looksLikeTruncatedStreamJson("\n\n")).toBe(false);
  });

  test("handles CRLF line endings", () => {
    const truncated = `${initLine}\r\n${resultLine.slice(0, 10)}`;
    expect(looksLikeTruncatedStreamJson(truncated)).toBe(true);
    expect(
      looksLikeTruncatedStreamJson(`${initLine}\r\n${resultLine}\r\n`),
    ).toBe(false);
  });
});
