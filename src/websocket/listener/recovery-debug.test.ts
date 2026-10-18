import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { debugLogApprovalResumeState } from "./recovery";

const originalDebug = process.env.DEBUG;
const originalLettaDebug = process.env.LETTA_DEBUG;

afterEach(() => {
  if (originalDebug === undefined) delete process.env.DEBUG;
  else process.env.DEBUG = originalDebug;
  if (originalLettaDebug === undefined) delete process.env.LETTA_DEBUG;
  else process.env.LETTA_DEBUG = originalLettaDebug;
});

describe("approval recovery debug output", () => {
  test.each(["0", "false", "letta:*"])(
    "does not inspect or print recovery state for DEBUG=%s",
    async (value) => {
      process.env.DEBUG = value;
      delete process.env.LETTA_DEBUG;
      const log = spyOn(console, "log").mockImplementation(() => {});
      const warn = spyOn(console, "warn").mockImplementation(() => {});

      try {
        await debugLogApprovalResumeState({} as never, {
          agentId: "agent-secret",
          conversationId: "conversation-secret",
          expectedToolCallIds: ["expected-secret"],
          sentToolCallIds: ["sent-secret"],
        });

        expect(log).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
      } finally {
        log.mockRestore();
        warn.mockRestore();
      }
    },
  );
});
