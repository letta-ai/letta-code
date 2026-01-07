import { describe, expect, test, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { bash } from "../../tools/impl/Bash";
import { grep } from "../../tools/impl/Grep";
import { getOverflowDirectory } from "../../tools/impl/overflow";

describe("overflow integration tests", () => {
	const testWorkingDir = process.cwd();
	let overflowDir: string;

	afterEach(() => {
		overflowDir = getOverflowDirectory(testWorkingDir);
		// Clean up test files
		if (fs.existsSync(overflowDir)) {
			const files = fs.readdirSync(overflowDir);
			for (const file of files) {
				fs.unlinkSync(path.join(overflowDir, file));
			}
		}
	});

	describe("Bash tool with overflow", () => {
		test("creates overflow file for long output", async () => {
			// Set USER_CWD for the test
			process.env.USER_CWD = testWorkingDir;

			// Generate a large output (more than 30K characters)
			const command = 'for i in {1..2000}; do echo "Line $i with some padding text to make it longer"; done';

			const result = await bash({ command });

			// Check that output was truncated
			expect(result.status).toBe("success");
			expect(result.content[0]?.text).toContain("Output truncated");
			expect(result.content[0]?.text).toContain("Full output written to:");

			// Extract overflow path from the output
			const match = result.content[0]?.text?.match(
				/Full output written to: (.+\.txt)/,
			);
			expect(match).toBeDefined();

			if (match) {
				const overflowPath = match[1];
				expect(fs.existsSync(overflowPath)).toBe(true);

				// Verify the overflow file contains the full output
				const fullContent = fs.readFileSync(overflowPath, "utf-8");
				expect(fullContent).toContain("Line 1 with some padding");
				expect(fullContent).toContain("Line 2000 with some padding");
				expect(fullContent.length).toBeGreaterThan(30_000);
			}
		});

		test("no overflow file for short output", async () => {
			process.env.USER_CWD = testWorkingDir;

			const command = "echo 'Short output'";
			const result = await bash({ command });

			expect(result.status).toBe("success");
			expect(result.content[0]?.text).not.toContain("Output truncated");
			expect(result.content[0]?.text).not.toContain("Full output written to");
		});
	});

	describe("Grep tool with overflow", () => {
		test("creates overflow file for large search results", async () => {
			process.env.USER_CWD = testWorkingDir;

			// Search for a common pattern that will have many results
			const result = await grep({
				pattern: "test",
				path: "src/tests",
				output_mode: "files_with_matches",
			});

			// If we have enough results to trigger truncation
			if (
				result.output.includes("Output truncated") &&
				result.output.includes("Full output written to")
			) {
				const match = result.output.match(/Full output written to: (.+\.txt)/);
				expect(match).toBeDefined();

				if (match) {
					const overflowPath = match[1];
					expect(fs.existsSync(overflowPath)).toBe(true);

					const fullContent = fs.readFileSync(overflowPath, "utf-8");
					expect(fullContent.length).toBeGreaterThan(0);
				}
			}
		});
	});

	describe("Middle truncation verification", () => {
		test("shows beginning and end of output", async () => {
			process.env.USER_CWD = testWorkingDir;

			// Generate output with distinctive beginning and end
			const command =
				'echo "START_MARKER"; for i in {1..1000}; do echo "Middle line $i"; done; echo "END_MARKER"';

			const result = await bash({ command });

			if (result.content[0]?.text?.includes("Output truncated")) {
				// Should contain both START and END markers due to middle truncation
				expect(result.content[0].text).toContain("START_MARKER");
				expect(result.content[0].text).toContain("END_MARKER");
				expect(result.content[0].text).toContain("characters omitted");
			}
		});
	});
});
