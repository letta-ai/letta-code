import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireWhatsAppSessionLease,
  createWhatsAppSocket,
  getWhatsAppAuthDir,
  renderQrTerminal,
} from "@/channels/whatsapp/session";
import {
  clearWhatsAppConnectionState,
  getWhatsAppConnectionState,
  setWhatsAppConnectionState,
} from "@/channels/whatsapp/state";

function createSocketRuntimeHarness() {
  const handlers = new Map<
    string,
    (payload?: unknown) => void | Promise<void>
  >();
  const sock = {
    ev: {
      on(event: string, handler: (payload?: unknown) => void | Promise<void>) {
        handlers.set(event, handler);
      },
    },
    user: { id: "15551234567@s.whatsapp.net", lid: "15551234567@lid" },
    ws: { close() {} },
  };
  const runtime = {
    makeWASocket: () => sock,
    useMultiFileAuthState: async () => ({
      state: { creds: {}, keys: {} },
      saveCreds: async () => undefined,
    }),
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 0] }),
    DisconnectReason: { loggedOut: 401 },
  };
  return { handlers, runtime };
}

describe("WhatsApp session", () => {
  test("renders qrcode-terminal with the module as this", () => {
    const qrMod = {
      error: "L",
      generate(
        this: { error?: string },
        input: string,
        options: unknown,
        cb?: (output: string) => void,
      ) {
        if (!this.error) {
          throw new Error("missing this binding");
        }
        cb?.(`${input}:${this.error}:${JSON.stringify(options)}`);
      },
    };

    expect(renderQrTerminal(qrMod, "pairing-payload")).toBe(
      'pairing-payload:L:{"small":true}',
    );
  });

  test("falls back when qrcode-terminal rendering throws", () => {
    const qrMod = {
      generate() {
        throw new Error("boom");
      },
    };

    expect(renderQrTerminal(qrMod, "pairing-payload")).toBeUndefined();
  });

  test("preserves adapter-claimed terminal close state", async () => {
    const accountId = `session-claimed-close-${Date.now()}-${Math.random()}`;
    const { handlers, runtime } = createSocketRuntimeHarness();
    let result: Awaited<ReturnType<typeof createWhatsAppSocket>> | null = null;

    try {
      result = await createWhatsAppSocket({
        accountId,
        printQr: false,
        loadRuntimeModule: async () => runtime,
        onConnectionUpdate(update) {
          if (update.connection !== "close") return;
          setWhatsAppConnectionState(accountId, {
            status: "error",
            lastError: "terminal conflict wins",
          });
          return { claimedConnectionState: true };
        },
      });

      await handlers.get("connection.update")?.({
        connection: "close",
        lastDisconnect: { error: { message: "generic disconnected loser" } },
      });

      expect(getWhatsAppConnectionState(accountId)).toMatchObject({
        status: "error",
        lastError: "terminal conflict wins",
      });
    } finally {
      result?.release();
      clearWhatsAppConnectionState(accountId);
      rmSync(getWhatsAppAuthDir(accountId), { recursive: true, force: true });
    }
  });

  test("prevents concurrent session leases for the same account", () => {
    const root = join(
      tmpdir(),
      `letta-whatsapp-session-${Date.now()}-${Math.random()}`,
    );
    mkdirSync(root, { recursive: true });
    const lockDir = join(root, "lock");

    try {
      const lease = acquireWhatsAppSessionLease("test-account", { lockDir });
      expect(() =>
        acquireWhatsAppSessionLease("test-account", { lockDir }),
      ).toThrow(/already has an active session/);

      lease.release();
      const reacquired = acquireWhatsAppSessionLease("test-account", {
        lockDir,
      });
      reacquired.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("removes stale session leases", () => {
    const root = join(
      tmpdir(),
      `letta-whatsapp-session-stale-${Date.now()}-${Math.random()}`,
    );
    mkdirSync(root, { recursive: true });
    const lockDir = join(root, "lock");
    mkdirSync(lockDir);
    writeFileSync(
      join(lockDir, "owner.json"),
      JSON.stringify({ pid: 12345, command: "old server" }),
    );

    try {
      const lease = acquireWhatsAppSessionLease("stale-account", {
        lockDir,
        isProcessAlive: () => false,
      });
      lease.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
