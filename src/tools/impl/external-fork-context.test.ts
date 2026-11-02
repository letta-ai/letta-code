import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Backend } from "@/backend";
import {
  LOCAL_INLINE_TOKEN_LIMIT,
  PARENT_TRANSCRIPT_DIR,
  prependParentContext,
} from "./external-fork-context";

function fakeBackend(messages: Array<Record<string, unknown>>) {
  return {
    listConversationMessages: async () => ({
      getPaginatedItems: () =>
        messages.map((m, i) => ({ id: `m${i}`, date: "", ...m })),
    }),
  } as unknown as Pick<Backend, "listConversationMessages">;
}

const conversation = [
  { message_type: "user_message", content: "Use Postgres, not SQLite." },
  { message_type: "assistant_message", content: "Noted: Postgres." },
  { message_type: "user_message", content: "Now migrate the schema." },
];
const base = {
  prompt: "Write the migration.",
  parentAgentId: "agent-parent",
  parentConversationId: "conv-parent",
};

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "external-fork-context-"));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("prependParentContext", () => {
  test("writes the full transcript into a self-ignoring dir and points the worker at it", async () => {
    const result = await prependParentContext({
      ...base,
      cwd,
      backend: fakeBackend(conversation),
    });
    if ("error" in result) throw new Error(result.error);

    const path = result.transcriptPath as string;
    expect(dirname(path)).toBe(join(cwd, PARENT_TRANSCRIPT_DIR));
    expect(readFileSync(join(dirname(path), ".gitignore"), "utf8")).toBe("*\n");
    const file = readFileSync(path, "utf8");
    expect(file).toContain("Use Postgres, not SQLite.");
    expect(file).toContain("Now migrate the schema.");

    expect(result.prompt).toContain(`is at:\n${path}\n`);
    expect(result.prompt).toContain("Most recent turns (2 of 2):");
    expect(result.prompt).toEndWith("Task:\nWrite the migration.");
  });

  test("caps what is inlined but keeps the whole conversation in the file", async () => {
    const big = "x".repeat(LOCAL_INLINE_TOKEN_LIMIT * 4);
    const result = await prependParentContext({
      ...base,
      cwd,
      backend: fakeBackend([
        { message_type: "user_message", content: `OLDEST ${big}` },
        { message_type: "user_message", content: "LATEST" },
      ]),
    });
    if ("error" in result) throw new Error(result.error);

    expect(result.prompt).toContain("Most recent turns (1 of 2):");
    expect(result.prompt).toContain("LATEST");
    expect(result.prompt).not.toContain("OLDEST");
    expect(readFileSync(result.transcriptPath as string, "utf8")).toContain(
      "OLDEST",
    );
  });

  test("a remote worker gets the transcript inline and no file", async () => {
    const result = await prependParentContext({
      ...base,
      backend: fakeBackend(conversation),
    });
    if ("error" in result) throw new Error(result.error);

    expect(result.transcriptPath).toBeUndefined();
    expect(result.prompt).toContain("Use Postgres, not SQLite.");
    expect(result.prompt).toContain("Its full transcript is below.");
  });

  test("an empty conversation leaves the prompt unchanged", async () => {
    const result = await prependParentContext({
      ...base,
      cwd,
      backend: fakeBackend([]),
    });

    expect(result).toEqual({ prompt: "Write the migration." });
  });

  test("a failed read is reported, not swallowed", async () => {
    const result = await prependParentContext({
      ...base,
      cwd,
      backend: {
        listConversationMessages: async () => {
          throw new Error("503");
        },
      } as unknown as Pick<Backend, "listConversationMessages">,
    });

    expect(result).toEqual({
      error: "Failed to read the parent conversation: 503",
    });
  });
});
