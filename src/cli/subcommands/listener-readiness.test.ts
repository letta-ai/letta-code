import { expect, test } from "bun:test";
import {
  applyGatewayLifecycleReadiness,
  createListenerReadinessController,
} from "./listener-readiness";

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
