import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const managerSource = readFileSync(
  path.resolve(import.meta.dir, "./subagents/manager.ts"),
  "utf8",
);

describe("executeSubagent provider fallback wiring", () => {
  test("forwards parentAgentIdOverride through the provider retry call", () => {
    const retryCallMatch = managerSource.match(
      /return executeSubagent\(\s*type,\s*config,\s*primaryModel,\s*userPrompt,\s*subagentId,\s*true,\s*\/\/ Mark as retry to prevent infinite loops\s*signal,\s*undefined,\s*\/\/ existingAgentId\s*undefined,\s*\/\/ existingConversationId\s*maxTurns,\s*parentAgentIdOverride,\s*transcriptPath,\s*\);/s,
    );

    expect(retryCallMatch).toBeTruthy();
  });
});

describe("executeSubagent lost-output retry wiring", () => {
  const retryCallPattern =
    /return executeSubagent\(\s*type,\s*config,\s*model,\s*userPrompt,\s*subagentId,\s*true,\s*\/\/ Mark as retry to prevent infinite loops\s*signal,\s*existingAgentId,\s*existingConversationId,\s*maxTurns,\s*parentAgentIdOverride,\s*transcriptPath,\s*memoryScope,\s*systemPromptOverride,\s*\);/gs;

  test("retries once with the original payload when the child reports lost stdout or its output looks truncated", () => {
    const retryCalls = managerSource.match(retryCallPattern);

    // One retry site for the stderr lost-stdout marker (non-zero exit) and
    // one for a clean exit whose stdout ends mid-line without a result.
    expect(retryCalls).toHaveLength(2);
  });

  test("both lost-output retries are guarded by isRetry", () => {
    const guardedSites = managerSource.match(
      /if \(!isRetry && isSubagentStdoutLostError\(stderr\)\)|if \(!isRetry && looksLikeTruncatedStreamJson\(stdout\)\)/gs,
    );

    expect(guardedSites).toHaveLength(2);
  });
});
