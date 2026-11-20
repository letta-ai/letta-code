import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  findProtectedShellProcess,
  protectedShellProcessMessage,
} from "./protected-shell-processes";

test("recognizes signals, protected PIDs, and explicit process groups", () => {
  const lookup = {
    pid: 123,
    info: (pid: number) => ({ parent: pid === 123 ? 42 : 0, group: 23 }),
    pgrep: () => [],
  };
  for (const [command, target] of [
    ["kill 123", "the Letta Code CLI running this agent (PID 123)"],
    [
      "/bin/kill -s TERM -- 42",
      "an ancestor (PID 42) of the Letta Code CLI running this agent",
    ],
    [
      "echo ready && kill -9 -23",
      "the process group (PGID 23) of the Letta Code CLI running this agent",
    ],
    ["true & kill 123", "the Letta Code CLI running this agent (PID 123)"],
    [
      "kill -- -23",
      "the process group (PGID 23) of the Letta Code CLI running this agent",
    ],
    ["kill -TERM -- -1", "the Letta Code CLI running this agent (PID 123)"],
  ] as const) {
    expect(findProtectedShellProcess(command, lookup)).toContain(target);
  }
  for (const command of [
    "kill -0 123",
    "kill -s 0 123",
    "kill -n 0 123",
    "kill -l 123",
    "kill 124",
    "kill -- -222",
    "kill $!",
    "echo 'kill 123'",
    "kill 123 > arbitrary-file",
    "true # comment; kill 123",
    "cat <<EOF\nkill 123\nEOF",
    "kill $(echo 123 456)",
  ]) {
    expect(findProtectedShellProcess(command, lookup)).toBeUndefined();
  }
});

test("passes matching arguments directly to pgrep", () => {
  const queries: string[][] = [];
  const lookup = {
    pid: 123,
    info: () => undefined,
    pgrep: (args: string[]) => {
      queries.push(args);
      return [123];
    },
  };
  for (const command of [
    "pkill -TERM -f 'two words'",
    "pkill -s 42 node",
    "kill $(pgrep -f 'two words')",
    "kill `pgrep -f 'two words'`",
    'kill "$(pgrep -f x)"',
    'kill -9 "$(pgrep x)"',
    'kill "$(pgrep -f "two words")"',
    "killall -KILL node",
  ]) {
    expect(findProtectedShellProcess(command, lookup, "linux")).toBe(
      "the Letta Code CLI running this agent (PID 123)",
    );
  }
  expect(queries).toEqual([
    ["-f", "two words"],
    ["-s", "42", "node"],
    ["-f", "two words"],
    ["-f", "two words"],
    ["-f", "x"],
    ["x"],
    ["-f", "two words"],
    ["-x", "--", "node"],
  ]);
  expect(
    findProtectedShellProcess("kill '$(pgrep node)'", lookup),
  ).toBeUndefined();
  expect(findProtectedShellProcess("pkill -0 -f node", lookup)).toBeUndefined();
  expect(
    findProtectedShellProcess('kill -0 "$(pgrep x)"', lookup),
  ).toBeUndefined();
  expect(
    findProtectedShellProcess('kill "\\$(pgrep x)"', lookup),
  ).toBeUndefined();
  expect(
    protectedShellProcessMessage(
      "the Letta Code CLI running this agent (PID 123)",
    ),
  ).toBe(
    "Blocked: This command would signal the Letta Code CLI running this agent (PID 123). Target a specific child PID such as $!, or use KillBash to stop a background task.",
  );
});

test("Darwin only includes ancestors for killall or an explicit -a", () => {
  const queries: string[][] = [];
  const lookup = {
    pid: 123,
    info: () => undefined,
    pgrep: (args: string[]) => {
      queries.push(args);
      return args.includes("-a") ? [123] : [];
    },
  };
  for (const command of [
    "killall node",
    "killall -TERM node",
    "pkill -a -f node",
    "kill $(pgrep -a -f node)",
  ]) {
    expect(findProtectedShellProcess(command, lookup, "darwin")).toContain(
      "(PID 123)",
    );
  }
  for (const command of [
    "pkill -f node",
    "kill $(pgrep -f node)",
    "killall -s node",
    "killall -0 node",
  ]) {
    expect(
      findProtectedShellProcess(command, lookup, "darwin"),
    ).toBeUndefined();
  }
  expect(queries).toEqual([
    ["-a", "-x", "--", "node"],
    ["-a", "-x", "--", "node"],
    ["-a", "-f", "node"],
    ["-a", "-f", "node"],
    ["-f", "node"],
    ["-f", "node"],
  ]);
});

test.skipIf(process.platform !== "linux")(
  "real pgrep protects this CLI process and permits killing its child",
  () => {
    const marker = `process-guard-${crypto.randomUUID()}`;
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        `import { spawn } from "node:child_process";
         import { findProtectedShellProcess as find } from ${JSON.stringify(new URL("./protected-shell-processes.ts", import.meta.url).pathname)};
         const child = spawn("sleep", ["10"]);
         try {
           console.log(JSON.stringify([
             find("kill " + child.pid) ?? null,
             find("kill " + process.pid),
             find("pkill -f " + process.argv[1]),
             find("kill $(pgrep -f " + process.argv[1] + ")"),
           ]));
         } finally {
           child.kill();
         }`,
        marker,
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const [child, direct, pkill, substitution] = JSON.parse(result.stdout);
    expect(child).toBeNull();
    expect(direct).toMatch(
      /^the Letta Code CLI running this agent \(PID \d+\)$/,
    );
    expect(pkill).toBe(direct);
    expect(substitution).toBe(direct);
  },
);
