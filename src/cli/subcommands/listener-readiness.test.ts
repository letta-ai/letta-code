import { expect, test } from "bun:test";
import WebSocket from "ws";
import { openListenerConnection } from "@/websocket/listener/connection";
import { createRuntime, stopRuntime } from "@/websocket/listener/lifecycle";
import { setActiveRuntime } from "@/websocket/listener/runtime";
import {
  applyGatewayLifecycleReadiness,
  completeListenerConnectionStartup,
  createListenerReadinessController,
} from "./listener-readiness";

test("publishes readiness only for the exact open ingress-live connection", async () => {
  const runtime = createRuntime();
  setActiveRuntime(runtime);
  const readiness = createListenerReadinessController(
    false,
    () => {},
    () => {},
  );
  const writer = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send: () => {},
    removeAllListeners: () => {},
    close: () => {},
  } as never;
  const options = {
    connectionId: "same-id",
    wsUrl: "ws://test",
    deviceId: "device",
    connectionName: "connection",
    onConnected: () => {},
    onDisconnected: () => {},
    onError: () => {},
  };
  const original = openListenerConnection({
    runtime,
    connectionId: "same-id",
    writer,
    options,
  });
  original.initialized = true;
  expect(await completeListenerConnectionStartup(original, readiness)).toBe(
    false,
  );
  original.ingressReady = true;
  expect(await completeListenerConnectionStartup(original, readiness)).toBe(
    true,
  );

  runtime.connections.delete("same-id");
  const replacement = openListenerConnection({
    runtime,
    connectionId: "same-id",
    writer: {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send: () => {},
      removeAllListeners: () => {},
      close: () => {},
    } as never,
    options,
  });
  replacement.initialized = true;
  replacement.ingressReady = true;
  expect(await completeListenerConnectionStartup(original, readiness)).toBe(
    false,
  );
  (replacement.writer as { readyState: number }).readyState = WebSocket.CLOSED;
  expect(await completeListenerConnectionStartup(replacement, readiness)).toBe(
    false,
  );
  stopRuntime(runtime, true);
  setActiveRuntime(null);
});

test("gateway readiness cannot overwrite a Cloud disconnect", () => {
  const transitions: boolean[] = [];
  const readiness = createListenerReadinessController(
    true,
    (ready) => transitions.push(ready),
    () => {},
  );

  readiness.completeCloudStartup(readiness.captureCloudEpoch());
  readiness.setGatewayReady(true);
  expect(readiness.getState().ready).toBe(true);

  readiness.setCloudReconnecting();
  readiness.setGatewayReady(false);
  readiness.setGatewayReady(true);

  expect(readiness.getState()).toEqual({
    cloudReady: false,
    gatewayReady: true,
    ready: false,
  });
  expect(transitions).toEqual([true, false]);
});

test("Cloud readiness cannot overwrite a gateway restart", () => {
  const transitions: boolean[] = [];
  const readiness = createListenerReadinessController(
    true,
    (ready) => transitions.push(ready),
    () => {},
  );

  readiness.setGatewayReady(true);
  readiness.completeCloudStartup(readiness.captureCloudEpoch());
  expect(readiness.getState().ready).toBe(true);

  readiness.setGatewayReady(false);
  readiness.setCloudReconnecting();
  readiness.completeCloudStartup(readiness.captureCloudEpoch());

  expect(readiness.getState()).toEqual({
    cloudReady: true,
    gatewayReady: false,
    ready: false,
  });
  expect(transitions).toEqual([true, false]);
});

test("terminal gateway loss stays unhealthy across a later Cloud update until restart_ready", () => {
  const transitions: boolean[] = [];
  const readiness = createListenerReadinessController(
    true,
    (ready) => transitions.push(ready),
    () => {},
  );

  readiness.setGatewayReady(true);
  readiness.completeCloudStartup(readiness.captureCloudEpoch());
  expect(readiness.getState().ready).toBe(true);

  applyGatewayLifecycleReadiness(readiness, { kind: "exit" });
  applyGatewayLifecycleReadiness(readiness, { kind: "restart_exhausted" });
  readiness.setCloudReconnecting();
  readiness.completeCloudStartup(readiness.captureCloudEpoch());

  expect(readiness.getState()).toEqual({
    cloudReady: true,
    gatewayReady: false,
    ready: false,
  });
  expect(transitions).toEqual([true, false]);

  applyGatewayLifecycleReadiness(readiness, { kind: "restart_ready" });
  expect(readiness.getState().ready).toBe(true);
  expect(transitions).toEqual([true, false, true]);
});

test("initial gateway readiness composes with Cloud readiness", () => {
  const transitions: boolean[] = [];
  const readiness = createListenerReadinessController(
    true,
    (ready) => transitions.push(ready),
    () => {},
  );

  readiness.setGatewayReady(true);
  expect(transitions).toEqual([]);
  readiness.completeCloudStartup(readiness.captureCloudEpoch());

  expect(readiness.getState().ready).toBe(true);
  expect(transitions).toEqual([true]);
});
