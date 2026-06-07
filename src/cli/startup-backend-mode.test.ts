import { describe, expect, test } from "bun:test";
import {
  getStartupBackendLookupOrder,
  inferBackendModeFromAgentId,
  resolveSubcommandBackendMode,
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

  test("subcommands use saved backend mode when no stronger selector exists", () => {
    expect(
      resolveSubcommandBackendMode({
        savedBackendMode: "local",
        baseURL: "https://api.letta.com",
        cloudBaseURL: "https://api.letta.com",
      }),
    ).toBe("local");
    expect(
      resolveSubcommandBackendMode({
        savedBackendMode: "api",
        baseURL: "https://api.letta.com",
        cloudBaseURL: "https://api.letta.com",
      }),
    ).toBe("api");
  });

  test("explicit backend flag takes precedence over saved subcommand mode", () => {
    expect(
      resolveSubcommandBackendMode({
        explicitBackendMode: "api",
        savedBackendMode: "local",
        baseURL: "https://api.letta.com",
        cloudBaseURL: "https://api.letta.com",
      }),
    ).toBeUndefined();
  });

  test("local backend env takes precedence over saved API subcommand mode", () => {
    expect(
      resolveSubcommandBackendMode({
        envBackendMode: "local",
        savedBackendMode: "api",
        baseURL: "https://api.letta.com",
        cloudBaseURL: "https://api.letta.com",
      }),
    ).toBe("local");
  });

  test("custom API base URL blocks saved local subcommand mode", () => {
    expect(
      resolveSubcommandBackendMode({
        savedBackendMode: "local",
        baseURL: "http://localhost:8283",
        cloudBaseURL: "https://api.letta.com",
      }),
    ).toBeUndefined();
  });
});
