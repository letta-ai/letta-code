import { describe, expect, test } from "bun:test";
import {
  validateConversationDefaultRequiresAgent,
  validateFlagConflicts,
  validateRegistryHandleOrThrow,
} from "../../cli/startupFlagValidation";

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
});
