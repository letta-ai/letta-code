import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendJournalEntry, createExecutionDir } from "./journal.ts";

describe("execution journal", () => {
  test("persists script and args, and appends one line per outcome", () => {
    const root = mkdtempSync(join(tmpdir(), "workflow-journal-"));
    try {
      const { executionDir, scriptPath, journalPath } = createExecutionDir(
        root,
        "wf-test",
        "export const meta = {}",
        { files: ["a"] },
      );
      expect(executionDir).toBe(join(root, "wf-test"));
      expect(readFileSync(scriptPath, "utf8")).toBe("export const meta = {}");
      expect(
        JSON.parse(readFileSync(join(executionDir, "args.json"), "utf8")),
      ).toEqual({ files: ["a"] });
      appendJournalEntry(journalPath, {
        callIndex: 0,
        label: "a",
        prompt: "p",
        outcome: { value: "v", failed: false },
      });
      expect(readFileSync(journalPath, "utf8").trim().split("\n")).toHaveLength(
        1,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")(
    "creates run files owner-only regardless of umask",
    () => {
      const root = mkdtempSync(join(tmpdir(), "workflow-journal-mode-"));
      const previousUmask = process.umask(0o022);
      try {
        const { executionDir, scriptPath, journalPath } = createExecutionDir(
          root,
          "wf-mode",
          "x",
          { a: 1 },
        );
        appendJournalEntry(journalPath, {
          callIndex: 0,
          label: "a",
          prompt: "secret prompt",
          outcome: { value: "secret", failed: false },
        });
        const mode = (path: string) => statSync(path).mode & 0o777;
        expect(mode(executionDir)).toBe(0o700);
        expect(mode(scriptPath)).toBe(0o600);
        expect(mode(join(executionDir, "args.json"))).toBe(0o600);
        expect(mode(journalPath)).toBe(0o600);
      } finally {
        process.umask(previousUmask);
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
