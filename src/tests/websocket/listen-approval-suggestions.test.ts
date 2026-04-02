import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalContext } from "../../permissions/analyzer";
import { loadPermissions } from "../../permissions/loader";
import {
  applySuggestedPermissionsForApproval,
  buildApprovalSuggestionPayload,
} from "../../websocket/listener/approval-suggestions";

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "letta-listen-approval-suggestions-"));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

test("buildApprovalSuggestionPayload exposes TUI-equivalent suggestion text", () => {
  const context: ApprovalContext = {
    recommendedRule: "Bash(rm:*)",
    ruleDescription: "rm commands",
    approveAlwaysText:
      "Yes, and don't ask again for 'rm' commands in this project",
    defaultScope: "project",
    allowPersistence: true,
    safetyLevel: "moderate",
  };

  expect(buildApprovalSuggestionPayload(context)).toEqual({
    permission_suggestions: [
      {
        id: "save-default",
        text: "Yes, and don't ask again for 'rm' commands in this project",
      },
    ],
  });
});

test("buildApprovalSuggestionPayload omits suggestions when approval cannot be persisted", () => {
  const context: ApprovalContext = {
    recommendedRule: "",
    ruleDescription: "",
    approveAlwaysText: "",
    defaultScope: "session",
    allowPersistence: false,
    safetyLevel: "dangerous",
  };

  expect(buildApprovalSuggestionPayload(context)).toEqual({
    permission_suggestions: [],
  });
});

test("applySuggestedPermissionsForApproval saves the selected backend suggestion", async () => {
  const context: ApprovalContext = {
    recommendedRule: "Bash(rm:*)",
    ruleDescription: "rm commands",
    approveAlwaysText:
      "Yes, and don't ask again for 'rm' commands in this project",
    defaultScope: "project",
    allowPersistence: true,
    safetyLevel: "moderate",
  };

  const applied = await applySuggestedPermissionsForApproval({
    decision: {
      behavior: "allow",
      selected_permission_suggestion_ids: ["save-default"],
    },
    context,
    workingDirectory: testDir,
  });

  const permissions = await loadPermissions(testDir);
  expect(applied).toBe(true);
  expect(permissions.allow).toContain("Bash(rm:*)");
});

test("applySuggestedPermissionsForApproval ignores unselected suggestions", async () => {
  const context: ApprovalContext = {
    recommendedRule: "Bash(rm:*)",
    ruleDescription: "rm commands",
    approveAlwaysText:
      "Yes, and don't ask again for 'rm' commands in this project",
    defaultScope: "project",
    allowPersistence: true,
    safetyLevel: "moderate",
  };

  const applied = await applySuggestedPermissionsForApproval({
    decision: {
      behavior: "allow",
      selected_permission_suggestion_ids: [],
    },
    context,
    workingDirectory: testDir,
  });

  const permissions = await loadPermissions(testDir);
  expect(applied).toBe(false);
  expect(permissions.allow).not.toContain("Bash(rm:*)");
});
