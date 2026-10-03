import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { TestDirectory } from "@/test-utils/test-fs";
import {
  canonicalizeTeleportRecoveryServerUrl,
  createTeleportRecoveryStore,
  resolveTeleportRecoveryDirectory,
  type TeleportRecoveryRecord,
} from "./teleport-recovery-store";

function record(
  teleportId: string,
  recordedAt = Date.now(),
): TeleportRecoveryRecord {
  return {
    teleportId,
    agentId: "agent-1",
    conversationId: "conversation-1",
    sourceDeviceId: "device-1",
    sourceSessionId: "listen-original",
    disposition: "yielded",
    phase: "ready",
    readiness: {
      client_preferences: {},
      success: true,
      active_turn: false,
      mode: "standard",
    },
    recordedAt,
  };
}

test("server namespaces canonicalize URL spelling and remain under an override root", () => {
  expect(
    canonicalizeTeleportRecoveryServerUrl("HTTPS://EXAMPLE.COM:443/api/"),
  ).toBe("https://example.com/api");
  expect(
    resolveTeleportRecoveryDirectory(
      "/override",
      "HTTPS://EXAMPLE.COM:443/api/",
    ),
  ).toBe(
    resolveTeleportRecoveryDirectory("/override", "https://example.com/api"),
  );
  expect(
    resolveTeleportRecoveryDirectory("/override", "https://other.example/api"),
  ).not.toBe(
    resolveTeleportRecoveryDirectory("/override", "https://example.com/api"),
  );
  expect(
    resolveTeleportRecoveryDirectory("/override", "https://example.com/api"),
  ).toStartWith("/override/");
});

test("a readiness write flushes containing directory metadata", () => {
  const root = new TestDirectory();
  const directory = join(root.path, "ledger");
  mkdirSync(directory, { recursive: true });
  const synced: string[] = [];
  try {
    const store = createTeleportRecoveryStore(directory, {
      syncDirectory: (path) => synced.push(path),
    });
    store.write(record("teleport-sync"));
    expect(synced).toContain(directory);
    expect(store.read("teleport-sync")).toMatchObject({ phase: "ready" });
  } finally {
    root.cleanup();
  }
});

test("directory-sync failure is surfaced after rename and a later rewrite can establish durability", () => {
  const root = new TestDirectory();
  const directory = join(root.path, "ledger");
  mkdirSync(directory, { recursive: true });
  try {
    const faulting = createTeleportRecoveryStore(directory, {
      syncDirectory: (path) => {
        if (path === directory)
          throw new Error("simulated directory fsync fault");
      },
    });
    expect(() => faulting.write(record("teleport-fsync-fault"))).toThrow(
      "simulated directory fsync fault",
    );

    const recovered = createTeleportRecoveryStore(directory, {
      syncDirectory: () => {},
    });
    const visible = recovered.read("teleport-fsync-fault");
    if (!visible) throw new Error("renamed recovery record was not visible");
    recovered.write(visible);
    expect(recovered.read("teleport-fsync-fault")).toEqual(visible);
  } finally {
    root.cleanup();
  }
});

test("pruning retains future-dated proof and sweeps stale temporary files", () => {
  const root = new TestDirectory();
  const directory = join(root.path, "ledger");
  mkdirSync(directory, { recursive: true });
  const staleTemporary = join(directory, "interrupted-write.tmp");
  writeFileSync(staleTemporary, "partial");
  const staleAt = Date.now() - 2 * 60 * 60_000;
  utimesSync(staleTemporary, staleAt / 1000, staleAt / 1000);
  try {
    const store = createTeleportRecoveryStore(directory, {
      syncDirectory: () => {},
    });
    const future = record("teleport-future", Date.now() + 48 * 60 * 60_000);
    store.write(future);
    expect(store.read("teleport-future")).toEqual(future);
    expect(existsSync(staleTemporary)).toBe(false);
    expect(readdirSync(directory).some((name) => name.endsWith(".tmp"))).toBe(
      false,
    );
  } finally {
    root.cleanup();
  }
});

test("an implausible future timestamp cannot retain a stale file forever", () => {
  const root = new TestDirectory();
  const directory = join(root.path, "ledger");
  try {
    const store = createTeleportRecoveryStore(directory, {
      syncDirectory: () => {},
    });
    store.write(
      record("teleport-clock-corrupt", Date.now() + 365 * 86_400_000),
    );
    const [name] = readdirSync(directory).filter((entry) =>
      entry.endsWith(".json"),
    );
    if (!name) throw new Error("missing future-dated record");
    const staleAt = Date.now() - 25 * 60 * 60_000;
    utimesSync(join(directory, name), staleAt / 1000, staleAt / 1000);

    expect(store.read("teleport-clock-corrupt")).toBeNull();
  } finally {
    root.cleanup();
  }
});
