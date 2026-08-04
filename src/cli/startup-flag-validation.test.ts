import { describe, expect, test } from "bun:test";
import {
  validateConversationDefaultRequiresAgent,
  validateFlagConflicts,
  validatePrimaryStartupFlagConflicts,
  validateRegistryHandleOrThrow,
  validateStatelessStartupOptions,
} from "@/cli/startup-flag-validation";

describe("startup flag validation helpers", () => {
  test("conversation default requires agent unless new-agent is set", () => {
    expect(() =>
      validateConversationDefaultRequiresAgent({
        specifiedConversationId: "default",
        specifiedAgentId: null,
        forceNew: false,
      }),
    ).toThrow("--conv default requires --agent <agent-id>");

    expect(() =>
      validateConversationDefaultRequiresAgent({
        specifiedConversationId: "default",
        specifiedAgentId: "agent-123",
        forceNew: false,
      }),
    ).not.toThrow();
  });

  test("conflict helpers throw the first matching conflict", () => {
    expect(() =>
      validateFlagConflicts({
        guard: true,
        checks: [
          { when: true, message: "conversation conflict" },
          { when: true, message: "should not hit second" },
        ],
      }),
    ).toThrow("conversation conflict");

    expect(() =>
      validateFlagConflicts({
        guard: true,
        checks: [{ when: true, message: "new conflict" }],
      }),
    ).toThrow("new conflict");

    expect(() =>
      validateFlagConflicts({
        guard: "@author/agent",
        checks: [{ when: true, message: "import conflict" }],
      }),
    ).toThrow("import conflict");
  });

  test("registry handle validator accepts valid handles and rejects invalid ones", () => {
    expect(() => validateRegistryHandleOrThrow("@author/agent")).not.toThrow();
    expect(() => validateRegistryHandleOrThrow("author/agent")).not.toThrow();
    expect(() => validateRegistryHandleOrThrow("@author")).toThrow(
      'Invalid registry handle "@author"',
    );
  });

  test("stateless startup requires an existing agent in headless mode", () => {
    const baseOptions = {
      stateless: true,
      isHeadless: true,
      memfs: false,
      memfsStartup: undefined,
      forceNewAgent: false,
      hasExistingAgentSelector: true,
    };

    expect(() => validateStatelessStartupOptions(baseOptions)).not.toThrow();
    expect(() =>
      validateStatelessStartupOptions({
        ...baseOptions,
        isHeadless: false,
      }),
    ).toThrow("--stateless is only supported in headless mode");
    expect(() =>
      validateStatelessStartupOptions({ ...baseOptions, memfs: true }),
    ).toThrow("--stateless cannot be used with --memfs");
    expect(() =>
      validateStatelessStartupOptions({
        ...baseOptions,
        memfsStartup: "skip",
      }),
    ).toThrow("--stateless cannot be used with --memfs-startup");
    expect(() =>
      validateStatelessStartupOptions({
        ...baseOptions,
        forceNewAgent: true,
      }),
    ).toThrow("--stateless is for existing agents");
    expect(() =>
      validateStatelessStartupOptions({
        ...baseOptions,
        hasExistingAgentSelector: false,
      }),
    ).toThrow("--stateless requires --agent");
  });

  test("primary startup validation preserves conversation conflict behavior", () => {
    expect(() =>
      validatePrimaryStartupFlagConflicts({
        specifiedConversationId: "conv-123",
        specifiedAgentId: "agent-123",
        specifiedAgentName: null,
        forceNewAgent: false,
        forceNewConversation: false,
        importFile: null,
        stateless: false,
        isHeadless: true,
        memfs: false,
        memfsStartup: undefined,
      }),
    ).toThrow("--conversation cannot be used with --agent");
  });
});
