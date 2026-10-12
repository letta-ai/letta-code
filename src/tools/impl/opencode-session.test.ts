import { expect, test } from "bun:test";
import {
  parseExternalCodingAgentId,
  runExternalCodingAgent,
} from "./external-coding-agent";
import { parseOpenCodeModel } from "./opencode-session";

test("OpenCode models preserve provider-qualified model names", () => {
  expect(parseOpenCodeModel()).toBeUndefined();
  expect(parseOpenCodeModel("openrouter/anthropic/claude-sonnet-4")).toEqual({
    providerID: "openrouter",
    modelID: "anthropic/claude-sonnet-4",
  });
  for (const invalid of ["sonnet", "/model", "provider/"]) {
    expect(() => parseOpenCodeModel(invalid)).toThrow("provider/model");
  }
});

test("OpenCode synthetic IDs accept native sessions but reject path injection", () => {
  expect(parseExternalCodingAgentId("opencode_ses_abc123ABC")).toEqual({
    type: "opencode",
    sessionId: "ses_abc123ABC",
  });
  for (const invalid of [
    "opencode_abc",
    "opencode_ses_",
    "opencode_ses_a/abort",
    "opencode_ses_a?x=y",
  ]) {
    expect(parseExternalCodingAgentId(invalid)).toBeNull();
  }
});

test("OpenCode cancellation and invalid model fail before starting a process", async () => {
  const options = {
    type: "opencode" as const,
    parentAgentId: "parent",
    prompt: "test",
  };
  const cancelled = await runExternalCodingAgent({
    ...options,
    signal: AbortSignal.abort(new Error("cancelled")),
  });
  expect(cancelled).toMatchObject({ success: false, error: "cancelled" });
  const invalid = await runExternalCodingAgent({
    ...options,
    model: "unqualified",
  });
  expect(invalid.success).toBe(false);
  expect(invalid.error).toContain("provider/model");
});

test("a missing OpenCode executable is a concrete startup failure", async () => {
  const result = await runExternalCodingAgent(
    { type: "opencode", parentAgentId: "parent", prompt: "test" },
    { env: { PATH: "" } },
  );
  expect(result.success).toBe(false);
  expect(result.error).toBe(
    "Required executable 'opencode' was not found on PATH",
  );
});
