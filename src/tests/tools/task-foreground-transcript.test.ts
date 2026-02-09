import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("Task foreground transcript wiring", () => {
  test("writes foreground transcript start and result output", () => {
    const taskPath = fileURLToPath(
      new URL("../../tools/impl/Task.ts", import.meta.url),
    );
    const source = readFileSync(taskPath, "utf-8");

    expect(source).toContain("const foregroundTaskId = getNextTaskId();");
    expect(source).toContain(
      "const outputFile = createBackgroundOutputFile(foregroundTaskId);",
    );
    expect(source).toContain(
      "writeTaskTranscriptStart(outputFile, description, subagent_type);",
    );
    expect(source).toContain(
      "writeTaskTranscriptResult(outputFile, result, header);",
    );
    expect(source).toContain(
      `return \`\${truncatedOutput}\\nOutput file: \${outputFile}\`;`,
    );
    expect(source).toContain(
      `return \`Error: \${errorMessage}\\nOutput file: \${outputFile}\`;`,
    );
  });
});
