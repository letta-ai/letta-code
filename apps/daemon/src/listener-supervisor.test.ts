import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HOST_EVENT_PREFIX,
  ListenerSupervisor,
  parseHostEventLine,
  RESTART_STABILITY_WINDOW_MS,
  wasListenerStable,
} from "./listener-supervisor";

test("parses only versioned host event lines", () => {
  expect(
    parseHostEventLine(
      `${HOST_EVENT_PREFIX}{"version":1,"type":"ready","connectionId":"conn-1"}`,
    ),
  ).toEqual({ version: 1, type: "ready", connectionId: "conn-1" });
  expect(parseHostEventLine("Registered successfully")).toBeNull();
  expect(
    parseHostEventLine(`${HOST_EVENT_PREFIX}{"version":2,"type":"ready"}`),
  ).toBeNull();
  expect(
    parseHostEventLine(`${HOST_EVENT_PREFIX}{"version":1,"type":"ready"}`),
  ).toBeNull();
  expect(
    parseHostEventLine(
      `${HOST_EVENT_PREFIX}{"version":1,"type":"reconnecting","connectionId":"conn-1","attempt":0,"retryInMs":-1}`,
    ),
  ).toBeNull();
  expect(
    parseHostEventLine(
      `${HOST_EVENT_PREFIX}{"version":1,"type":"unexpected","connectionId":"conn-1"}`,
    ),
  ).toBeNull();
  expect(parseHostEventLine(`${HOST_EVENT_PREFIX}not-json`)).toBeNull();
});

test("resets restart backoff only after a meaningful stable window", () => {
  const readyAt = 10_000;
  expect(wasListenerStable(readyAt, readyAt + 1_000)).toBe(false);
  expect(
    wasListenerStable(readyAt, readyAt + RESTART_STABILITY_WINDOW_MS),
  ).toBe(true);
  expect(wasListenerStable(null, Number.MAX_SAFE_INTEGER)).toBe(false);
});

test("restarts and stops a managed listener without leaving it running", async () => {
  const directory = await mkdtemp(join(tmpdir(), "letta-daemon-listener-"));
  const scriptPath = join(directory, "fake-listener.js");
  const logPath = join(directory, "daemon.log");
  await writeFile(
    scriptPath,
    `console.log('${HOST_EVENT_PREFIX}{"version":1,"type":"ready","connectionId":"test"}');
process.stdin.resume();
process.stdin.once('data', () => process.exit(0));
setInterval(() => undefined, 1_000);
`,
    "utf8",
  );

  const statuses: string[] = [];
  const supervisor = new ListenerSupervisor({
    cliPath: scriptPath,
    environmentName: "First",
    executablePath: process.execPath,
    logPath,
    modulePath: directory,
    onStatus: (status) => statuses.push(status.kind),
  });

  try {
    await supervisor.start();
    await waitFor(
      () => statuses.filter((status) => status === "connected").length === 1,
    );
    await supervisor.restart("Second");
    await waitFor(
      () => statuses.filter((status) => status === "connected").length === 2,
    );
  } finally {
    await supervisor.stop();
  }

  expect(statuses.at(-1)).toBe("stopped");
  const log = await readFile(logPath, "utf8");
  expect(log).toContain('Starting Letta Code as "First".');
  expect(log).toContain('Starting Letta Code as "Second".');
});

test("falls back safely when a live listener has already closed stdin", async () => {
  const directory = await mkdtemp(join(tmpdir(), "letta-daemon-closed-stdin-"));
  const scriptPath = join(directory, "closed-stdin-listener.js");
  const logPath = join(directory, "daemon.log");
  await writeFile(
    scriptPath,
    `process.stdin.destroy();
console.log('${HOST_EVENT_PREFIX}{"version":1,"type":"ready","connectionId":"test"}');
setTimeout(() => process.exit(0), 200);
`,
    "utf8",
  );

  const statuses: string[] = [];
  const supervisor = new ListenerSupervisor({
    cliPath: scriptPath,
    environmentName: "Closed stdin",
    executablePath: process.execPath,
    logPath,
    modulePath: directory,
    onStatus: (status) => statuses.push(status.kind),
  });

  await supervisor.start();
  await waitFor(() => statuses.includes("connected"));
  await supervisor.stop();

  expect(statuses.at(-1)).toBe("stopped");
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for status.");
    await Bun.sleep(25);
  }
}
