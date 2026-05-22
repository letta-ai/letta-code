import { describe, expect, test } from "bun:test";
import { inferBackendModeFromAgentId } from "@/cli/startup-backend-mode";

describe("startup backend mode inference", () => {
  test("local agent IDs use the local backend", () => {
    expect(inferBackendModeFromAgentId("agent-local-abc")).toBe("local");
  });

  test("cloud agent IDs use the API backend", () => {
    expect(inferBackendModeFromAgentId("agent-abc")).toBe("api");
  });

  test("missing agent IDs do not infer a backend", () => {
    expect(inferBackendModeFromAgentId(null)).toBeUndefined();
    expect(inferBackendModeFromAgentId(undefined)).toBeUndefined();
  });
});
