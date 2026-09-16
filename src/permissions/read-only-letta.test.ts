import { afterEach, describe, expect, test } from "bun:test";
import { checkPermission } from "./checker";
import { permissionMode } from "./mode";
import { isReadOnlyShellCommand } from "./read-only-shell";

describe("letta CLI commands", () => {
  test("allows letta memory tokens", () => {
    expect(isReadOnlyShellCommand("letta memory tokens")).toBe(true);
  });

  test("allows letta memory tokens with flags", () => {
    expect(
      isReadOnlyShellCommand("letta memory tokens --quiet --format json"),
    ).toBe(true);
    expect(
      isReadOnlyShellCommand(
        "letta memory tokens --memory-dir /tmp/mem --top 10",
      ),
    ).toBe(true);
  });

  test("allows letta memory help", () => {
    expect(isReadOnlyShellCommand("letta memory help")).toBe(true);
  });

  test("blocks unknown letta memory action", () => {
    // restore/backup/pull/diff mutate state — not in read-only allowlist
    expect(isReadOnlyShellCommand("letta memory restore")).toBe(false);
    expect(isReadOnlyShellCommand("letta memory pull")).toBe(false);
    expect(isReadOnlyShellCommand("letta memory delete")).toBe(false);
  });

  test("blocks letta memory with no action", () => {
    expect(isReadOnlyShellCommand("letta memory")).toBe(false);
  });

  test("blocks unknown letta group", () => {
    expect(isReadOnlyShellCommand("letta install plugin")).toBe(false);
    expect(isReadOnlyShellCommand("letta doctor")).toBe(false);
    expect(isReadOnlyShellCommand("letta blocks list --agent agent-123")).toBe(
      false,
    );
  });

  test("allows legacy letta memfs alias", () => {
    expect(isReadOnlyShellCommand("letta memfs tokens")).toBe(true);
  });

  test("allows letta memory tokens piped to a safe command", () => {
    expect(
      isReadOnlyShellCommand("letta memory tokens --format json | head -5"),
    ).toBe(true);
  });
});

describe("explicit Letta backend selection", () => {
  test.each(["local", "api", "cloud"])(
    "allows evidence commands with backend %s",
    (backend) => {
      for (const selection of [
        `--backend ${backend}`,
        `--backend=${backend}`,
      ]) {
        for (const command of [
          "messages list --agent agent-target --conversation conv-target --limit 30 --include-errors",
          'messages search --agent agent-target --query "forgot instructions"',
          "steps trace --agent agent-target --step step-1",
          "memory tokens --format json",
          "memfs status",
          "agents list",
        ]) {
          expect(isReadOnlyShellCommand(`letta ${selection} ${command}`)).toBe(
            true,
          );
        }
      }
    },
  );

  test.each([
    'letta --backend "api" messages list',
    'letta --backend="local" messages list',
    "letta messages --backend local list",
    "letta messages list --backend=api",
    "letta --backend local messages list --backend cloud",
    "letta --backend local messages list | head -5",
  ])("allows supported backend placement and quoting: %s", (command) => {
    expect(isReadOnlyShellCommand(command)).toBe(true);
  });

  test.each([
    "letta --backend",
    "letta --backend local",
    "letta --backend messages list",
    "letta --backend= messages list",
    "letta --backend invalid messages list",
    "letta --backend local messages list --backend invalid",
    "letta --backend local --yolo messages list",
    "letta --backend local memory pull",
    "letta --backend api steps delete --step step-1",
    "letta --backend local messages transcript --out transcript.json",
    "letta --backend local messages list > messages.json",
    "letta --backend local messages list >> messages.json",
    "letta --backend local messages list && touch output.txt",
    "letta --backend local messages list | sh",
    "letta --backend $(touch output.txt) messages list",
    "letta --backend `touch output.txt` messages list",
  ])("does not auto-allow invalid or unsafe commands: %s", (command) => {
    expect(isReadOnlyShellCommand(command)).toBe(false);
  });
});

describe("Letta evidence tool permissions", () => {
  const command = "letta --backend local messages list --agent agent-target";
  const emptyRules = { allow: [], deny: [], ask: [] };

  afterEach(() => permissionMode.reset());

  test.each([
    "Bash",
    "shell_command",
    "ShellCommand",
    "run_shell_command",
    "exec_command",
  ])("auto-allows evidence through %s in standard mode", (toolName) => {
    permissionMode.setMode("standard");
    const args = toolName === "exec_command" ? { cmd: command } : { command };
    expect(checkPermission(toolName, args, emptyRules)).toMatchObject({
      decision: "allow",
      reason: "Read-only shell command",
    });
  });

  test("preserves strict mode and explicit permission rules", () => {
    permissionMode.setMode("strict");
    expect(checkPermission("Bash", { command }, emptyRules).decision).toBe(
      "ask",
    );
    permissionMode.setMode("standard");
    for (const decision of ["deny", "alwaysAsk"] as const) {
      const rules = { ...emptyRules, [decision]: ["Bash(letta:*)"] };
      expect(checkPermission("Bash", { command }, rules).decision).toBe(
        decision,
      );
    }
  });
});
