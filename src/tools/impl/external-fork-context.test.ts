import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Backend } from "@/backend";
import {
  INLINE_CHARACTER_LIMIT,
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
  test("writes older messages into a self-ignoring dir on the execution host", async () => {
    const older = `OLDER ${"x".repeat(INLINE_CHARACTER_LIMIT)}`;
    const result = await prependParentContext({
      ...base,
      cwd,
      backend: fakeBackend([
        { message_type: "user_message", content: older },
        ...conversation,
      ]),
    });
    if ("error" in result) throw new Error(result.error);

    const path = result.transcriptPath as string;
    expect(dirname(path)).toBe(join(cwd, PARENT_TRANSCRIPT_DIR));
    expect(readFileSync(join(dirname(path), ".gitignore"), "utf8")).toBe("*\n");
    const file = readFileSync(path, "utf8");
    expect(file).toContain(older);
    expect(file).not.toContain("Now migrate the schema.");

    expect(result.prompt).toContain(`available at:\n${path}\n`);
    expect(result.prompt).toContain("Most recent messages (3 of 4):");
    expect(result.prompt).toEndWith("Task:\nWrite the migration.");
  });

  test("caps inline history at 50k characters and preserves the remainder", async () => {
    const big = "x".repeat(INLINE_CHARACTER_LIMIT);
    const result = await prependParentContext({
      ...base,
      cwd,
      backend: fakeBackend([
        { message_type: "user_message", content: `OLDEST ${big}` },
        { message_type: "user_message", content: "LATEST" },
      ]),
    });
    if ("error" in result) throw new Error(result.error);

    expect(result.prompt).toContain("Most recent messages (1 of 2):");
    expect(result.prompt).toContain("LATEST");
    expect(result.prompt).not.toContain("OLDEST");
    expect(readFileSync(result.transcriptPath as string, "utf8")).toContain(
      "OLDEST",
    );
  });

  test("history that fits is entirely inline with no unnecessary file", async () => {
    const result = await prependParentContext({
      ...base,
      cwd,
      backend: fakeBackend(conversation),
    });
    if ("error" in result) throw new Error(result.error);

    expect(result.transcriptPath).toBeUndefined();
    expect(result.prompt).toContain("Use Postgres, not SQLite.");
    expect(result.prompt).toContain(
      "All supported messages from the parent conversation are included below.",
    );
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

  test("a destination file failure prevents launch rather than dropping history", async () => {
    const blocked = join(cwd, "not-a-directory");
    writeFileSync(blocked, "file");
    const result = await prependParentContext({
      ...base,
      cwd: blocked,
      backend: fakeBackend([
        {
          message_type: "user_message",
          content: "x".repeat(INLINE_CHARACTER_LIMIT + 1),
        },
      ]),
    });
    expect("error" in result && result.error).toContain(
      "Failed to write parent history:",
    );
  });
});
