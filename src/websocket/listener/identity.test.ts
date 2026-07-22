import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  getSpawnerListenerInstanceId,
  isValidListenerInstanceId,
  LISTENER_INSTANCE_ID_ENV,
} from "./identity";

const originalEnv = process.env[LISTENER_INSTANCE_ID_ENV];

beforeEach(() => {
  delete process.env[LISTENER_INSTANCE_ID_ENV];
});

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env[LISTENER_INSTANCE_ID_ENV];
  } else {
    process.env[LISTENER_INSTANCE_ID_ENV] = originalEnv;
  }
});

describe("getSpawnerListenerInstanceId", () => {
  test("returns the spawner-assigned identity when set and valid", () => {
    process.env[LISTENER_INSTANCE_ID_ENV] = "desktop-primary:install-42";
    expect(getSpawnerListenerInstanceId()).toBe("desktop-primary:install-42");
  });

  test("returns null when unset (manual listeners keep legacy identity)", () => {
    expect(getSpawnerListenerInstanceId()).toBeNull();
  });

  test("rejects invalid values instead of trusting a corrupted env var", () => {
    process.env[LISTENER_INSTANCE_ID_ENV] = "bad value with spaces!";
    expect(getSpawnerListenerInstanceId()).toBeNull();
    process.env[LISTENER_INSTANCE_ID_ENV] = "";
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
