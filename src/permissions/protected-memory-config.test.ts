import { afterEach, expect, test } from "bun:test";
import { checkPermission } from "@/permissions/checker";
import { permissionMode } from "@/permissions/mode";
import { isReadOnlyShellCommand } from "@/permissions/read-only-shell";

afterEach(() => permissionMode.reset());

test("reading the memory token limit is read-only but setting it is not", () => {
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
});

test("setting the memory token limit always asks in unrestricted mode", () => {
  permissionMode.setMode("unrestricted");
  const result = checkPermission(
    "exec_command",
    { cmd: "letta memory token-limit set 30000" },
    { allow: [], deny: [], ask: [] },
    "/Users/test/project",
  );
  expect(result.decision).toBe("alwaysAsk");
  expect(result.matchedRule).toBe("letta memory token-limit set");
});

test("setting through an absolute letta path also asks", () => {
  permissionMode.setMode("unrestricted");
  const result = checkPermission(
    "Bash",
    {
      command: "/usr/local/bin/letta memory token-limit set 1",
    },
    { allow: [], deny: [], ask: [] },
    "/Users/test/project",
  );
  expect(result.decision).toBe("alwaysAsk");
});

test("quoted executable and subcommands cannot bypass approval", () => {
  permissionMode.setMode("unrestricted");
  const result = checkPermission(
    "Bash",
    {
      command: '"/usr/local/bin/letta" "memory" "token-limit" "set" 1',
    },
    { allow: [], deny: [], ask: [] },
    "/Users/test/project",
  );
  expect(result.decision).toBe("alwaysAsk");
});
