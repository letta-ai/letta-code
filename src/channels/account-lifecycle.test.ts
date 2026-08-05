import { afterEach, expect, test } from "bun:test";
import { stopChannelAccountLive } from "@/channels/service";
import { __testOverrideChannelAccountStartupTimeout } from "@/channels/service-accounts";
import type { ChannelAdapter } from "@/channels/types";
import {
  createChannelAccountLive,
  FakeBot,
  getChannelAccountSnapshot,
  getChannelRegistry,
  installTelegramAdapterTestHooks,
  startChannelAccountLive,
} from "./telegram/adapter-test-harness";

installTelegramAdapterTestHooks();

interface StartGate {
  release: () => void;
}

function delayNextTelegramStart(): StartGate {
  let release = (): void => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  FakeBot.nextStartImpl = async (options, botInfo) => {
    await pending;
    await options?.onStart?.(
      botInfo ?? {
        username: "test_bot",
        id: 12345,
      },
    );
  };
  return { release };
}

function createDisabledTelegramAccount(accountId: string): void {
  createChannelAccountLive(
    "telegram",
    {
      displayName: accountId,
      enabled: false,
      token: "test-token",
      dmPolicy: "pairing",
    },
    { accountId },
  );
}

async function waitFor(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function registeredAdapter(accountId: string): ChannelAdapter | null {
  return getChannelRegistry()?.getAdapter("telegram", accountId) ?? null;
}

afterEach(() => {
  __testOverrideChannelAccountStartupTimeout(undefined);
});

test("a timed-out channel startup cannot leave its adapter live", async () => {
  __testOverrideChannelAccountStartupTimeout(20);
  const gate = delayNextTelegramStart();
  const accountId = "telegram-timeout";
  createDisabledTelegramAccount(accountId);

  const startup = startChannelAccountLive("telegram", accountId);
  await waitFor(
    () => registeredAdapter(accountId) !== null,
    "Timed out waiting for the pending adapter to register",
  );
  const staleAdapter = registeredAdapter(accountId);
  expect(staleAdapter).not.toBeNull();

  await expect(startup).rejects.toThrow(
    `Timed out starting telegram account "${accountId}"`,
  );
  expect(getChannelAccountSnapshot("telegram", accountId)).toEqual(
    expect.objectContaining({ enabled: false, running: false }),
  );
  expect(registeredAdapter(accountId)).toBeNull();

  gate.release();
  await waitFor(
    () => staleAdapter?.isRunning() === false,
    "The stale adapter remained running after its start completed",
  );
  expect(registeredAdapter(accountId)).toBeNull();
});

test("late cleanup from a timed-out start does not stop a retry", async () => {
  __testOverrideChannelAccountStartupTimeout(20);
  const firstGate = delayNextTelegramStart();
  const accountId = "telegram-timeout-retry";
  createDisabledTelegramAccount(accountId);

  const firstStartup = startChannelAccountLive("telegram", accountId);
  await waitFor(
    () => registeredAdapter(accountId) !== null,
    "Timed out waiting for the first adapter to register",
  );
  const staleAdapter = registeredAdapter(accountId);
  await expect(firstStartup).rejects.toThrow("Timed out starting telegram");

  FakeBot.nextStartImpl = async (options, botInfo) => {
    await options?.onStart?.(
      botInfo ?? {
        username: "test_bot",
        id: 12345,
      },
    );
  };
  await startChannelAccountLive("telegram", accountId);
  const retryAdapter = registeredAdapter(accountId);
  expect(retryAdapter).not.toBeNull();
  expect(retryAdapter).not.toBe(staleAdapter);
  expect(retryAdapter?.isRunning()).toBe(true);

  firstGate.release();
  await waitFor(
    () => staleAdapter?.isRunning() === false,
    "The stale adapter was not stopped after late completion",
  );
  expect(registeredAdapter(accountId)).toBe(retryAdapter);
  expect(retryAdapter?.isRunning()).toBe(true);
  expect(getChannelAccountSnapshot("telegram", accountId)).toEqual(
    expect.objectContaining({ enabled: true, running: true }),
  );
});

test("a concurrent stop supersedes an in-flight startup", async () => {
  __testOverrideChannelAccountStartupTimeout(500);
  const gate = delayNextTelegramStart();
  const accountId = "telegram-concurrent-stop";
  createDisabledTelegramAccount(accountId);

  const startup = startChannelAccountLive("telegram", accountId);
  await waitFor(
    () => registeredAdapter(accountId) !== null,
    "Timed out waiting for the pending adapter to register",
  );
  const staleAdapter = registeredAdapter(accountId);

  const stopped = await stopChannelAccountLive("telegram", accountId);
  expect(stopped).toEqual(
    expect.objectContaining({ enabled: false, running: false }),
  );
  expect(registeredAdapter(accountId)).toBeNull();

  gate.release();
  await expect(startup).rejects.toThrow("superseded");
  await waitFor(
    () => staleAdapter?.isRunning() === false,
    "The stopped startup became live after completing",
  );
  expect(registeredAdapter(accountId)).toBeNull();
  expect(getChannelAccountSnapshot("telegram", accountId)).toEqual(
    expect.objectContaining({ enabled: false, running: false }),
  );
});
