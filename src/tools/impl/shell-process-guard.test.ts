import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectSandboxBackend } from "@/sandbox/availability";
import { bash } from "./bash.js";
import { withShellProcessGuard } from "./shell-process-guard.js";

const strictEnv = { LETTA_BASH_STRICT: "1", LETTA_FS_SANDBOX: "0" };

function refusal(tool: string, pid: number, suggestion: string) {
  return `${tool}: refusing to run — this pattern matches the Letta Code CLI process (PID ${pid}). Narrow the pattern, or target your own children with \`pkill -P $$ ${suggestion}\`.`;
}

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
            command: 'pattern="$MARKER"; pkill -0 -ef "$pattern"',
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
        'IFS= read -r name < "/proc/$LETTA_CLI_PID/comm"; killall -s 0 "$name"',
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
