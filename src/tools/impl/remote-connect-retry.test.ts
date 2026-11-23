import { expect, mock, test } from "bun:test";
import type { AppServerClient } from "@/app-server-client";
import { connectRemoteWorkerWithRetry } from "./remote-connect-retry";

test("network failures stop after three connection attempts", async () => {
  const error = new Error("ECONNRESET");
  const connect = mock(async (): Promise<AppServerClient> => {
    throw error;
  });
  await expect(connectRemoteWorkerWithRetry(connect)).rejects.toBe(error);
  expect(connect).toHaveBeenCalledTimes(3);
});

test("abort interrupts the retry backoff", async () => {
  const controller = new AbortController();
  const connect = mock(async (): Promise<AppServerClient> => {
    setTimeout(() => controller.abort(), 10);
    throw new Error("App-server socket closed");
  });
  await expect(
    connectRemoteWorkerWithRetry(connect, controller.signal),
  ).rejects.toHaveProperty("name", "AbortError");
  expect(connect).toHaveBeenCalledTimes(1);
});

test("unrecognized failures are not retried", async () => {
  const error = new Error("Invalid configuration");
  const connect = mock(async (): Promise<AppServerClient> => {
    throw error;
  });
  await expect(connectRemoteWorkerWithRetry(connect)).rejects.toBe(error);
  expect(connect).toHaveBeenCalledTimes(1);
});
