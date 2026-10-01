import { describe, expect, test } from "bun:test";
import { parseReflectCommandArgs } from "./reflect-command";

describe.each(["dream", "reflect", "reflection"])("/%s arguments", (alias) => {
  test("preserves existing Code-managed modes and instructions", () => {
    expect(parseReflectCommandArgs(`/${alias}`)).toEqual({ kind: "single" });
    expect(
      parseReflectCommandArgs(
        `/${alias} --recent 2 --instruction "remember this"`,
      ),
    ).toEqual({ kind: "recent", limit: 2, instruction: "remember this" });
    expect(
      parseReflectCommandArgs(
        `/${alias} --conversation conv-a --conversation conv-b`,
      ),
    ).toEqual({
      kind: "conversations",
      conversationIds: ["conv-a", "conv-b"],
      instruction: undefined,
    });
    expect(
      parseReflectCommandArgs(`/${alias} --auto -- focus on tools`),
    ).toEqual({ kind: "auto", instruction: "focus on tools" });
    expect(parseReflectCommandArgs(`/${alias} -i remember this`)).toEqual({
      kind: "single",
      instruction: "remember this",
    });
  });
  test("rejects incompatible or unsupported arguments", () => {
    for (const args of [
      "--auto --recent 2",
      "--instruction",
      "--recent 0",
      "transcript.txt",
      "--unknown",
    ]) {
      expect(() => parseReflectCommandArgs(`/${alias} ${args}`)).toThrow();
    }
  });
});
