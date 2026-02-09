import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("subagent max_steps error propagation", () => {
  test("non-zero exit path prefers parsed finalError over generic exit code", () => {
    const managerPath = fileURLToPath(
      new URL("../../agent/subagents/manager.ts", import.meta.url),
    );
    const source = readFileSync(managerPath, "utf-8");

    expect(source).toContain(
      "const propagatedError = state.finalError?.trim();",
    );
    expect(source).toContain(
      `const fallbackError = stderr || \`Subagent exited with code \${exitCode}\`;`,
    );
    expect(source).toContain("error: propagatedError || fallbackError");
  });
});
