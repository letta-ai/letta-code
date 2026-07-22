import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { settingsManager } from "@/settings-manager";
import {
  isValidListenerInstanceId,
  LISTENER_INSTANCE_ID_ENV,
  resolveListenerIdentity,
} from "./identity";

const originalEnv = process.env[LISTENER_INSTANCE_ID_ENV];
const originalGet = settingsManager.getListenerInstanceId;
const originalSet = settingsManager.setListenerInstanceId;

let persistedIds: Map<string, string>;

beforeEach(() => {
  delete process.env[LISTENER_INSTANCE_ID_ENV];
  persistedIds = new Map();
  settingsManager.getListenerInstanceId = mock((key: string) =>
    persistedIds.get(key),
  ) as typeof settingsManager.getListenerInstanceId;
  settingsManager.setListenerInstanceId = mock((key: string, id: string) => {
    persistedIds.set(key, id);
  }) as typeof settingsManager.setListenerInstanceId;
});

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env[LISTENER_INSTANCE_ID_ENV];
  } else {
    process.env[LISTENER_INSTANCE_ID_ENV] = originalEnv;
  }
  settingsManager.getListenerInstanceId = originalGet;
  settingsManager.setListenerInstanceId = originalSet;
});

describe("resolveListenerIdentity", () => {
  test("mints and persists a UUID identity on first run", () => {
    const identity = resolveListenerIdentity("MacBook-Pro-8.local");
    expect(identity.source).toBe("minted");
    expect(identity.listenerInstanceId).toMatch(/^li-/);
    expect(persistedIds.get("server:MacBook-Pro-8.local")).toBe(
      identity.listenerInstanceId,
    );
  });

  test("returns the persisted identity on subsequent runs (stable across restarts)", () => {
    const first = resolveListenerIdentity("Developers");
    const second = resolveListenerIdentity("Developers");
    expect(second.source).toBe("persisted");
    expect(second.listenerInstanceId).toBe(first.listenerInstanceId);
  });

  test("identity is NOT derived from the display name: same name in different namespaces differs", () => {
    const server = resolveListenerIdentity("shared-name", {
      namespace: "server",
    });
    const listen = resolveListenerIdentity("shared-name", {
      namespace: "listen",
    });
    expect(server.listenerInstanceId).not.toBe(listen.listenerInstanceId);
  });

  test("two different names get independent identities", () => {
    const a = resolveListenerIdentity("env-a");
    const b = resolveListenerIdentity("env-b");
    expect(a.listenerInstanceId).not.toBe(b.listenerInstanceId);
  });

  test("minting is random, not name-derived: same name would differ across fresh installs", () => {
    const first = resolveListenerIdentity("Developers");
    persistedIds.clear(); // simulate a different machine / fresh settings
    const second = resolveListenerIdentity("Developers");
    expect(second.source).toBe("minted");
    expect(second.listenerInstanceId).not.toBe(first.listenerInstanceId);
  });

  test("spawner-provided identity wins over persisted identity", () => {
    persistedIds.set("server:host", "li-persisted");
    process.env[LISTENER_INSTANCE_ID_ENV] = "desktop-primary:install-42";
    const identity = resolveListenerIdentity("host");
    expect(identity.source).toBe("spawner");
    expect(identity.listenerInstanceId).toBe("desktop-primary:install-42");
    // Spawner identities are never persisted into project settings.
    expect(persistedIds.get("server:host")).toBe("li-persisted");
  });

  test("an invalid spawner value falls through to persisted/minted identity", () => {
    process.env[LISTENER_INSTANCE_ID_ENV] = "bad value with spaces!";
    const identity = resolveListenerIdentity("host");
    expect(identity.source).toBe("minted");
  });
});

describe("isValidListenerInstanceId", () => {
  test("accepts minted, desktop-slot, and legacy-derived shapes", () => {
    expect(isValidListenerInstanceId("li-3f9a2b1c-aaaa-bbbb")).toBe(true);
    expect(isValidListenerInstanceId("desktop-primary:install-42")).toBe(true);
    expect(isValidListenerInstanceId("server-0123456789abcdef")).toBe(true);
  });

  test("rejects empty, oversized, and unsafe values", () => {
    expect(isValidListenerInstanceId("")).toBe(false);
    expect(isValidListenerInstanceId("has spaces")).toBe(false);
    expect(isValidListenerInstanceId(`x${"a".repeat(200)}`)).toBe(false);
    expect(isValidListenerInstanceId("-leading-dash")).toBe(false);
  });
});
