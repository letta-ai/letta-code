import { afterEach, expect, test } from "bun:test";
import { checkPermission } from "@/permissions/checker";
import { loadPermissions } from "@/permissions/loader";
import { permissionMode } from "@/permissions/mode";
import { isReadOnlyShellCommand } from "@/permissions/read-only-shell";

afterEach(() => permissionMode.reset());

test("only declared token-limit reads are classified as read-only", () => {
  expect(
    isReadOnlyShellCommand(
      "letta memory token-limit get --memory-dir /tmp/mem",
    ),
  ).toBe(true);
  expect(
    isReadOnlyShellCommand(
      "letta memory token-limit set 30000 --memory-dir /tmp/mem",
    ),
  ).toBe(false);
  expect(isReadOnlyShellCommand("letta agents token-limit get")).toBe(false);
});

test("the native alwaysAsk rule survives unrestricted mode", async () => {
  permissionMode.setMode("unrestricted");
  const permissions = await loadPermissions("/Users/test/project");
  const result = checkPermission(
    "Bash",
    { command: "letta memory token-limit set 30000" },
    permissions,
    "/Users/test/project",
  );
  expect(result.decision).toBe("alwaysAsk");
  expect(result.matchedRule).toBe("Bash(letta memory token-limit set:*)");
});

test("alwaysAsk normalizes executable paths and quoted words", async () => {
  permissionMode.setMode("unrestricted");
  const permissions = await loadPermissions("/Users/test/project");
  for (const command of [
    "/usr/local/bin/letta memory token-limit set 30000",
    '"/usr/local/bin/letta" "memory" "token-limit" "set" 30000',
  ]) {
    expect(
      checkPermission("Bash", { command }, permissions, "/Users/test/project")
        .decision,
    ).toBe("alwaysAsk");
  }
});

test("unrelated shell text does not trigger token-limit approval", async () => {
  permissionMode.setMode("unrestricted");
  const permissions = await loadPermissions("/Users/test/project");
  const result = checkPermission(
    "Bash",
    { command: "echo memory token-limit set" },
    permissions,
    "/Users/test/project",
  );
  expect(result.decision).toBe("allow");
});
