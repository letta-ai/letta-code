import { afterEach, expect, test } from "bun:test";
import { createRuntime } from "./lifecycle";
import {
  adoptListenerClientReplacement,
  createListenerClientReplacement,
} from "./listener-replacement";
import { setActiveRuntime } from "./runtime";
import { reserveStartupIngressOwner } from "./startup-ingress";
import type { StartListenerOptions } from "./types";

const options: StartListenerOptions = {
  connectionId: "conn-old",
  wsUrl: "local://test",
  deviceId: "device",
  connectionName: "test",
  onConnected() {},
  onDisconnected() {},
  onError() {},
};
afterEach(() => setActiveRuntime(null));

test("registration handoff preserves the runtime and consumes exact provenance once", () => {
  const runtime = createRuntime();
  setActiveRuntime(runtime);
  const replacement = createListenerClientReplacement(runtime, options);
  expect(() =>
    adoptListenerClientReplacement({
      ...options,
      replacement: { ...replacement },
    }),
  ).toThrow("unknown_provenance");
  expect(() =>
    adoptListenerClientReplacement({
      ...options,
      deviceId: "other",
      replacement,
    }),
  ).toThrow("identity_mismatch");
  expect(
    adoptListenerClientReplacement({
      ...options,
      connectionId: "conn-new",
      replacement,
    }),
  ).toBe(runtime);
  expect(() =>
    adoptListenerClientReplacement({ ...options, replacement }),
  ).toThrow("unknown_provenance");
});

test("late registration cannot replace a newer transport or unrelated runtime", () => {
  const runtime = createRuntime();
  setActiveRuntime(runtime);
  const replacement = createListenerClientReplacement(runtime, options);
  reserveStartupIngressOwner(runtime, options);
  expect(() =>
    adoptListenerClientReplacement({ ...options, replacement }),
  ).toThrow("stale_generation");
  const nextReplacement = createListenerClientReplacement(runtime, options);
  setActiveRuntime(createRuntime());
  expect(() =>
    adoptListenerClientReplacement({
      ...options,
      replacement: nextReplacement,
    }),
  ).toThrow("unauthoritative_issuer");
});
