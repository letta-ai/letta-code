import { describe, expect, test } from "bun:test";
import {
  getStartupBackendLookupOrder,
  inferBackendModeFromAgentId,
} from "@/cli/startup-backend-mode";

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

  test("lookup order tries the active backend first", () => {
    expect(getStartupBackendLookupOrder("local")).toEqual(["local", "api"]);
    expect(getStartupBackendLookupOrder("api")).toEqual(["api", "local"]);
  });

  test("explicit backend mode disables fallback", () => {
    expect(getStartupBackendLookupOrder("local", "api")).toEqual(["api"]);
    expect(getStartupBackendLookupOrder("api", "local")).toEqual(["local"]);
  });
});
