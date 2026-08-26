import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPowerShellCommand,
  buildShellLaunchers,
  POWERSHELL_EXIT_CODE_SUFFIX,
  POWERSHELL_UTF8_OUTPUT_PREFIX,
  selectAvailableShellLauncher,
} from "@/tools/impl/shell-launchers";

describe("Shell Launchers", () => {
  test("builds launchers for a command", () => {
    const launchers = buildShellLaunchers("echo hello");
    expect(launchers.length).toBeGreaterThan(0);
    expect(launchers[0]).toBeDefined();
  });

  test("returns empty array for empty command", () => {
    const launchers = buildShellLaunchers("");
    expect(launchers).toEqual([]);
  });

  test("returns empty array for whitespace-only command", () => {
    const launchers = buildShellLaunchers("   ");
    expect(launchers).toEqual([]);
  });

  test("PowerShell command aliases common Letta environment variables", () => {
    const command = buildPowerShellCommand('ls "$MEMORY_DIR/system/human/"');

    expect(command).toContain("$MEMORY_DIR = $env:MEMORY_DIR");
    expect(command).toContain("$LETTA_MEMORY_DIR = $env:LETTA_MEMORY_DIR");
    expect(command).toContain("$AGENT_ID = $env:AGENT_ID");
    expect(command).toContain("$CONVERSATION_ID = $env:CONVERSATION_ID");
    expect(command.endsWith('ls "$MEMORY_DIR/system/human/"')).toBe(true);
    expect(command.startsWith(POWERSHELL_UTF8_OUTPUT_PREFIX)).toBe(true);
  });

  test("PowerShell command uses Codex UTF-8 output prefix", () => {
    const command = buildPowerShellCommand("Write-Host hi");

    expect(command.startsWith(POWERSHELL_UTF8_OUTPUT_PREFIX)).toBe(true);
    expect(command.endsWith("Write-Host hi")).toBe(true);
  });

  test("PowerShell command does not duplicate Codex UTF-8 output prefix", () => {
    const command = buildPowerShellCommand(
      `${POWERSHELL_UTF8_OUTPUT_PREFIX}Write-Host hi`,
    );

    expect(command.split(POWERSHELL_UTF8_OUTPUT_PREFIX)).toHaveLength(2);
    expect(command.endsWith("Write-Host hi")).toBe(true);
  });

  test("PowerShell command preserves quoted executable invocation", () => {
    const command = buildPowerShellCommand(
      '"C:/Program Files/Git/bin/git.exe" status',
    );

    expect(
      command.endsWith('& "C:/Program Files/Git/bin/git.exe" status'),
    ).toBe(true);
  });

  test("PowerShell exit preservation is opt-in", () => {
    const defaultCommand = buildPowerShellCommand("node hook.mjs");
    const hookCommand = buildPowerShellCommand("node hook.mjs", [], true);

    expect(defaultCommand).not.toContain(POWERSHELL_EXIT_CODE_SUFFIX);
    expect(hookCommand).toContain("$global:LASTEXITCODE = $null");
    expect(hookCommand.endsWith(POWERSHELL_EXIT_CODE_SUFFIX)).toBe(true);
  });

  test("Windows launchers match Codex PowerShell order", () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(
      process,
      "platform",
    );
    Object.defineProperty(process, "platform", { value: "win32" });

    try {
      const launchers = buildShellLaunchers("echo test");

      expect(launchers[0]?.[0]).toBe("pwsh");
      expect(launchers[1]?.[0]).toBe(
        "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      );
      expect(launchers[2]?.[0]).toBe("powershell");
      expect(launchers[3]?.[0]).toBe(
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      );
      expect(launchers[4]?.[0]).toBe("cmd.exe");
      expect(launchers[0]?.at(-1)).toContain(POWERSHELL_UTF8_OUTPUT_PREFIX);
      expect(launchers[1]?.at(-1)).toContain(POWERSHELL_UTF8_OUTPUT_PREFIX);
      expect(launchers[2]?.at(-1)).toContain(POWERSHELL_UTF8_OUTPUT_PREFIX);
      expect(launchers[3]?.at(-1)).toContain(POWERSHELL_UTF8_OUTPUT_PREFIX);
      expect(launchers[0]?.at(-1)).not.toContain(POWERSHELL_EXIT_CODE_SUFFIX);

      const hookLaunchers = buildShellLaunchers("node hook.mjs", {
        preservePowerShellExitCode: true,
      });
      expect(hookLaunchers[0]?.at(-1)).toContain(POWERSHELL_EXIT_CODE_SUFFIX);
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, "platform", originalPlatform);
      }
    }
  });

  if (process.platform === "win32") {
    describe("Windows-specific", () => {
      function runPowerShellHook(
        command: string,
        executable?: string,
      ): number | null {
        const shellLaunchers = buildShellLaunchers(command, {
          preservePowerShellExitCode: true,
        });
        const launcher = executable
          ? [
              executable,
              "-NoProfile",
              "-Command",
              shellLaunchers[0]?.at(-1) ?? "",
            ]
          : selectAvailableShellLauncher(shellLaunchers);
        expect(launcher?.[0]?.toLowerCase()).toMatch(/pwsh|powershell/);
        if (!launcher?.[0]) return null;
        return spawnSync(launcher[0], launcher.slice(1), {
          encoding: "utf8",
        }).status;
      }

      test("PowerShell is tried before cmd.exe", () => {
        const launchers = buildShellLaunchers("echo test");

        // Find indices of PowerShell and cmd.exe
        const powershellIndex = launchers.findIndex(
          (l) =>
            l[0]?.toLowerCase().includes("powershell") ||
            l[0]?.toLowerCase() === "pwsh",
        );
        const cmdIndex = launchers.findIndex(
          (l) =>
            l[0]?.toLowerCase().includes("cmd") ||
            l[0]?.toLowerCase() === process.env.ComSpec?.toLowerCase(),
        );

        expect(powershellIndex).toBeGreaterThanOrEqual(0);
        expect(cmdIndex).toBeGreaterThanOrEqual(0);
        // PowerShell should come before cmd.exe
        expect(powershellIndex).toBeLessThan(cmdIndex);
      });

      test("pwsh is tried before Windows PowerShell", () => {
        const launchers = buildShellLaunchers("echo test");
        const pwshIndex = launchers.findIndex(
          (l) => l[0]?.toLowerCase() === "pwsh",
        );
        const powershellIndex = launchers.findIndex((l) =>
          l[0]?.toLowerCase().includes("powershell"),
        );

        expect(pwshIndex).toBeGreaterThanOrEqual(0);
        expect(powershellIndex).toBeGreaterThanOrEqual(0);
        expect(pwshIndex).toBeLessThan(powershellIndex);
      });

      test("includes PowerShell with -NoProfile flag", () => {
        const launchers = buildShellLaunchers("echo test");
        const powershellLauncher = launchers.find((l) =>
          l[0]?.toLowerCase().includes("powershell"),
        );

        expect(powershellLauncher).toBeDefined();
        expect(powershellLauncher).toContain("-NoProfile");
        expect(powershellLauncher).toContain("-Command");
      });

      test("preserves native and explicit hook exit codes", () => {
        expect(runPowerShellHook('node -e "process.exit(0)"')).toBe(0);
        expect(runPowerShellHook('node -e "process.exit(1)"')).toBe(1);
        expect(runPowerShellHook('node -e "process.exit(2)"')).toBe(2);
        expect(runPowerShellHook("exit 7")).toBe(7);
      });

      test("preserves final PowerShell statement semantics", () => {
        expect(
          runPowerShellHook(
            "Get-Item -LiteralPath 'Z:\\\\missing-letta-hook-path' -ErrorAction SilentlyContinue # trailing comment",
          ),
        ).toBe(1);
        expect(
          runPowerShellHook('node -e "process.exit(2)"; Write-Output handled'),
        ).toBe(0);
      });

      test("does not reuse a stale native exit code after a failing cmdlet", () => {
        for (const errorAction of ["SilentlyContinue", "Ignore"]) {
          expect(
            runPowerShellHook(
              `node -e "process.exit(2)"; Get-Item -LiteralPath 'Z:\\missing-letta-hook-path' -ErrorAction ${errorAction}`,
            ),
          ).toBe(1);
        }
      });

      test("preserves a final native block after an earlier cmdlet failure", () => {
        expect(
          runPowerShellHook(
            "Get-Item -LiteralPath 'Z:\\\\missing-letta-hook-path' -ErrorAction SilentlyContinue; node -e \"process.exit(2)\"",
          ),
        ).toBe(2);
      });

      test("preserves native blocks when native errors populate PowerShell error state", () => {
        expect(
          runPowerShellHook(
            '$PSNativeCommandUseErrorActionPreference = $true; node -e "process.exit(2)"',
          ),
        ).toBe(2);
      });

      test("does not reuse a native error after an ignored final cmdlet failure", () => {
        expect(
          runPowerShellHook(
            "$PSNativeCommandUseErrorActionPreference = $true; node -e \"process.exit(2)\"; Get-Item -LiteralPath 'Z:\\missing-letta-hook-path' -ErrorAction Ignore",
          ),
        ).toBe(1);
      });

      test("does not reuse a native exit after a language failure", () => {
        expect(
          runPowerShellHook('node -e "process.exit(2)"; $null.NoSuchMethod()'),
        ).toBe(1);
      });

      test("does not treat PowerShell scripts as native applications", () => {
        const scriptPath = join(
          tmpdir(),
          `letta-hook-external-script-${process.pid}.ps1`,
        );
        writeFileSync(scriptPath, "exit 2\n");
        try {
          expect(
            runPowerShellHook(`& '${scriptPath.replaceAll("'", "''")}'`),
          ).toBe(1);
        } finally {
          rmSync(scriptPath, { force: true });
        }
      });

      test("preserves the contract on Windows PowerShell 5.1", () => {
        const executable =
          "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
        expect(runPowerShellHook('node -e "process.exit(2)"', executable)).toBe(
          2,
        );
        expect(
          runPowerShellHook(
            'node -e "process.exit(2)"; $null.NoSuchMethod()',
            executable,
          ),
        ).toBe(1);
      });

      test("preserves native blocks invoked through a PowerShell alias", () => {
        expect(
          runPowerShellHook(
            'Set-Alias letta-test-node node; letta-test-node -e "process.exit(2)"',
          ),
        ).toBe(2);
      });
    });
  } else {
    describe("Unix-specific", () => {
      test("prepends strict shell prelude when LETTA_BASH_STRICT is set", () => {
        const launchers = buildShellLaunchers("echo test", {
          env: { LETTA_BASH_STRICT: "1" },
        });

        expect(launchers[0]?.at(-1)).toBe("set -euo pipefail\necho test");
      });

      test("includes bash with -c flag", () => {
        const launchers = buildShellLaunchers("echo test");
        const bashLauncher = launchers.find(
          (l) => l[0]?.includes("bash") && l[1] === "-c",
        );

        expect(bashLauncher).toBeDefined();
      });

      test("uses login shell flag when login=true", () => {
        const launchers = buildShellLaunchers("echo test", { login: true });
        const loginLauncher = launchers.find(
          (l) =>
            (l[0]?.includes("bash") || l[0]?.includes("zsh")) && l[1] === "-lc",
        );
        expect(loginLauncher).toBeDefined();
      });

      test("prefers user SHELL environment", () => {
        const originalShell = process.env.SHELL;
        process.env.SHELL = "/bin/zsh";

        try {
          const launchers = buildShellLaunchers("echo test");
          // User's shell should be first
          expect(launchers[0]?.[0]).toBe("/bin/zsh");
        } finally {
          if (originalShell === undefined) delete process.env.SHELL;
          else process.env.SHELL = originalShell;
        }
      });
    });
  }
});
