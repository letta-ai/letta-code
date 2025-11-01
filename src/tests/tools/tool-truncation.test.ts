import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bash } from "../../tools/impl/Bash";
import { bash_output } from "../../tools/impl/BashOutput";
import { glob } from "../../tools/impl/Glob";
import { grep } from "../../tools/impl/Grep";
import { ls } from "../../tools/impl/LS";
import { read } from "../../tools/impl/Read";
import { LIMITS } from "../../tools/impl/truncation";

describe("tool truncation integration tests", () => {
  let testDir: string;

  beforeEach(async () => {
    // Create a temporary directory for tests
    testDir = await mkdtemp(join(tmpdir(), "letta-test-"));
    process.env.USER_CWD = testDir;
  });

  afterEach(async () => {
    // Clean up
    await rm(testDir, { recursive: true, force: true });
  });

  describe("Bash tool truncation", () => {
    test("truncates output exceeding 30K characters", async () => {
      // Generate output larger than 30K chars
      const result = await bash({
        command: `echo "${Array.from({ length: 1000 }, () => "x".repeat(50)).join("\\n")}"`,
      });

      const output = result.content[0]?.text || "";
      expect(output).toContain("[Output truncated after 30,000 characters");
      expect(output.length).toBeLessThan(35000); // Truncated + notice
    });

    test("does not truncate small output", async () => {
      const result = await bash({ command: "echo 'Hello, world!'" });

      const output = result.content[0]?.text || "";
      expect(output).toContain("Hello, world!");
      expect(output).not.toContain("truncated");
    });

    test("truncates error output", async () => {
      // Generate large error output
      const largeString = "e".repeat(40000);
      const result = await bash({
        command: `>&2 echo "${largeString}" && exit 1`,
      });

      const output = result.content[0]?.text || "";
      expect(output).toContain("[Output truncated after 30,000 characters");
      expect(result.isError).toBe(true);
    });
  });

  describe("Read tool truncation", () => {
    test("truncates file exceeding 2000 lines", async () => {
      const filePath = join(testDir, "large-file.txt");
      const lines = Array.from({ length: 3000 }, (_, i) => `Line ${i + 1}`);
      await writeFile(filePath, lines.join("\n"));

      const result = await read({ file_path: filePath });

      expect(result.content).toContain("Line 1");
      expect(result.content).toContain("Line 2000");
      expect(result.content).not.toContain("Line 2001");
      expect(result.content).toContain("showing lines 1-2000 of 3000 total");
    });

    test("truncates lines exceeding 2000 characters", async () => {
      const filePath = join(testDir, "long-lines.txt");
      const content = `short line\n${"a".repeat(3000)}\nshort line`;
      await writeFile(filePath, content);

      const result = await read({ file_path: filePath });

      expect(result.content).toContain("short line");
      expect(result.content).toContain("a".repeat(2000));
      expect(result.content).not.toContain("a".repeat(2001));
      expect(result.content).toContain("... [line truncated]");
      expect(result.content).toContain(
        "Some lines exceeded 2,000 characters and were truncated",
      );
    });

    test("respects user-specified limit parameter", async () => {
      const filePath = join(testDir, "file.txt");
      const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
      await writeFile(filePath, lines.join("\n"));

      const result = await read({ file_path: filePath, limit: 50 });

      expect(result.content).toContain("Line 1");
      expect(result.content).toContain("Line 50");
      expect(result.content).not.toContain("Line 51");
      // Should not show truncation notice when user explicitly set limit
      expect(result.content).not.toContain("File truncated");
    });

    test("does not truncate small files", async () => {
      const filePath = join(testDir, "small.txt");
      await writeFile(filePath, "Hello\nWorld\n");

      const result = await read({ file_path: filePath });

      expect(result.content).toContain("Hello");
      expect(result.content).toContain("World");
      expect(result.content).not.toContain("truncated");
    });
  });

  describe("Grep tool truncation", () => {
    beforeEach(async () => {
      // Create test files for grep
      for (let i = 1; i <= 100; i++) {
        await writeFile(join(testDir, `file${i}.txt`), `match\n`.repeat(100));
      }
    });

    test("truncates content output exceeding 10K characters", async () => {
      const result = await grep({
        pattern: "match",
        path: testDir,
        output_mode: "content",
      });

      expect(result.output.length).toBeLessThanOrEqual(15000); // 10K + notice
      expect(result.output).toContain(
        "[Output truncated after 10,000 characters",
      );
    });

    test("truncates file list exceeding 10K characters", async () => {
      // Create files with long paths
      for (let i = 1; i <= 1000; i++) {
        await writeFile(
          join(testDir, `very-long-filename-to-make-output-large-${i}.txt`),
          "match",
        );
      }

      const result = await grep({
        pattern: "match",
        path: testDir,
        output_mode: "files_with_matches",
      });

      expect(result.output.length).toBeLessThanOrEqual(15000);
      if (result.output.length > 10000) {
        expect(result.output).toContain(
          "[Output truncated after 10,000 characters",
        );
      }
    });

    test("does not truncate small results", async () => {
      await writeFile(join(testDir, "single.txt"), "match\n");

      const result = await grep({
        pattern: "match",
        path: join(testDir, "single.txt"),
        output_mode: "content",
      });

      expect(result.output).toContain("match");
      expect(result.output).not.toContain("truncated");
    });
  });

  describe("Glob tool truncation", () => {
    test("truncates file list exceeding 2000 files", async () => {
      // Create 2500 files
      for (let i = 1; i <= 2500; i++) {
        await writeFile(join(testDir, `file${i}.txt`), "content");
      }

      const result = await glob({ pattern: "**/*.txt", path: testDir });

      expect(result.files.length).toBeLessThanOrEqual(
        LIMITS.GLOB_MAX_FILES + 1,
      ); // +1 for notice
      expect(result.truncated).toBe(true);
      expect(result.totalFiles).toBe(2500);
      // Last entry should be the truncation notice
      expect(result.files[result.files.length - 1]).toContain(
        "showing 2,000 of 2,500 files",
      );
    });

    test("does not truncate when under limit", async () => {
      // Create 10 files
      for (let i = 1; i <= 10; i++) {
        await writeFile(join(testDir, `file${i}.txt`), "content");
      }

      const result = await glob({ pattern: "**/*.txt", path: testDir });

      expect(result.files.length).toBe(10);
      expect(result.truncated).toBeUndefined();
      expect(result.totalFiles).toBeUndefined();
    });
  });

  describe("LS tool truncation", () => {
    test("truncates directory exceeding 1000 entries", async () => {
      // Create 1500 files
      for (let i = 1; i <= 1500; i++) {
        await writeFile(join(testDir, `file${i}.txt`), "content");
      }

      const result = await ls({ path: testDir });

      const output = result.content[0]?.text || "";
      expect(output).toContain("[Output truncated");
      expect(output).toContain("showing 1,000 of 1,500 entries");
      expect(output).toContain("file1.txt");
      // Should not contain files beyond 1000
      const lines = output.split("\n");
      // Count actual file entries (excluding headers and notices)
      const fileEntries = lines.filter((line) => line.match(/^\s+- file/));
      expect(fileEntries.length).toBeLessThanOrEqual(LIMITS.LS_MAX_ENTRIES);
    });

    test("does not truncate small directories", async () => {
      // Create 5 files
      for (let i = 1; i <= 5; i++) {
        await writeFile(join(testDir, `file${i}.txt`), "content");
      }

      const result = await ls({ path: testDir });

      const output = result.content[0]?.text || "";
      expect(output).not.toContain("truncated");
      expect(output).toContain("file1.txt");
      expect(output).toContain("file5.txt");
    });
  });

  describe("BashOutput tool truncation", () => {
    test("truncates accumulated output exceeding 30K characters", async () => {
      // Start a background process that generates lots of output
      const startResult = await bash({
        command: `for i in {1..1000}; do echo "$(printf 'x%.0s' {1..100})"; done`,
        run_in_background: true,
      });

      const message = startResult.content[0]?.text || "";
      const bashIdMatch = message.match(/with ID: (.+)/);
      expect(bashIdMatch).toBeTruthy();
      const bashId = bashIdMatch![1];

      // Wait a bit for output to accumulate
      await new Promise((resolve) => setTimeout(resolve, 100));

      const outputResult = await bash_output({ bash_id: bashId });

      expect(outputResult.message.length).toBeLessThan(35000); // 30K + notice
      if (outputResult.message.length > 30000) {
        expect(outputResult.message).toContain(
          "[Output truncated after 30,000 characters",
        );
      }
    });
  });
});
