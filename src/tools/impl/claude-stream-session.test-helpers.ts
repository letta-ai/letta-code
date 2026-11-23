import { PassThrough } from "node:stream";
import type { ClaudeSessionTransport } from "./claude-stream-session";

export const SESSION_ID = "11111111-1111-4111-8111-111111111111";

export function transportFixture(options: { exitOnStdinEnd?: boolean } = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let finish!: (value: {
    exitCode: number | null;
    exitSignal: NodeJS.Signals | null;
  }) => void;
  const completion = new Promise<{
    exitCode: number | null;
    exitSignal: NodeJS.Signals | null;
  }>((resolve) => {
    finish = resolve;
  });
  const writes: string[] = [];
  stdin.on("data", (chunk) => writes.push(chunk.toString()));
  let ended = false;
  const originalEnd = stdin.end.bind(stdin);
  stdin.end = ((...args: Parameters<typeof stdin.end>) => {
    ended = true;
    return originalEnd(...args);
  }) as typeof stdin.end;
  if (options.exitOnStdinEnd !== false)
    stdin.on("finish", () => finish({ exitCode: 0, exitSignal: null }));
  const transport: ClaudeSessionTransport = {
    process: { stdin, stdout, stderr } as ClaudeSessionTransport["process"],
    completion,
    wasAborted: () => false,
  };
  const emit = (value: Record<string, unknown>) =>
    stdout.write(`${JSON.stringify(value)}\n`);
  const echo = (index: number) => {
    const input = JSON.parse(writes[index] ?? "") as Record<string, unknown>;
    emit({ ...input, isReplay: true, session_id: SESSION_ID });
  };
  return {
    transport,
    writes,
    stdout,
    stderr,
    finish,
    stdin,
    emit,
    echo,
    ended: () => ended,
  };
}

export function parseWrite(
  fixture: ReturnType<typeof transportFixture>,
  index: number,
) {
  return JSON.parse(fixture.writes[index] ?? "") as Record<string, unknown>;
}

export const base = { parentAgentId: "parent", cwd: "/repo" };

export const BACKGROUND_TEST_TIMEOUT_MS = 5_000;

export async function awaitWithLiveLoop<T>(promise: Promise<T>): Promise<T> {
  const keepAlive = setInterval(() => undefined, 5);
  try {
    return await promise;
  } finally {
    clearInterval(keepAlive);
  }
}

export function teardownFixture(
  fixture: ReturnType<typeof transportFixture>,
): void {
  if (!fixture.stdin.writableEnded) fixture.stdin.end();
  fixture.stdout.end();
  fixture.stderr.end();
  fixture.finish({ exitCode: 0, exitSignal: null });
}

const openFixtures: Array<ReturnType<typeof transportFixture>> = [];

export function trackedFixture(
  options: Parameters<typeof transportFixture>[0] = {},
): ReturnType<typeof transportFixture> {
  const fixture = transportFixture(options);
  openFixtures.push(fixture);
  return fixture;
}

export function teardownOpenFixtures(): void {
  for (const fixture of openFixtures.splice(0)) teardownFixture(fixture);
}
