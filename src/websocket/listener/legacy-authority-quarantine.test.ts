import { expect, test } from "bun:test";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import {
  ordinaryInputIdentity,
  rememberInputDisposition,
} from "./input-disposition";
import { seedLegacyAuthorityQuarantine } from "./input-disposition.test-helpers";
import { prepareInputTerminal } from "./input-terminal-journal";
import { createRuntime } from "./lifecycle";

test("legacy authority quarantine is isolated by conversation scope", () => {
  const listener = createRuntime();
  const quarantined = getOrCreateScopedRuntime(
    listener,
    "agent-0",
    "conversation-0",
  );
  seedLegacyAuthorityQuarantine(listener, quarantined);

  const other = getOrCreateScopedRuntime(
    listener,
    "agent-0",
    "conversation-other",
  );
  const identity = ordinaryInputIdentity("other-scope-input");
  if (!identity) throw new Error("missing other-scope identity");
  expect(rememberInputDisposition(other, identity, "started")).toBe(true);
  expect(
    prepareInputTerminal(other, [identity], {
      scope: { agentId: "agent-0", conversationId: "conversation-other" },
      message: {
        type: "turn_finished",
        turn_id: "turn-other-scope",
        stop_reason: "end_turn",
      },
      owner: {
        connectionId: null,
        canRotate: false,
        lineageId: "lineage-other-scope",
        terminalIdentity: "terminal-other-scope",
        interruptedRevision: "revision-legacy-quarantine",
        recoveryLineageId: "recovery-legacy-quarantine",
        interruptedAuthorityRevision: "authority-other-scope",
      },
    }),
  ).toBe(true);
});
