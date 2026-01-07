import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	truncateByChars,
	truncateByLines,
	truncateArray,
	LIMITS,
} from "../../tools/impl/truncation";
import { getOverflowDirectory } from "../../tools/impl/overflow";

describe("truncation with overflow support", () => {
	const testWorkingDir = "/test/truncation/path";
	let overflowDir: string;

	beforeEach(() => {
		overflowDir = getOverflowDirectory(testWorkingDir);
	});

	afterEach(() => {
		// Clean up test files
		if (fs.existsSync(overflowDir)) {
			const files = fs.readdirSync(overflowDir);
			for (const file of files) {
				fs.unlinkSync(path.join(overflowDir, file));
			}
		}
	});

	describe("truncateByChars with overflow", () => {
		test("writes overflow file when content exceeds limit", () => {
			const longText = "a".repeat(2000);
			const result = truncateByChars(longText, 1000, "TestTool", {
				workingDirectory: testWorkingDir,
				toolName: "TestTool",
			});

			expect(result.wasTruncated).toBe(true);
			expect(result.overflowPath).toBeDefined();

			if (result.overflowPath) {
				expect(fs.existsSync(result.overflowPath)).toBe(true);
				expect(fs.readFileSync(result.overflowPath, "utf-8")).toBe(longText);
			}
		});

		test("includes overflow path in truncation notice", () => {
			const longText = "x".repeat(2000);
			const result = truncateByChars(longText, 1000, "TestTool", {
				workingDirectory: testWorkingDir,
				toolName: "TestTool",
			});

			expect(result.content).toContain("Full output written to:");
			expect(result.content).toContain(result.overflowPath || "");
		});

		test("uses middle truncation when enabled", () => {
			const text = "a".repeat(500) + "MIDDLE" + "b".repeat(500);
			const result = truncateByChars(text, 600, "TestTool", {
				workingDirectory: testWorkingDir,
				useMiddleTruncation: true,
			});

			expect(result.wasTruncated).toBe(true);
			expect(result.content).toContain("a".repeat(300)); // beginning
			expect(result.content).toContain("b".repeat(300)); // end
			expect(result.content).toContain("characters omitted");
			// "MIDDLE" should be omitted
			expect(result.content.split("[")[0]).not.toContain("MIDDLE");
		});

		test("uses post truncation when middle truncation disabled", () => {
			const text = "a".repeat(500) + "END";
			const result = truncateByChars(text, 300, "TestTool", {
				workingDirectory: testWorkingDir,
				useMiddleTruncation: false,
			});

			expect(result.wasTruncated).toBe(true);
			expect(result.content).toContain("a".repeat(300));
			expect(result.content.split("[")[0]).not.toContain("END");
		});

		test("does not create overflow file when under limit", () => {
			const shortText = "short text";
			const result = truncateByChars(shortText, 1000, "TestTool", {
				workingDirectory: testWorkingDir,
				toolName: "TestTool",
			});

			expect(result.wasTruncated).toBe(false);
			expect(result.overflowPath).toBeUndefined();
		});
	});

	describe("truncateByLines with overflow", () => {
		test("writes overflow file when lines exceed limit", () => {
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			const text = lines.join("\n");

			const result = truncateByLines(text, 50, undefined, "TestTool", {
				workingDirectory: testWorkingDir,
				toolName: "TestTool",
			});

			expect(result.wasTruncated).toBe(true);
			expect(result.overflowPath).toBeDefined();

			if (result.overflowPath) {
				expect(fs.existsSync(result.overflowPath)).toBe(true);
				expect(fs.readFileSync(result.overflowPath, "utf-8")).toBe(text);
			}
		});

		test("uses middle truncation for lines when enabled", () => {
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			const text = lines.join("\n");

			const result = truncateByLines(text, 50, undefined, "TestTool", {
				workingDirectory: testWorkingDir,
				useMiddleTruncation: true,
			});

			expect(result.wasTruncated).toBe(true);
			expect(result.content).toContain("Line 1"); // beginning
			expect(result.content).toContain("Line 25"); // end of first half
			expect(result.content).toContain("Line 76"); // beginning of second half
			expect(result.content).toContain("Line 100"); // end
			expect(result.content).toContain("lines omitted");
		});

		test("includes overflow path in truncation notice", () => {
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			const text = lines.join("\n");

			const result = truncateByLines(text, 50, undefined, "TestTool", {
				workingDirectory: testWorkingDir,
				toolName: "TestTool",
			});

			expect(result.content).toContain("Full output written to:");
			expect(result.content).toContain(result.overflowPath || "");
		});
	});

	describe("truncateArray with overflow", () => {
		test("writes overflow file when items exceed limit", () => {
			const items = Array.from({ length: 100 }, (_, i) => `item${i + 1}`);
			const formatter = (arr: string[]) => arr.join("\n");

			const result = truncateArray(
				items,
				50,
				formatter,
				"items",
				"TestTool",
				{
					workingDirectory: testWorkingDir,
					toolName: "TestTool",
				},
			);

			expect(result.wasTruncated).toBe(true);
			expect(result.overflowPath).toBeDefined();

			if (result.overflowPath) {
				expect(fs.existsSync(result.overflowPath)).toBe(true);
				const savedContent = fs.readFileSync(result.overflowPath, "utf-8");
				expect(savedContent).toContain("item1");
				expect(savedContent).toContain("item100");
			}
		});

		test("uses middle truncation for arrays when enabled", () => {
			const items = Array.from({ length: 100 }, (_, i) => `item${i + 1}`);
			const formatter = (arr: string[]) => arr.join("\n");

			const result = truncateArray(
				items,
				50,
				formatter,
				"items",
				"TestTool",
				{
					workingDirectory: testWorkingDir,
					useMiddleTruncation: true,
				},
			);

			expect(result.wasTruncated).toBe(true);
			expect(result.content).toContain("item1"); // beginning
			expect(result.content).toContain("item25"); // end of first half
			expect(result.content).toContain("item76"); // beginning of second half
			expect(result.content).toContain("item100"); // end
			expect(result.content).toContain("omitted from middle");
		});

		test("includes overflow path in truncation notice", () => {
			const items = Array.from({ length: 100 }, (_, i) => `item${i + 1}`);
			const formatter = (arr: string[]) => arr.join("\n");

			const result = truncateArray(
				items,
				50,
				formatter,
				"items",
				"TestTool",
				{
					workingDirectory: testWorkingDir,
					toolName: "TestTool",
				},
			);

			expect(result.content).toContain("Full output written to:");
			expect(result.content).toContain(result.overflowPath || "");
		});
	});
});
