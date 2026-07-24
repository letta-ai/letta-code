import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __listenerIdentityTestUtils,
  getSpawnerListenerInstanceId,
  isValidListenerInstanceId,
  LISTENER_INSTANCE_ID_ENV,
} from "./identity";

const originalEnv = process.env[LISTENER_INSTANCE_ID_ENV];

beforeEach(() => {
  __listenerIdentityTestUtils.resetCachedSpawnerIdentity();
  delete process.env[LISTENER_INSTANCE_ID_ENV];
});

afterEach(() => {
  __listenerIdentityTestUtils.resetCachedSpawnerIdentity();
  if (originalEnv === undefined) {
    delete process.env[LISTENER_INSTANCE_ID_ENV];
  } else {
    process.env[LISTENER_INSTANCE_ID_ENV] = originalEnv;
  }
});

describe("getSpawnerListenerInstanceId", () => {
  test("consumes and caches a valid spawner identity without leaving it inheritable", () => {
    process.env[LISTENER_INSTANCE_ID_ENV] = "desktop-primary:install-42";

    expect(getSpawnerListenerInstanceId()).toBe("desktop-primary:install-42");
    expect(process.env[LISTENER_INSTANCE_ID_ENV]).toBeUndefined();
    // Re-registration gets the process-owned cache after the transport env
    // variable is gone.
    expect(getSpawnerListenerInstanceId()).toBe("desktop-primary:install-42");
  });

  test("returns and caches null when unset (manual listeners keep legacy identity)", () => {
    expect(getSpawnerListenerInstanceId()).toBeNull();
    expect(getSpawnerListenerInstanceId()).toBeNull();
  });

  test("consumes invalid values instead of exposing them to descendants", () => {
    process.env[LISTENER_INSTANCE_ID_ENV] = "bad value with spaces!";

    expect(getSpawnerListenerInstanceId()).toBeNull();
    expect(process.env[LISTENER_INSTANCE_ID_ENV]).toBeUndefined();
    expect(getSpawnerListenerInstanceId()).toBeNull();
  });
});

describe("isValidListenerInstanceId", () => {
  test("accepts desktop-slot and legacy-derived shapes", () => {
    expect(isValidListenerInstanceId("desktop-primary:install-42")).toBe(true);
    expect(isValidListenerInstanceId("desktop-local-backend:1c2d3e4f")).toBe(
      true,
    );
    expect(isValidListenerInstanceId("server-0123456789abcdef")).toBe(true);
  });

  test("rejects empty, oversized, and unsafe values", () => {
    expect(isValidListenerInstanceId("")).toBe(false);
    expect(isValidListenerInstanceId("has spaces")).toBe(false);
    expect(isValidListenerInstanceId(`x${"a".repeat(200)}`)).toBe(false);
    expect(isValidListenerInstanceId("-leading-dash")).toBe(false);
  });
});
