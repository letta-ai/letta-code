import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectSandboxBackend } from "@/sandbox/availability";
import { bash } from "./bash.js";
import { withShellProcessGuard } from "./shell-process-guard.js";

const strictEnv = { LETTA_BASH_STRICT: "1", LETTA_FS_SANDBOX: "0" };

function refusal(tool: string, pid: number, suggestion: string) {
  return `${tool}: refusing to run - this pattern matches the Letta Code CLI process (PID ${pid}). Narrow the pattern, or target your own children with \`pkill -P $$ ${suggestion}\`.`;
}

test.skipIf(process.platform === "win32")(
  "shell commands survive guard file cleanup and restore the guard",
  () => {
    const dir = mkdtempSync(join(tmpdir(), "letta-guard-cleanup-"));
    try {
      const result = spawnSync(
        process.execPath,
        [
          "-e",
          `
            import { spawnSync } from "node:child_process";
            import { readdirSync, rmSync } from "node:fs";
            import { join } from "node:path";
            import { withShellProcessGuard } from ${JSON.stringify(join(import.meta.dir, "shell-process-guard.ts"))};

            for (const shell of ["/bin/sh", "/bin/bash"]) {
              const prepared = withShellProcessGuard(
                [shell, "-c", "printf ready"], process.env,
              );
              for (const entry of readdirSync(process.env.TMPDIR)) {
                rmSync(join(process.env.TMPDIR, entry), { recursive: true });
              }
              const afterCleanup = spawnSync(shell, prepared.launcher.slice(1), {
                env: prepared.env, encoding: "utf8",
              });
              if (afterCleanup.status !== 0 || afterCleanup.stdout !== "ready" || afterCleanup.stderr) {
                throw new Error(shell + ": " + afterCleanup.stderr);
              }

              const next = withShellProcessGuard(
                [shell, "-c", "type __letta_has_ignore_ancestors >/dev/null"], process.env,
              );
              const restored = spawnSync(shell, next.launcher.slice(1), {
                env: next.env, encoding: "utf8",
              });
              if (restored.status !== 0) throw new Error(shell + ": guard was not restored");
            }
          `,
        ],
        {
          env: { ...process.env, TMPDIR: dir },
          encoding: "utf8",
          timeout: 5000,
        },
      );
      expect(result.status, result.stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "pkill and killall guard a non-ancestor process without blocking signal zero",
  async () => {
    const darwin = process.platform === "darwin";
    const sleep = spawnSync("which", ["sleep"], { encoding: "utf8" });
    expect(sleep.status, sleep.stderr).toBe(0);
    const dir = mkdtempSync(join(tmpdir(), "letta-signal-test-"));
    const name = `lettadummy${randomUUID().slice(0, 5)}`;
    const executable = join(dir, name);
    try {
      copyFileSync(sleep.stdout.trim(), executable);
      chmodSync(executable, 0o700);
      const child = spawn(executable, ["300"], { stdio: "ignore" });
      const closed = new Promise<void>((resolve) => {
        child.once("close", () => resolve());
      });
      try {
        await new Promise<void>((resolve, reject) => {
          child.once("spawn", resolve);
          child.once("error", reject);
        });
        const pid = child.pid;
        if (!pid) throw new Error("Missing sleeper PID");
        const run = (command: string) => {
          const { launcher, env } = withShellProcessGuard(
            [darwin ? "/bin/zsh" : "/bin/bash", "-c", command],
            { ...process.env, DUMMY_NAME: name },
          );
          const [shell, ...args] = launcher;
          if (!shell) throw new Error("Missing shell launcher");
          return spawnSync(shell, args, {
            env: {
              ...env,
              LETTA_CLI_PID: String(pid),
              LETTA_PROTECTED_PIDS: String(pid),
            },
            encoding: "utf8",
            timeout: 3000,
          });
        };
        const refusals = [
          'killall "$DUMMY_NAME"',
          'killall -TERM "$DUMMY_NAME"',
          'pkill -f "$DUMMY_NAME"',
          'pkill -l -f "$DUMMY_NAME"',
          'pkill -lf "$DUMMY_NAME"',
          'pkill -d : -f "$DUMMY_NAME"',
          ...(darwin
            ? [
                'killall -c "$DUMMY_NAME"',
                'killall -m "$DUMMY_NAME"',
                'pkill -I -f "$DUMMY_NAME"',
                'pkill -Iaf "$DUMMY_NAME"',
              ]
            : [
                'pkill --delimiter=: --list-full -f "$DUMMY_NAME"',
                'pkill -H -f "$DUMMY_NAME"',
              ]),
        ];
        for (const command of refusals) {
          const result = run(command);
          const tool = command.startsWith("killall") ? "killall" : "pkill";
          expect(result.status, command).toBe(1);
          expect(result.stderr, command).toBe(
            `${refusal(tool, pid, tool === "pkill" ? "..." : name)}\n`,
          );
          expect(() => process.kill(pid, 0)).not.toThrow();
        }
        for (const command of [
          'killall -0 "$DUMMY_NAME"',
          'pkill -0 -f "$DUMMY_NAME"',
          ...(darwin
            ? ['killall -s "$DUMMY_NAME"', 'killall -d "$DUMMY_NAME"']
            : []),
        ]) {
          const result = run(command);
          expect(result.status, result.stderr).toBe(0);
          expect(result.stderr).not.toContain("refusing to run");
        }
      } finally {
        child.kill();
        await closed;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "linux")(
  "Bash refuses a runtime pkill pattern matching the CLI argv",
  () => {
    const marker = `letta-guard-${randomUUID()}`;
    const ctl = spawnSync(
      process.execPath,
      [
        "-e",
        `
          import { bash } from ${JSON.stringify(join(import.meta.dir, "bash.ts"))};
          const result = await bash({
            command: 'pattern="$MARKER"; pkill -CONT -ef "$pattern"',
            variableEnv: { ...${JSON.stringify(strictEnv)}, MARKER: process.argv.at(-1) },
          });
          console.log(JSON.stringify({ result, pid: process.pid }));
        `,
        marker,
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    expect(ctl.status, ctl.stderr).toBe(0);
    const { result, pid } = JSON.parse(ctl.stdout);
    expect(result.status).toBe("error");
    expect(result.content[0].text).toContain(refusal("pkill", pid, "..."));
    expect(result.content[0].text).toContain("Exit code: 1");
  },
);

test.skipIf(process.platform !== "linux")(
  "Bash refuses killall of the CLI's process name",
  async () => {
    const result = await bash({
      command:
        'IFS= read -r name < "/proc/$LETTA_CLI_PID/comm"; killall -s CONT "$name"',
      variableEnv: strictEnv,
    });
    const name = (await Bun.file("/proc/self/comm").text()).trimEnd();
    expect(result.status).toBe("error");
    expect(result.content[0]?.text).toContain(
      refusal("killall", process.pid, name),
    );
    expect(result.content[0]?.text).toContain("Exit code: 1");
  },
);

test.skipIf(process.platform !== "linux")(
  "Bash can signal its own children by parent and by full command line",
  async () => {
    const result = await bash({
      command: `
        sleeper=sleep
        "$sleeper" 300 & child=$!
        trap 'kill "$child" 2>/dev/null || true' EXIT
        until command pgrep -P "$$" -x sleep >/dev/null; do :; done
        pkill -P $$ sleep
        wait "$child" || test "$?" -eq 143
        if kill -0 "$child" 2>/dev/null; then exit 1; fi

        (exec -a "$MARKER" "$sleeper" 300) & child=$!
        until command pgrep -P "$$" -f "$MARKER" >/dev/null; do :; done
        pkill --signal=TERM -f "$MARKER"
        wait "$child" || test "$?" -eq 143
        if kill -0 "$child" 2>/dev/null; then exit 1; fi
      `,
      timeout: 3000,
      variableEnv: { ...strictEnv, MARKER: `letta-child-${randomUUID()}` },
    });
    expect(result.status, result.content[0]?.text).toBe("success");
  },
);

const supportsIgnoreAncestors =
  process.platform === "linux" &&
  [0, 1].includes(
    spawnSync("pgrep", ["--ignore-ancestors", "-x", "__letta_probe__"])
      .status ?? -1,
  );

test.skipIf(process.platform !== "linux")(
  "pkill signal-zero probes return the real command status for a CLI match",
  () => {
    const marker = `letta-guard-${randomUUID()}`;
    const ctl = spawnSync(
      process.execPath,
      [
        "-e",
        `
          import { spawn, spawnSync } from "node:child_process";
          import { withShellProcessGuard } from ${JSON.stringify(join(import.meta.dir, "shell-process-guard.ts"))};
          const { launcher: [shell, ...args], env } = withShellProcessGuard(
            ["/bin/sh", "-c", ${JSON.stringify(`
              command pgrep -f "$PATTERN" | grep -Fxq "$LETTA_CLI_PID" || exit 3
              for form in shorthand separate attached; do
                case "$form" in
                  shorthand) set -- -0 ;;
                  separate) set -- --signal 0 ;;
                  attached) set -- --signal=0 ;;
                esac
                actual=0 expected=0
                pkill "$@" -f "$PATTERN" || actual=$?
                command pkill ${supportsIgnoreAncestors ? "--ignore-ancestors" : ""} "$@" -f "$PATTERN" || expected=$?
                printf '%s %s\n' "$actual" "$expected"
              done
            `)}],
            { ...process.env, PATTERN: process.argv.at(-1) },
          );
          const result = spawnSync(shell, args, { env, encoding: "utf8" });
          process.stdout.write(result.stdout);
          process.stderr.write(result.stderr);
          process.exitCode = result.status ?? 4;
        `,
        marker,
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    expect(ctl.status, ctl.stderr).toBe(0);
    expect(ctl.stderr).not.toContain("refusing to run");
    const status = supportsIgnoreAncestors ? 1 : 0;
    expect(ctl.stdout.trim().split("\n")).toEqual(
      Array(3).fill(`${status} ${status}`),
    );
  },
);

test.skipIf(process.platform !== "linux")(
  "killall signal-zero probes succeed for the CLI process name",
  () => {
    const {
      launcher: [shell, ...args],
      env,
    } = withShellProcessGuard(
      [
        "/bin/sh",
        "-c",
        `
          set -e
          IFS= read -r name < "/proc/$LETTA_CLI_PID/comm"
          killall -0 "$name"
          killall -s 0 "$name"
          killall --signal 0 "$name"
          killall --signal=0 "$name"
        `,
      ],
      process.env,
    );
    if (!shell) throw new Error("Missing shell launcher");
    const result = spawnSync(shell, args, { env, encoding: "utf8" });
    expect(result.stderr).not.toContain("refusing to run");
    expect(result.status, result.stderr).toBe(0);
  },
);

test.skipIf(!supportsIgnoreAncestors)(
  "Bash pgrep excludes the tool shell even when its argv matches",
  async () => {
    const marker = `letta-shell-${randomUUID()}`;
    const result = await bash({
      command: `
        : ${marker}
        command pgrep -f "$MARKER" | grep -Fx "$$"
        if pgrep -f "$MARKER" | grep -Fx "$$"; then exit 1; fi
      `,
      variableEnv: { ...strictEnv, MARKER: marker },
    });
    expect(result.status, result.content[0]?.text).toBe("success");
  },
);

test.skipIf(process.platform === "win32")(
  "unsupported pgrep is probed once and receives the original arguments",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "letta-pgrep-test-"));
    try {
      const fakePgrep = join(dir, "pgrep");
      writeFileSync(
        fakePgrep,
        '#!/bin/sh\nif [ "$1" = --ignore-ancestors ]; then printf "probe\\n" >> "$PROBE_LOG"; exit 2; fi\nprintf "%s\\n" "$@"\n',
      );
      chmodSync(fakePgrep, 0o700);
      const probeLog = join(dir, "probes");
      const { launcher, env } = withShellProcessGuard(
        ["/bin/sh", "-c", "set -eu; pgrep -x one; pgrep -f 'two words'"],
        { ...process.env, PATH: dir, PROBE_LOG: probeLog },
      );
      const [executable, ...argv] = launcher;
      if (!executable) throw new Error("Missing shell launcher");
      const result = spawnSync(executable, argv, {
        env,
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("-x\none\n-f\ntwo words\n");
      expect(await Bun.file(probeLog).text()).toBe("probe\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test.skipIf(detectSandboxBackend().backend !== "bwrap")(
  "Bash loads the shim inside bwrap",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "letta-bwrap-guard-test-"));
    try {
      const result = await bash({
        command:
          'test "$LETTA_SANDBOX" = bwrap; type pkill; test "$LETTA_CLI_PID" = "$EXPECTED_PID"',
        variableEnv: {
          ...strictEnv,
          LETTA_FS_SANDBOX: "1",
          LETTA_SANDBOX: "",
          MEMORY_DIR: join(dir, "memory"),
          EXPECTED_PID: String(process.pid),
        },
      });
      expect(result.status, result.content[0]?.text).toBe("success");
      expect(result.content[0]?.text).toContain("pkill is a function");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
