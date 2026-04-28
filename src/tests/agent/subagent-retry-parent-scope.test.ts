import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const managerSource = readFileSync(
  path.resolve(import.meta.dir, "../../agent/subagents/manager.ts"),
  "utf8",
);

describe("executeSubagent provider fallback wiring", () => {
  test("forwards parentAgentIdOverride through the provider retry call", () => {
    const retryCallMatch = managerSource.match(
      /return executeSubagent\(\s*type,\s*config,\s*primaryModel,\s*userPrompt,\s*baseURL,\s*subagentId,\s*true,\s*\/\/ Mark as retry to prevent infinite loops\s*signal,\s*undefined,\s*\/\/ existingAgentId\s*undefined,\s*\/\/ existingConversationId\s*maxTurns,\s*parentAgentIdOverride,\s*\);/s,
    );

    expect(retryCallMatch).toBeTruthy();
  });
});
