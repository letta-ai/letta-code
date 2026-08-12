import { describe, expect, test } from "bun:test";
import {
  validateConversationDefaultRequiresAgent,
  validateFlagConflicts,
  validatePrimaryStartupFlagConflicts,
  validateRegistryHandleOrThrow,
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
      specifiedConversationId: null,
      specifiedAgentId: "agent-123",
      specifiedAgentName: null,
      forceNewConversation: false,
      importFile: null,
      stateless: true,
      isHeadless: true,
      memfs: false,
      memfsStartup: undefined,
      forceNewAgent: false,
    };

    expect(() =>
      validatePrimaryStartupFlagConflicts(baseOptions),
    ).not.toThrow();
    expect(() =>
      validatePrimaryStartupFlagConflicts({
        ...baseOptions,
        isHeadless: false,
      }),
    ).toThrow("--stateless is only supported in headless mode");
    expect(() =>
      validatePrimaryStartupFlagConflicts({ ...baseOptions, memfs: true }),
    ).toThrow("--stateless cannot be used with --memfs");
    expect(() =>
      validatePrimaryStartupFlagConflicts({
        ...baseOptions,
        memfsStartup: "skip",
      }),
    ).toThrow("--stateless cannot be used with --memfs-startup");
    expect(() =>
      validatePrimaryStartupFlagConflicts({
        ...baseOptions,
        forceNewAgent: true,
      }),
    ).toThrow("--stateless is for existing agents");
    expect(() =>
      validatePrimaryStartupFlagConflicts({
        ...baseOptions,
        specifiedAgentId: null,
      }),
    ).toThrow("--stateless requires --agent");
  });

  test("ephemeral startup rejects agent-backed and memory-backed modes", () => {
    const baseOptions = {
      specifiedConversationId: null,
      specifiedAgentId: null,
      specifiedAgentName: null,
      forceNewAgent: false,
      forceNewConversation: false,
      importFile: null,
      stateless: false,
      ephemeral: true,
      isHeadless: true,
      memfs: false,
      memfsStartup: undefined,
    };

    expect(() =>
      validatePrimaryStartupFlagConflicts(baseOptions),
    ).not.toThrow();
    expect(() =>
      validatePrimaryStartupFlagConflicts({
        ...baseOptions,
        specifiedAgentId: "agent-123",
      }),
    ).toThrow("--ephemeral cannot be used with --agent");
    expect(() =>
      validatePrimaryStartupFlagConflicts({ ...baseOptions, memfs: true }),
    ).toThrow("--ephemeral cannot be used with --stateless, --memfs");
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
